"""Offline accuracy check: mixes each merchant sound into noise and runs the matcher on it."""
import sys

import numpy as np
from scipy.signal import resample_poly

import red_detector as rd

SR = 48000
rng = np.random.default_rng(1)
templates = rd.load_templates(SR)
threshold = float(sys.argv[1]) if len(sys.argv) > 1 else 0.65


def noise(n, level):
    # Brown-ish background rumble plus random clicks, roughly like ambient game audio.
    w = np.cumsum(rng.standard_normal(n)).astype(np.float32)
    w -= np.convolve(w, np.ones(400) / 400, mode="same")
    w /= np.sqrt(np.mean(w ** 2))
    for k in rng.integers(0, n - 2000, n // SR * 3):
        w[k:k + 2000] += rng.standard_normal(2000) * np.hanning(2000) * 3
    return level * w


def unit_rms(x):
    active = x[np.abs(x) > 0.05 * np.abs(x).max()]
    return x / np.sqrt(np.mean(active ** 2))


def run(signal):
    feat, m = rd.Featurizer(SR), rd.Matcher(templates, threshold, per_sound=rd.load_thresholds())
    hits = []
    for i in range(0, len(signal), 960):
        hits += m.push(feat.push(signal[i:i + 960]))
    return hits


def variant(x, pitch, echo):
    if pitch:
        x = resample_poly(x, 100, 100 + pitch).astype(np.float32)
    if echo:
        d = int(0.06 * SR)
        x = np.concatenate([x, np.zeros(d, np.float32)])
        x[d:] += 0.35 * x[:-d]
    return x


# (label, sound level vs background in dB, pitch shift %, echo)
cases = [("SNR 30 dB", 30, 0, False), ("SNR 20 dB", 20, 0, False), ("SNR 12 dB", 12, 0, False),
         ("pitch +3%", 20, 3, False), ("pitch -3%", 20, -3, False), ("echo", 20, 0, True)]
for label, snr, pitch, echo in cases:
    ok = wrong = miss = 0
    for t in templates:
        clip = 0.2 * unit_rms(variant(rd.load_mono(f"{rd.SOUND_DIR}/{t.name}.ogg", SR), pitch, echo))
        sig = noise(SR * 2 + len(clip), 0.2 * 10 ** (-snr / 20))
        sig[SR:SR + len(clip)] += clip
        hits = run(sig)
        ids = [h[0].id for h in hits]
        if t.id in ids and len(set(ids)) == 1:
            ok += 1
        elif t.id in ids:
            ok += 1
            wrong += len(set(ids)) - 1
        elif ids:
            wrong += 1
        else:
            miss += 1
    print(f"{label:12s}  correct {ok}/{len(templates)}  extra/wrong {wrong}  missed {miss}")

fp = run(noise(SR * 60, 0.2))
print(f"60 s of loud noise only: {len(fp)} false detections")
