"use strict";
/*
 * Port of the matching code in red_detector.py: same features, background floor,
 * templates and sliding correlation. No DOM APIs here, so it also runs under Node.
 */

const RED = 6;
const RARITY_NAMES = { 1: "white", 2: "green", 3: "blue", 4: "purple", 5: "gold", 6: "red" };
const LEARN_HEADROOM = 0.07;   // learned threshold = highest score seen on non-merchant audio + this
const N_BANDS = 64;

// ---------------------------------------------------------------- features

/** Radix-2 FFT returning the power spectrum (n/2 + 1 bins) of a real signal. */
class PowerFFT {
  constructor(n) {
    this.n = n;
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(-2 * Math.PI * i / n);
      this.sin[i] = Math.sin(-2 * Math.PI * i / n);
    }
  }

  power(input, out) {
    const { n, re, im, rev } = this;
    for (let i = 0; i < n; i++) { re[rev[i]] = input[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step], s = this.sin[k * step];
          const a = start + k, b = a + half;
          const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let i = 0; i <= n / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
    return out;
  }
}

/** Streaming band-energy spectrogram. Same code is used for templates and live audio. */
class Featurizer {
  constructor(sr) {
    const FMIN = 150, FMAX = 16000;
    this.sr = sr;
    this.hop = Math.round(sr * 0.010);
    this.nFft = sr > 32000 ? 2048 : 1024;
    this.window = new Float32Array(this.nFft);
    for (let i = 0; i < this.nFft; i++) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.nFft - 1));
    const nBins = this.nFft / 2 + 1;
    const top = Math.min(FMAX, sr / 2 - 1);
    const idx = [];
    for (let e = 0; e <= N_BANDS; e++) {
      const edge = FMIN * Math.pow(top / FMIN, e / N_BANDS);
      let k = Math.ceil(edge * this.nFft / sr);   // first bin with freq >= edge
      if (k * sr / this.nFft < edge) k++;
      idx.push(Math.min(Math.max(k, 1), nBins - 1));
    }
    this.lo = new Uint32Array(N_BANDS);
    this.hi = new Uint32Array(N_BANDS);
    for (let b = 0; b < N_BANDS; b++) {
      this.lo[b] = idx[b];
      this.hi[b] = Math.max(idx[b + 1], idx[b] + 1);
    }
    this.fft = new PowerFFT(this.nFft);
    this.spec = new Float64Array(nBins);
    this.frame = new Float32Array(this.nFft);
    this.buf = new Float32Array(this.nFft);
    this.pending = new Float32Array(0);
  }

  /** Feed mono float samples, returns an array of Float32Array(N_BANDS) linear band energies. */
  push(samples) {
    const all = new Float32Array(this.pending.length + samples.length);
    all.set(this.pending);
    all.set(samples, this.pending.length);
    const { hop, nFft, buf, frame, window, spec } = this;
    const frames = [];
    let off = 0;
    while (all.length - off >= hop) {
      buf.copyWithin(0, hop);
      buf.set(all.subarray(off, off + hop), nFft - hop);
      off += hop;
      for (let i = 0; i < nFft; i++) frame[i] = buf[i] * window[i];
      this.fft.power(frame, spec);
      const bands = new Float32Array(N_BANDS);
      for (let b = 0; b < N_BANDS; b++) {
        let s = 0;
        for (let k = this.lo[b]; k < this.hi[b]; k++) s += spec[k];
        bands[b] = s / (this.hi[b] - this.lo[b]);
      }
      frames.push(bands);
    }
    this.pending = all.slice(off);
    return frames;
  }
}

/** Zero-mean / unit-norm, so a dot product of two patches is their Pearson correlation. */
function normalizePatch(p) {
  let mean = 0;
  for (let i = 0; i < p.length; i++) mean += p[i];
  mean /= p.length;
  const out = new Float32Array(p.length);
  let norm = 0;
  for (let i = 0; i < p.length; i++) { out[i] = p[i] - mean; norm += out[i] * out[i]; }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < p.length; i++) out[i] /= norm;
  return out;
}

/**
 * Per-band noise floor (follows drops quickly, rises slowly); outputs energy well above it.
 * Values are square-rooted so the loud parts of a sound dominate the match without
 * one peak swamping everything else.
 */
class Background {
  constructor() { this.floor = null; }

  push(frames) {
    const UP = 0.01, DOWN = 0.3, MARGIN = 3.0;
    return frames.map(e => {
      if (this.floor === null) this.floor = Float64Array.from(e);
      const out = new Float32Array(N_BANDS);
      for (let b = 0; b < N_BANDS; b++) {
        const rate = e[b] > this.floor[b] ? UP : DOWN;
        this.floor[b] += rate * (e[b] - this.floor[b]);
        out[b] = Math.sqrt(Math.max(e[b] - MARGIN * this.floor[b], 0));
      }
      return out;
    });
  }
}

