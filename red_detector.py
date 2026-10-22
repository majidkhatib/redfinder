"""
ABI merchant red-item sound detector.

Listens to whatever Windows is playing (WASAPI loopback of the default output
device), matches it against the 38 merchant pickup sounds from
abibuilder.com/merchant, and shows an on-screen overlay when a sound that
belongs to a red (rarity 6) item is heard.

Usage:
    python red_detector.py                # run the detector
    python red_detector.py --calibrate    # print live match scores, no overlay
    python red_detector.py --all          # alert on every merchant sound, not only red ones
    python red_detector.py --learn 300    # listen to 5 min of normal game audio (no merchant)
                                          # and raise thresholds of sounds that false-trigger
"""
import argparse
import ctypes
import json
import os
import queue
import signal
import sys
import threading
import time
import tkinter as tk
import winsound

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

HERE = os.path.dirname(os.path.abspath(__file__))
SOUND_DIR = os.path.join(HERE, "sounds")
THRESHOLDS_FILE = os.path.join(HERE, "thresholds.json")
LEARN_HEADROOM = 0.07   # learned threshold = highest score seen on non-merchant audio + this
RED = 6
RARITY_NAMES = {1: "white", 2: "green", 3: "blue", 4: "purple", 5: "gold", 6: "red"}

# ---------------------------------------------------------------- features

class Featurizer:
    """Streaming band-energy spectrogram. Same code is used for templates and live audio."""

    N_BANDS = 64
    FMIN, FMAX = 150.0, 16000.0
    HOP_S = 0.010

    def __init__(self, sr):
        self.sr = sr
        self.hop = int(round(sr * self.HOP_S))
        self.n_fft = 2048 if sr > 32000 else 1024
        self.window = np.hanning(self.n_fft).astype(np.float32)
        freqs = np.fft.rfftfreq(self.n_fft, 1.0 / sr)
        edges = np.geomspace(self.FMIN, min(self.FMAX, sr / 2 - 1), self.N_BANDS + 1)
        idx = np.clip(np.searchsorted(freqs, edges), 1, len(freqs) - 1)
        self.fb = np.zeros((self.N_BANDS, len(freqs)), np.float32)
        for b in range(self.N_BANDS):
            lo, hi = idx[b], max(idx[b + 1], idx[b] + 1)
            self.fb[b, lo:hi] = 1.0 / (hi - lo)
        self.buf = np.zeros(self.n_fft, np.float32)
        self.pending = np.zeros(0, np.float32)

    def push(self, samples):
        """Feed mono float32 samples, returns array (n_frames, N_BANDS) of linear band energies."""
        self.pending = np.concatenate([self.pending, samples.astype(np.float32)])
        frames = []
        while len(self.pending) >= self.hop:
            chunk, self.pending = self.pending[:self.hop], self.pending[self.hop:]
            self.buf = np.concatenate([self.buf[self.hop:], chunk])
            spec = np.abs(np.fft.rfft(self.buf * self.window)) ** 2
            frames.append(self.fb @ spec)
        if not frames:
            return np.zeros((0, self.N_BANDS), np.float32)
        return np.asarray(frames, np.float32)


