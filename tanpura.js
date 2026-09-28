/*
 * tanpura.js — a synthesised tanpura for Swar Pehchaan.
 *
 * Each string is rendered once into an AudioBuffer with additive synthesis:
 * every harmonic gets its own envelope, and higher harmonics "bloom" a little
 * after the pluck and then fade. That rising-then-falling band of overtones is
 * what the jawari (the curved bridge) does on a real tanpura.
 *
 * Works in the browser (window.SwarTanpura) and in Node (for tests).
 */
(function (root) {
  'use strict';

  // Just-intonation ratios for the first string.
  const FIRST_STRING = { Pa: 3 / 2, Ma: 4 / 3, Ni: 15 / 8 };

  /** Deterministic noise so every render sounds the same. */
  function makeRandom(seed) {
    let s = seed || 1;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  }

  /**
   * Render one plucked string.
   * @param {number} freq        fundamental in Hz
   * @param {number} sampleRate
   * @param {object} [o]  { seconds, brightness 0..1, jawari 0..1, seed }
   * @returns {Float32Array}
   */
  function renderString(freq, sampleRate, o) {
    o = Object.assign({ seconds: 5.5, brightness: 0.7, jawari: 0.8, seed: 7 }, o || {});
    const n = Math.floor(o.seconds * sampleRate);
    const out = new Float32Array(n);
    const nyquistSafe = Math.min(sampleRate / 2.2, 9000);
    const H = Math.max(1, Math.min(48, Math.floor(nyquistSafe / freq)));
    const rnd = makeRandom(o.seed);

    const BLOCK = 64; // envelopes are smooth, so compute them per block and interpolate
    for (let h = 1; h <= H; h++) {
      const rel = h / H;
      const f = freq * h; // exactly harmonic, so the drone stays perfectly in tune
      const amp = Math.pow(h, -(1.25 - 0.6 * o.brightness));
      const decay = 5.5 / (1 + 0.06 * h);                       // seconds
      const bloomAt = 0.05 + o.jawari * (0.25 + 1.1 * Math.pow(rel, 0.7));
      const bloomWidth = 0.35 + 0.5 * rel;
      const bloomGain = o.jawari * (0.6 + 1.4 * rel);
      const envAt = (t) => {
        const d = (t - bloomAt) / bloomWidth;
        return amp * Math.exp(-t / decay) * (1 - Math.exp(-t / 0.004)) * (0.45 + bloomGain * Math.exp(-d * d));
      };
      // Two slightly detuned copies of each partial give the gentle beating of a real string.
      const detune = 1 + 0.0006 * rnd();
      const w1 = (2 * Math.PI * f) / sampleRate, w2 = w1 * detune;
      const c1 = Math.cos(w1), s1 = Math.sin(w1), c2 = Math.cos(w2), s2 = Math.sin(w2);
      let x1 = 1, y1 = 0, x2 = Math.cos(rnd() * Math.PI), y2 = Math.sin(rnd() * Math.PI);

      let e0 = envAt(0);
      for (let b = 0; b < n; b += BLOCK) {
        const end = Math.min(n, b + BLOCK);
        const e1 = envAt(end / sampleRate), de = (e1 - e0) / (end - b);
        if (e0 < 1e-5 && e1 < 1e-5) { e0 = e1; continue; }
        let e = e0;
        for (let i = b; i < end; i++) {
          out[i] += e * (y1 + 0.6 * y2);
          e += de;
          let nx = x1 * c1 - y1 * s1; y1 = x1 * s1 + y1 * c1; x1 = nx;   // rotate phasors
          nx = x2 * c2 - y2 * s2; y2 = x2 * s2 + y2 * c2; x2 = nx;
        }
        // keep the phasors on the unit circle
        const r1 = 1 / Math.hypot(x1, y1), r2 = 1 / Math.hypot(x2, y2);
        x1 *= r1; y1 *= r1; x2 *= r2; y2 *= r2;
        e0 = e1;
      }
    }

    // Pluck: a short burst of noise at the start
    const pluck = Math.floor(0.012 * sampleRate);
    let lp = 0;
    for (let i = 0; i < pluck; i++) {
      lp += 0.25 * (rnd() - lp);
      out[i] += 0.35 * lp * (1 - i / pluck);
    }

    // Fade the tail and normalise
    const fade = Math.floor(0.4 * sampleRate);
    for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak;
    return out;
  }

  /** The four strings for a given Sa: first string (mandra), Sa, Sa, kharaj Sa. */
  function stringFreqs(saFreq, first) {
    return [saFreq * (FIRST_STRING[first] || FIRST_STRING.Pa) / 2, saFreq, saFreq, saFreq / 2];
  }

  /** Plays the tanpura cycle through Web Audio. */
  class Tanpura {
    constructor(ctx) {
      this.ctx = ctx;
      this.saFreq = 138.59;
      this.first = 'Pa';
      this.speed = 1;       // 0.6 (slow) … 1.6 (fast)
      this.volume = 0.5;
      this.playing = false;
      this.buffers = null;
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'lowpass'; shelf.frequency.value = 6500; shelf.Q.value = 0.3;
      this.master.connect(shelf).connect(ctx.destination);
      this._timer = null;
    }

    _render() {
      const sr = this.ctx.sampleRate;
      const freqs = stringFreqs(this.saFreq, this.first);
      // Strings 2 and 3 are both Sa but never quite identical, so render them separately.
      const opts = [
        { brightness: 0.7, jawari: 0.8, seed: 11 },
        { brightness: 0.75, jawari: 0.85, seed: 23 },
        { brightness: 0.65, jawari: 0.8, seed: 37 },
        { brightness: 0.6, jawari: 0.9, seed: 51, seconds: 6.5 },
      ];
      this.buffers = freqs.map((f, i) => {
        const data = renderString(f * (i === 2 ? 1.0006 : 1), sr, opts[i]);
        const b = this.ctx.createBuffer(1, data.length, sr);
        b.getChannelData(0).set(data);
        return b;
      });
    }

    /** Pluck times within one cycle, in seconds (scaled by speed). */
    _pattern() {
      const u = 1.05 / this.speed;
      return { times: [0, u, 2 * u, 3 * u], cycle: 4.6 * u, gains: [0.8, 0.7, 0.7, 1.0] };
    }

    _pluck(i, when) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers[i];
      const g = this.ctx.createGain();
      g.gain.value = this._pattern().gains[i] * (0.94 + 0.12 * Math.random()); // human touch
      src.connect(g).connect(this.master);
      src.start(when);
      src.onended = () => g.disconnect();
    }

    _schedule() {
      const ahead = this.ctx.currentTime + 0.25;
      const p = this._pattern();
      while (this.nextTime < ahead) {
        this._pluck(this.step, this.nextTime);
        this.step = (this.step + 1) % 4;
        this.nextTime += this.step === 0 ? p.cycle - p.times[3] : p.times[1];
      }
    }

    start() {
      if (this.playing) return;
      if (!this.buffers) this._render();
      this.playing = true;
      this.step = 0;
      this.nextTime = this.ctx.currentTime + 0.05;
      const g = this.master.gain;
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
      this._schedule();
      this._timer = setInterval(() => this._schedule(), 60);
    }

    stop() {
      if (!this.playing) return;
      this.playing = false;
      clearInterval(this._timer);
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
    }

    setVolume(v) {
      this.volume = v;
      if (this.playing) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
    }
    setSpeed(s) { this.speed = s; }
    setSa(freq) {
      if (Math.abs(freq - this.saFreq) < 0.01 && this.buffers) return;
      this.saFreq = freq; this.buffers = null;
      if (this.playing) this._render();
    }
    setFirst(first) {
      if (first === this.first && this.buffers) return;
      this.first = first; this.buffers = null;
      if (this.playing) this._render();
    }
  }

  const api = { renderString, stringFreqs, Tanpura, FIRST_STRING };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SwarTanpura = api;
})(typeof window !== 'undefined' ? window : this);