class Template {
  /** `audio` is the sound as mono Float32Array samples at rate `sr`. */
  constructor(sound, audio, sr) {
    this.id = sound.id;
    this.name = sound.file.replace(/\.[^.]+$/, "");
    this.items = sound.items;
    this.redItems = this.items.filter(i => i.rarity === RED).map(i => i.name);
    this.redRatio = this.redItems.length / Math.max(1, this.items.length);
    const padded = new Float32Array(audio.length + 2 * 4096);
    padded.set(audio, 4096);
    const feats = new Featurizer(sr).push(padded).map(f => f.map(Math.sqrt));
    const energy = feats.map(f => f.reduce((a, b) => a + b, 0));
    const limit = Math.max(...energy) * Math.pow(10, -30 / 20);
    const loud = [];
    energy.forEach((e, i) => { if (e > limit) loud.push(i); });
    // Start a few frames before the onset so the attack is part of the match;
    // long tails add little, so cap the matched length at ~0.6 s.
    const start = Math.max(loud[0] - 3, 0);
    const end = Math.min(loud[loud.length - 1] + 1, loud[0] + 60);
    this.length = end - start;
    const flat = new Float32Array(this.length * N_BANDS);
    for (let i = start; i < end; i++) flat.set(feats[i], (i - start) * N_BANDS);
    this.vec = normalizePatch(flat);
    this.vecSum = this.vec.reduce((a, b) => a + b, 0);
  }
}

// ---------------------------------------------------------------- matcher

/** Sliding normalized correlation of every template against the live spectrogram. */
class Matcher {
  /** `perSound` maps sound name -> threshold; generic rustles need a higher score than distinctive sounds. */
  constructor(templates, threshold, perSound = {}, margin = 0.05) {
    this.templates = templates;
    this.th = templates.map(t => Math.max(threshold, perSound[t.name] || 0));
    this.margin = margin;
    this.maxLen = Math.max(...templates.map(t => t.length));
    this.hist = new Float32Array(this.maxLen * N_BANDS);
    this.bg = new Background();
    this.candidate = null;          // {peaks: per-template peak score, frames: frames since}
    this.quietUntil = 0;            // refractory frames after a detection
    this.lastScores = new Float64Array(templates.length);
    this.rejected = [];             // {best, bestScore, second, secondScore} of too-close calls
  }

  scores() {
    const MIN_LEVEL = Math.pow(10, -80 / 20);   // ignore near-silence (sqrt-energy units)
    const out = new Float64Array(this.templates.length);
    const h = this.hist;
    this.templates.forEach((t, i) => {
      const n = t.length * N_BANDS, start = h.length - n, v = t.vec;
      let max = 0, sum = 0, sumSq = 0, dot = 0;
      for (let j = 0; j < n; j++) {
        const w = h[start + j];
        if (w > max) max = w;
        sum += w; sumSq += w * w; dot += v[j] * w;
      }
      if (max < MIN_LEVEL) return;
      const mean = sum / n, varSum = sumSq - n * mean * mean;
      if (varSum > 0) out[i] = (dot - mean * t.vecSum) / Math.sqrt(varSum);
    });
    return out;
  }

  /** Feed band energies from Featurizer. Returns a list of {template, score} detections. */
  push(frames) {
    const hits = [];
    for (const fr of this.bg.push(frames)) {
      this.hist.copyWithin(0, N_BANDS);
      this.hist.set(fr, this.hist.length - N_BANDS);
      if (this.quietUntil > 0) {
        this.quietUntil--;
        continue;
      }
      const s = this.scores();
      this.lastScores = s;
      if (this.candidate === null && s.some((v, i) => v >= this.th[i])) {
        // Something matched: collect every template's peak over the next window, since
        // long templates only reach their peak once the whole sound has played.
        this.candidate = { peaks: Float64Array.from(s), frames: 0 };
      } else if (this.candidate !== null) {
        const peaks = this.candidate.peaks;
        for (let i = 0; i < s.length; i++) if (s[i] > peaks[i]) peaks[i] = s[i];
        if (++this.candidate.frames >= this.maxLen) {
          this.candidate = null;
          const [best, second] = topIndices(peaks, 2);
          // Require a clear winner: many pickup sounds are similar short rustles.
          if (peaks[best] >= this.th[best] && peaks[best] - peaks[second] >= this.margin) {
            hits.push({ template: this.templates[best], score: peaks[best] });
          } else {
            this.rejected.push({ best: this.templates[best], bestScore: peaks[best],
                                 second: this.templates[second], secondScore: peaks[second] });
          }
          // Let the tail of this sound pass so it can't match other templates.
          this.quietUntil = 30;
        }
      }
    }
    return hits;
  }
}

function topIndices(values, k) {
  return Array.from(values.keys()).sort((a, b) => values[b] - values[a]).slice(0, k);
}

/**
 * Raise each sound's threshold above the best score it reached on audio without merchant sounds.
 * Returns the updated thresholds and a list of [name, old, new] changes.
 */
function learnThresholds(templates, maxScores, learned, floor) {
  learned = { ...learned };
  const changed = [];
  templates.forEach((t, i) => {
    const next = Math.round(Math.min(maxScores[i] + LEARN_HEADROOM, 0.95) * 100) / 100;
    if (next > Math.max(learned[t.name] || 0, floor)) {
      changed.push([t.name, learned[t.name] || floor, next]);
      learned[t.name] = next;
    }
  });
  return { learned, changed };
}

function describe(t, score) {
  const reds = t.redItems.slice(0, 4).join(", ") + (t.redItems.length > 4 ? "..." : "");
  if (t.redRatio === 1) {
    return { title: "RED ITEM DETECTED", sub: `${reds}   (match ${score.toFixed(2)})`, color: "#ff2a2a" };
  }
  const pct = Math.round(100 * t.redRatio);
  return { title: "RED ITEM DETECTED (possible)",
           sub: `${pct}% of items with this sound are red: ${reds}   (match ${score.toFixed(2)})`,
           color: "#ff7a2a" };
}

if (typeof module !== "undefined") {
  module.exports = { RED, RARITY_NAMES, Featurizer, Background, Template, Matcher,
                     normalizePatch, learnThresholds, describe };
}
