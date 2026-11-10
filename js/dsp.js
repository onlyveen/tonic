// Signal processing: FFT, spectral peak picking, and the running key engine.
// Pure functions + one class, no DOM — shared by the mic and file paths (and by Node tests).

export class FFT {
  constructor(n) {
    if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.n = n;
    const bits = Math.log2(n);
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.win = new Float64Array(n); // Hann
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  /** Windowed magnitude spectrum of input[offset .. offset+n) into out (length n/2). */
  magnitudes(input, offset, out, maxBin = this.n / 2) {
    const { n, re, im, rev, win, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      const idx = offset + i;
      re[j] = (idx < input.length ? input[idx] : 0) * win[i];
      im[j] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = cos[k], s = sin[k];
          const tre = re[l] * c + im[l] * s;
          const tim = im[l] * c - re[l] * s;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
    const lim = Math.min(maxBin, n / 2);
    for (let i = 0; i < lim; i++) out[i] = Math.hypot(re[i], im[i]);
    return out;
  }
}

export const ANALYSIS = { fMin: 58, fMax: 1800, maxPeaks: 48, floorRatio: 0.01 };

/**
 * Pick tonal peaks from a linear magnitude spectrum.
 * Returns { peaks: [{f, amp, w}], max } or null when there is nothing tonal.
 * Harmonics that sit on a 3rd/5th/6th/7th partial of a stronger, lower peak are
 * down-weighted so a C note's overtones (G, E, B♭) don't masquerade as chord tones.
 */
export function findPeaks(mag, binHz, opts = ANALYSIS) {
  const { fMin, fMax, maxPeaks, floorRatio } = { ...ANALYSIS, ...opts };
  const iMin = Math.max(2, Math.floor(fMin / binHz));
  const iMax = Math.min(mag.length - 2, Math.ceil(fMax / binHz));
  let max = 0;
  for (let i = iMin; i <= iMax; i++) if (mag[i] > max) max = mag[i];
  if (!(max > 0)) return null;
  const floor = max * floorRatio;

  let peaks = [];
  for (let i = iMin; i <= iMax; i++) {
    const m = mag[i];
    if (m > floor && m > mag[i - 1] && m >= mag[i + 1]) {
      const a = Math.log(mag[i - 1] + 1e-12), b = Math.log(m + 1e-12), c = Math.log(mag[i + 1] + 1e-12);
      const d = a - 2 * b + c;
      const p = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
      peaks.push({ f: (i + p) * binHz, amp: Math.exp(b - 0.25 * (a - c) * p), w: 1 });
    }
  }
  if (!peaks.length) return null;
  peaks.sort((x, y) => y.amp - x.amp);
  if (peaks.length > maxPeaks) peaks.length = maxPeaks;

  peaks.sort((x, y) => x.f - y.f);
  for (let j = 0; j < peaks.length; j++) {
    const p = peaks[j];
    for (const k of [3, 5, 6, 7]) {
      const target = p.f / k;
      if (target < fMin * 0.9) break;
      let hit = false;
      for (let q = 0; q < j; q++) {
        const r = peaks[q].f / target;
        if (r > 0.975 && r < 1.025 && peaks[q].amp > p.amp * 0.3) { hit = true; break; }
      }
      if (hit) { p.w *= 0.45; break; }
    }
  }
  return { peaks, max };
}

const TWO_PI = Math.PI * 2;
const BASS_MAX_HZ = 130;
const midiOf = (f) => 69 + 12 * Math.log2(f / 440);

/**
 * Accumulates a 12-bin pitch-class profile (chroma) and a tuning estimate.
 * halfLife (seconds) makes old material fade, so live listening follows a new song.
 */
export class KeyEngine {
  constructor({ halfLife = Infinity } = {}) {
    this.halfLife = halfLife;
    this.fixedTuning = null;
    this.reset();
  }

  reset() {
    this.chroma = new Float64Array(12);
    this.bass = new Float64Array(12);
    this.recent = new Float64Array(12);
    this.bassSeconds = 0;
    this.seconds = 0;
    this.tx = 0; this.ty = 0; this.tw = 0;
  }

  /** Tuning offset in cents relative to A4 = 440 Hz. */
  get tuningCents() {
    if (this.fixedTuning !== null) return this.fixedTuning;
    if (this.tw < 4) return 0;
    return (Math.atan2(this.ty, this.tx) / TWO_PI) * 100;
  }

  add(found, dt) {
    if (!found) return;
    const { peaks, max } = found;
    if (Number.isFinite(this.halfLife)) {
      const k = Math.pow(0.5, dt / this.halfLife);
      for (let i = 0; i < 12; i++) { this.chroma[i] *= k; this.bass[i] *= k; }
      this.bassSeconds *= k;
      this.tx *= k; this.ty *= k; this.tw *= k;
    }
    const kr = Math.pow(0.5, dt / 1.2);
    for (let i = 0; i < 12; i++) this.recent[i] *= kr;

    for (const p of peaks) {
      const m = midiOf(p.f);
      const dev = m - Math.round(m);
      const w = Math.sqrt(p.amp / max) * p.w;
      this.tx += w * Math.cos(TWO_PI * dev);
      this.ty += w * Math.sin(TWO_PI * dev);
      this.tw += w;
    }

    const tune = this.tuningCents / 100;
    const frame = new Float64Array(12);
    const low = new Float64Array(12);
    let lowSum = 0;
    for (const p of peaks) {
      const m = midiOf(p.f) - tune;
      const n = Math.round(m);
      const d = m - n;
      const g = Math.exp(-(d * d) / (2 * 0.18 * 0.18));
      const pc = ((n % 12) + 12) % 12;
      const v = Math.sqrt(p.amp / max) * p.w * g;
      frame[pc] += v;
      if (p.f < BASS_MAX_HZ) { low[pc] += v; lowSum += v; }
    }
    if (lowSum > 0) {
      for (let i = 0; i < 12; i++) this.bass[i] += (low[i] / lowSum) * dt;
      this.bassSeconds += dt;
    }
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += frame[i];
    if (sum <= 0) return;
    for (let i = 0; i < 12; i++) {
      this.chroma[i] += (frame[i] / sum) * dt;
      this.recent[i] += (frame[i] / sum) * dt;
    }
    this.seconds += dt;
  }

  normalized(which = this.chroma) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += which[i];
    return Array.from(which, (v) => (s > 0 ? v / s : 0));
  }
}

/** Circular-mean tuning (cents) over a list of findPeaks results. */
export function estimateTuning(frames) {
  let tx = 0, ty = 0, tw = 0;
  for (const fr of frames) {
    if (!fr) continue;
    for (const p of fr.peaks) {
      const m = midiOf(p.f);
      const dev = m - Math.round(m);
      const w = Math.sqrt(p.amp / fr.max) * p.w;
      tx += w * Math.cos(TWO_PI * dev);
      ty += w * Math.sin(TWO_PI * dev);
      tw += w;
    }
  }
  return tw > 0 ? (Math.atan2(ty, tx) / TWO_PI) * 100 : 0;
}

/**
 * Fundamental of a single voice or instrument from its peaks.
 * Returns { f0, ratio } where ratio is the share of spectral peak energy the f0's harmonic
 * series explains: near 1 for one voice, much lower for chords and full mixes.
 */
export function fundamental(found) {
  if (!found || !found.peaks.length) return null;
  const peaks = found.peaks;
  let total = 0;
  for (const p of peaks) total += p.amp;
  const strong = [...peaks].sort((a, b) => b.amp - a.amp).slice(0, 6);
  const cands = [];
  for (const p of strong) {
    for (const div of [1, 2, 3, 4]) {
      const f0 = p.f / div;
      if (f0 < 60 || f0 > 1100) continue;
      let s = 0, has1 = false;
      for (const q of peaks) {
        const k = Math.round(q.f / f0);
        if (k < 1 || k > 12) continue;
        if (Math.abs(q.f / (k * f0) - 1) < 0.03) { s += q.amp; if (k === 1) has1 = true; }
      }
      // Phone mics roll off low fundamentals, so a missing first harmonic is only lightly penalised.
      if (!has1) s *= 0.85;
      cands.push({ f0, s });
    }
  }
  if (!cands.length) return null;
  let maxS = 0;
  for (const c of cands) if (c.s > maxS) maxS = c.s;
  // Every subharmonic explains at least as much as the true f0, so take the highest
  // candidate that explains nearly as much as the best one.
  let best = null;
  for (const c of cands) if (c.s >= maxS * 0.9 && (!best || c.f0 > best.f0)) best = c;
  return { f0: best.f0, ratio: maxS / total };
}

/** A one-note "spectrum" for the melody engine. */
export const noteFrame = (f0) => ({ peaks: [{ f: f0, amp: 1, w: 1 }], max: 1 });