def load_mono(path, sr):
    data, file_sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if file_sr != sr:
        g = np.gcd(int(file_sr), int(sr))
        mono = resample_poly(mono, sr // g, file_sr // g).astype(np.float32)
    return mono


def normalize_patch(p):
    """Zero-mean / unit-norm, so a dot product of two patches is their Pearson correlation."""
    p = p - p.mean()
    n = np.linalg.norm(p)
    return p / n if n > 0 else p


class Background:
    """Per-band noise floor (follows drops quickly, rises slowly); outputs energy well above it.

    Values are square-rooted so the loud parts of a sound dominate the match without
    one peak swamping everything else.
    """

    UP, DOWN, MARGIN = 0.01, 0.3, 3.0

    def __init__(self):
        self.floor = None

    def push(self, frames):
        out = np.empty_like(frames)
        for i, e in enumerate(frames):
            if self.floor is None:
                self.floor = e.copy()
            rate = np.where(e > self.floor, self.UP, self.DOWN)
            self.floor += rate * (e - self.floor)
            out[i] = np.sqrt(np.maximum(e - self.MARGIN * self.floor, 0.0))
        return out


class Template:
    def __init__(self, sound, sr):
        self.id = sound["id"]
        self.name = sound["file"].rsplit(".", 1)[0]
        self.items = sound["items"]
        self.red_items = [i["name"] for i in self.items if i["rarity"] == RED]
        self.red_ratio = len(self.red_items) / max(1, len(self.items))
        audio = load_mono(os.path.join(SOUND_DIR, sound["file"]), sr)
        feats = np.sqrt(Featurizer(sr).push(np.concatenate([np.zeros(4096, np.float32), audio,
                                                            np.zeros(4096, np.float32)])))
        energy = feats.sum(axis=1)
        loud = np.where(energy > energy.max() * 10 ** (-30 / 20))[0]
        # Start a few frames before the onset so the attack is part of the match;
        # long tails add little, so cap the matched length at ~0.6 s.
        start, end = max(loud[0] - 3, 0), min(loud[-1] + 1, loud[0] + 60)
        self.length = end - start
        self.vec = normalize_patch(feats[start:end]).ravel()


def load_templates(sr):
    with open(os.path.join(HERE, "sound_items.json"), encoding="utf8") as f:
        sounds = json.load(f)
    return [Template(s, sr) for s in sounds]


def load_thresholds():
    """Per-sound thresholds; generic rustles need a higher score than distinctive sounds."""
    try:
        with open(THRESHOLDS_FILE, encoding="utf8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_learned_thresholds(templates, max_scores, floor):
    """Raise each sound's threshold above the best score it reached on audio without merchant sounds."""
    learned = load_thresholds()
    changed = []
    for t, m in zip(templates, max_scores):
        new = round(min(float(m) + LEARN_HEADROOM, 0.95), 2)
        if new > max(learned.get(t.name, 0.0), floor):
            changed.append((t.name, learned.get(t.name, floor), new))
            learned[t.name] = new
    with open(THRESHOLDS_FILE, "w", encoding="utf8") as f:
        json.dump(dict(sorted(learned.items())), f, indent=1)
    return changed

# ---------------------------------------------------------------- matcher

class Matcher:
    """Sliding normalized correlation of every template against the live spectrogram."""

    MIN_LEVEL = 10 ** (-80 / 20)   # ignore near-silence (sqrt-energy units)

    def __init__(self, templates, threshold, margin=0.05, per_sound=None):
        self.templates = templates
        per_sound = per_sound or {}
        self.th = np.array([max(threshold, per_sound.get(t.name, 0.0)) for t in templates])
        self.margin = margin
        self.max_len = max(t.length for t in templates)
        self.hist = np.zeros((self.max_len, Featurizer.N_BANDS), np.float32)
        self.bg = Background()
        self.candidate = None          # [peak score per template, frames_since]
        self.quiet_until = 0           # refractory frames after a detection
        self.last_scores = np.zeros(len(templates))
        self.rejected = []             # (best, score, runner-up, score) of too-close calls

    def scores(self):
        out = np.zeros(len(self.templates))
        for i, t in enumerate(self.templates):
            win = self.hist[-t.length:]
            if win.max() < self.MIN_LEVEL:
                continue
            out[i] = float(t.vec @ normalize_patch(win).ravel())
        return out

    def push(self, frames):
        """Feed band energies from Featurizer. Returns list of (template, score) detections."""
        hits = []
        for fr in self.bg.push(frames):
            self.hist = np.vstack([self.hist[1:], fr[None, :]])
            if self.quiet_until > 0:
                self.quiet_until -= 1
                continue
            s = self.scores()
            self.last_scores = s
            if self.candidate is None and (s >= self.th).any():
                # Something matched: collect every template's peak over the next window, since
                # long templates only reach their peak once the whole sound has played.
                self.candidate = [s.copy(), 0]
            elif self.candidate is not None:
                np.maximum(self.candidate[0], s, out=self.candidate[0])
                self.candidate[1] += 1
                if self.candidate[1] >= self.max_len:
                    peaks = self.candidate[0]
                    self.candidate = None
                    order = np.argsort(peaks)
                    best, second = order[-1], order[-2]
                    # Require a clear winner: many pickup sounds are similar short rustles.
                    if peaks[best] >= self.th[best] and peaks[best] - peaks[second] >= self.margin:
                        hits.append((self.templates[best], float(peaks[best])))
                    else:
                        self.rejected.append((self.templates[best], float(peaks[best]),
                                              self.templates[second], float(peaks[second])))
                    # Let the tail of this sound pass so it can't match other templates.
                    self.quiet_until = 30
        return hits

# ---------------------------------------------------------------- audio capture

def open_loopback():
    import pyaudiowpatch as pyaudio
    pa = pyaudio.PyAudio()
    wasapi = pa.get_host_api_info_by_type(pyaudio.paWASAPI)
    speakers = pa.get_device_info_by_index(wasapi["defaultOutputDevice"])
    if not speakers.get("isLoopbackDevice"):
        for lb in pa.get_loopback_device_info_generator():
            if speakers["name"] in lb["name"]:
                speakers = lb
                break
        else:
            raise RuntimeError("No WASAPI loopback device found for " + speakers["name"])
    return pa, speakers


def play_silence(pa):
    """WASAPI loopback delivers no data while nothing is playing, which would squash the gaps
    between sounds. Playing digital silence on the default output keeps the stream flowing."""
    import pyaudiowpatch as pyaudio
    out = pa.get_default_output_device_info()
    sr, ch = int(out["defaultSampleRate"]), max(1, min(2, int(out["maxOutputChannels"])))
    zeros = bytes(4 * ch * 1024)
    return pa.open(format=pyaudio.paFloat32, channels=ch, rate=sr, output=True,
                   output_device_index=out["index"], frames_per_buffer=1024,
                   stream_callback=lambda *_: (zeros, pyaudio.paContinue))


def audio_thread(events, args, stop):
    import pyaudiowpatch as pyaudio
    pa, dev = open_loopback()
    sr = int(dev["defaultSampleRate"])
    ch = int(dev["maxInputChannels"])
    print(f"Listening on: {dev['name']}  ({sr} Hz, {ch} ch)")
    templates = load_templates(sr)
    print(f"Loaded {len(templates)} merchant sounds "
          f"({sum(1 for t in templates if t.red_items)} can be red items)")
    feat = Featurizer(sr)
    if args.learn:
        # Never trigger; just record how high every template scores on this audio.
        matcher = Matcher(templates, np.inf)
        max_scores = np.zeros(len(templates))
        learn_end = time.time() + args.learn
        print(f"Learning for {args.learn} s. Play normally, but stay away from the merchant...")
    else:
        matcher = Matcher(templates, args.threshold, per_sound=load_thresholds())
    stream = pa.open(format=pyaudio.paFloat32, channels=ch, rate=sr, input=True,
                     input_device_index=dev["index"], frames_per_buffer=int(sr * 0.02))
    keepalive = play_silence(pa)
    last_print = 0
    try:
        while not stop.is_set():
            raw = stream.read(int(sr * 0.02), exception_on_overflow=False)
            mono = np.frombuffer(raw, np.float32).reshape(-1, ch).mean(axis=1)
            for t, score in matcher.push(feat.push(mono)):
                events.put((t, score))
            if args.learn:
                np.maximum(max_scores, matcher.last_scores, out=max_scores)
                if time.time() >= learn_end:
                    changed = save_learned_thresholds(templates, max_scores, args.threshold)
                    print(f"Done. Raised {len(changed)} thresholds (saved to thresholds.json):")
                    for name, old, new in changed:
                        print(f"  {name:32s} {old:.2f} -> {new:.2f}")
                    break
            while matcher.rejected:
                b, bs, r, rs = matcher.rejected.pop(0)
                print(f"\n[{time.strftime('%H:%M:%S')}] too close to call: "
                      f"{b.name} {bs:.2f} vs {r.name} {rs:.2f}")
            if args.calibrate and time.time() - last_print > 0.25:
                last_print = time.time()
                s = matcher.last_scores
                top = np.argsort(s)[::-1][:3]
                print("  ".join(f"{templates[i].name[:28]:28s} {s[i]:.2f}" for i in top), end="\r")
    finally:
        stream.stop_stream()
        stream.close()
        keepalive.stop_stream()
        keepalive.close()
        pa.terminate()

# ---------------------------------------------------------------- overlay

class Overlay:
    """Transparent, always-on-top, click-through text at the top of the screen."""

    KEY = "#010101"

    def __init__(self, root):
        self.root = root
        root.overrideredirect(True)
        root.attributes("-topmost", True)
        root.configure(bg=self.KEY)
        root.attributes("-transparentcolor", self.KEY)
        w = root.winfo_screenwidth()
        root.geometry(f"{w}x170+0+60")
        self.title = tk.Label(root, text="", font=("Segoe UI", 40, "bold"), fg="#ff2a2a", bg=self.KEY)
        self.title.pack()
        self.sub = tk.Label(root, text="", font=("Segoe UI", 15, "bold"), fg="#ffd0d0", bg=self.KEY)
        self.sub.pack()
        root.update_idletasks()
        self._click_through()
        self.hide_at = 0

    def _click_through(self):
        hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id())
        GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_TRANSPARENT, WS_EX_TOOLWINDOW = -20, 0x80000, 0x20, 0x80
        style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        ctypes.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE,
                                            style | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW)

    def show(self, title, sub, color, seconds=4.0):
        self.title.config(text=title, fg=color)
        self.sub.config(text=sub)
        self.root.attributes("-topmost", True)
        self.root.lift()
        self.hide_at = time.time() + seconds

    def tick(self):
        if self.hide_at and time.time() > self.hide_at:
            self.title.config(text="")
            self.sub.config(text="")
            self.hide_at = 0


def describe(t, score):
    reds = ", ".join(t.red_items[:4]) + ("..." if len(t.red_items) > 4 else "")
    if t.red_ratio == 1.0:
        return "RED ITEM DETECTED", f"{reds}   (match {score:.2f})", "#ff2a2a"
    pct = round(100 * t.red_ratio)
    return ("RED ITEM DETECTED (possible)",
            f"{pct}% of items with this sound are red: {reds}   (match {score:.2f})", "#ff7a2a")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--threshold", type=float, default=0.65, help="match score needed (0-1), default 0.65")
    ap.add_argument("--calibrate", action="store_true", help="print live top matches instead of showing overlay")
    ap.add_argument("--all", action="store_true", help="show every detected merchant sound, not only red ones")
    ap.add_argument("--no-beep", action="store_true", help="don't beep on red detection")
    ap.add_argument("--learn", type=int, metavar="SECONDS", default=0,
                    help="record SECONDS of game audio without merchant sounds and raise per-sound "
                         "thresholds so that audio no longer triggers anything")
    args = ap.parse_args()

    if args.learn:
        audio_thread(queue.Queue(), args, threading.Event())
        return

    events, stop = queue.Queue(), threading.Event()
    th = threading.Thread(target=audio_thread, args=(events, args, stop), daemon=True)
    th.start()

    root = tk.Tk()
    overlay = Overlay(root)

    def poll():
        if not th.is_alive() and events.empty():
            root.destroy()
            return
        while not events.empty():
            t, score = events.get()
            stamp = time.strftime("%H:%M:%S")
            rarities = sorted({RARITY_NAMES[i["rarity"]] for i in t.items})
            if t.red_items:
                title, sub, color = describe(t, score)
                print(f"\n[{stamp}] {title}: {t.name}  score={score:.2f}  red: {', '.join(t.red_items)}")
                overlay.show(title, sub, color)
                if not args.no_beep:
                    winsound.Beep(1200, 150)
            elif args.all:
                print(f"\n[{stamp}] merchant sound {t.name}  score={score:.2f}  ({'/'.join(rarities)})")
                overlay.show("merchant sound", f"{t.name}  ({'/'.join(rarities)})", "#b0b0ff", 2.0)
        overlay.tick()
        root.after(50, poll)

    root.after(50, poll)
    # The poll loop above gives Python a chance to run this handler while Tk is in mainloop.
    signal.signal(signal.SIGINT, lambda *_: root.quit())
    print("Running. Press Ctrl+C in this window to quit.")
    try:
        root.mainloop()
    finally:
        stop.set()


if __name__ == "__main__":
    main()
