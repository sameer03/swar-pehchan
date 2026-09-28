/*
 * tanpura.js — a synthesised tanpura for Swar Pehchaan.
 *
 * Each string is a physical model (extended Karplus–Strong), rendered once into an AudioBuffer:
 *  - two slightly detuned polarisations of the string give the slow, living beating;
 *  - the jawari (curved bridge) is modelled as the string's speaking length changing
 *    whenever it swings onto the bridge — lossless, so it keeps feeding the upper
 *    harmonics and the note "opens up" after the pluck instead of just dying away;
 *  - a nasal resonance sweeps upward after each pluck (the tanpura's "ooo-eee");
 *  - a soft finger-pad pluck, a warm wooden body, then stereo placement and room reverb.
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
   * Render one plucked string (physical model).
   * @param {number} freq        fundamental in Hz
   * @param {number} sampleRate
   * @param {object} [o]  see defaults in renderString
   * @returns {Float32Array}
   */
  /** One Karplus–Strong string polarisation with a soft one-sided "jawari" bridge contact in the loop. */
  function stringLoop(freq, sr, n, exc, o) {
    const s = o.loopBright;                      // loop low-pass: y = s*x[n] + (1-s)*x[n-1]; phase delay (1-s)
    const D = sr / freq;
    const N = Math.floor(D - (1 - s) - 0.6);
    const d = D - N - (1 - s);                   // fractional part for an all-pass, 0.3..1.3
    const apc = (1 - d) / (1 + d);
    const R = Math.pow(10, (-3 / (o.t60 * freq)));  // per-period loss for the requested T60
    const M = N + 4;
    const buf = new Float32Array(M);
    const out = new Float32Array(n);
    let w = 0, apx = 0, apy = 0, dcx = 0, dcy = 0, cont = 0;
    const c = o.contact;                         // bridge contact strength
    for (let i = 0; i < n; i++) {
      const a = buf[(w - N + M) % M], b = buf[(w - N - 1 + M) % M];
      const v = s * a + (1 - s) * b;
      // Jawari: when the string swings onto the curved bridge its speaking length changes a little.
      // Modulating the (lossless) all-pass delay with the string's own displacement spreads energy
      // into the upper harmonics every period, without draining it the way clipping would.
      const dd = Math.min(1.9, Math.max(0.1, d - c * Math.max(0, cont)));
      const apcN = (1 - dd) / (1 + dd);
      const ap = apcN * v + apx - apcN * apy; apx = v; apy = ap;
      let y = R * ap;
      // In-loop DC blocker (very low cut-off so the pitch isn't pulled)
      const yy = y - dcx + 0.9995 * dcy; dcx = y; dcy = yy; y = yy;
      if (i < exc.length) y += exc[i];
      buf[w] = y; w = (w + 1) % M; cont += o.contactSmooth * (y - cont);
      out[i] = y;
    }
    return out;
  }

  /** RBJ peaking EQ coefficients */
  function peaking(f0, sr, q, gainDb) {
    const A = Math.pow(10, gainDb / 40), w0 = 2 * Math.PI * f0 / sr, al = Math.sin(w0) / (2 * q), cs = Math.cos(w0);
    const a0 = 1 + al / A;
    return [(1 + al * A) / a0, (-2 * cs) / a0, (1 - al * A) / a0, (-2 * cs) / a0, (1 - al / A) / a0];
  }

  function renderString(freq, sr, o) {
    o = Object.assign({
      seconds: 8, seed: 7,
      t60: 16,            // ring time of the fundamental (s)
      loopBright: 0.72,   // how long the upper harmonics survive (lower = mellower)
      contact: 0.8,       // jawari: how strongly the string grazes the bridge (higher = buzzier)
      contactSmooth: 0.2,
      pluckSoft: 0.05,    // finger-pad pluck (lower = softer, warmer attack)
      pluckPos: 0.2,      // where along the string it's plucked (nearer the middle = rounder)
      sweepFrom: 700, sweepTo: 2200, sweepTime: 1.1, formantGain: 4, formantQ: 1.6,
    }, o || {});
    const n = Math.floor(o.seconds * sr);
    const rnd = makeRandom(o.seed);

    // Excitation: one period of soft, finger-plucked noise, combed for pluck position
    const P = Math.round(sr / freq);
    let exc = new Float32Array(P);
    let lp = 0;
    for (let i = 0; i < P; i++) { lp += o.pluckSoft * (rnd() - lp); exc[i] = lp; }
    const k = Math.max(1, Math.round(o.pluckPos * P));
    const combed = new Float32Array(P);
    for (let i = 0; i < P; i++) combed[i] = exc[i] - (i >= k ? exc[i - k] : 0);
    let pk = 0; for (const x of combed) pk = Math.max(pk, Math.abs(x));
    for (let i = 0; i < P; i++) combed[i] *= 0.9 / pk;

    // Two polarisations, very slightly detuned, give the slow beating of a real string
    const h = stringLoop(freq, sr, n, combed, o);
    const exc2 = combed.map((x) => x * 0.55);
    const v = stringLoop(freq * (1 + 0.00055 + 0.0002 * rnd()), sr, n, exc2, Object.assign({}, o, { t60: o.t60 * 0.8, contact: o.contact * 0.7 }));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = h[i] + v[i];

    // The jawari's "ooo-eee": a nasal resonance that sweeps up through the harmonics after each pluck
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, co = null;
    for (let i = 0; i < n; i++) {
      if (i % 32 === 0) {
        const t = i / sr;
        const fc = o.sweepFrom * Math.pow(o.sweepTo / o.sweepFrom, 1 - Math.exp(-t / o.sweepTime));
        co = peaking(Math.min(fc, sr * 0.4), sr, o.formantQ, o.formantGain);
      }
      const x = out[i];
      const y = co[0] * x + co[1] * x1 + co[2] * x2 - co[3] * y1 - co[4] * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      out[i] = y;
    }

    // Wooden body: gentle warmth around 200 Hz
    co = peaking(200, sr, 0.7, -7); x1 = x2 = y1 = y2 = 0;   // thin out the boomy low-mids
    for (let i = 0; i < n; i++) {
      const x = out[i], y = co[0] * x + co[1] * x1 + co[2] * x2 - co[3] * y1 - co[4] * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] = y;
    }

    // Output DC block, tail fade, normalise
    let px = 0, py = 0;
    for (let i = 0; i < n; i++) { const y = out[i] - px + 0.999 * py; px = out[i]; py = y; out[i] = y; }
    const fade = Math.floor(0.5 * sr);
    for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
    for (let i = 0; i < n; i++) out[i] /= peak || 1;
    return out;
  }

  /** A synthetic stereo room impulse response: decaying, darkening noise. */
  function makeRoom(ctx, seconds) {
    const sr = ctx.sampleRate, n = Math.floor(seconds * sr);
    const ir = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch), rnd = makeRandom(ch ? 99 : 7);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const k = 0.9 - 0.75 * Math.min(1, t / seconds);   // gets darker as it decays
        lp += k * (rnd() - lp);
        d[i] = lp * Math.exp(-t * 3.2) * (t < 0.012 ? t / 0.012 : 1);
      }
    }
    return ir;
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
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass'; tone.frequency.value = 3400; tone.Q.value = 0.4;
      // Gentle roll-off below ~110 Hz so the low strings don't rumble on laptop or phone speakers
      const lowcut = ctx.createBiquadFilter();
      lowcut.type = 'highpass'; lowcut.frequency.value = 140; lowcut.Q.value = 0.6;
      const shelf = ctx.createBiquadFilter();           // lighter low end overall
      shelf.type = 'lowshelf'; shelf.frequency.value = 300; shelf.gain.value = -5;
      const deBuzz = ctx.createBiquadFilter();          // soften the nasal edge
      deBuzz.type = 'peaking'; deBuzz.frequency.value = 1800; deBuzz.Q.value = 0.9; deBuzz.gain.value = -4;
      this.master.connect(lowcut).connect(shelf).connect(deBuzz).connect(tone);
      // Dry signal plus a small, warm room
      const dry = ctx.createGain(); dry.gain.value = 0.8;
      const wet = ctx.createGain(); wet.gain.value = 0.35;
      const verb = ctx.createConvolver();
      verb.buffer = makeRoom(ctx, 2.6);
      tone.connect(dry).connect(ctx.destination);
      tone.connect(verb).connect(wet).connect(ctx.destination);
      this.pans = [-0.35, -0.1, 0.12, 0.3].map((p) => {
        const n = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
        if (n.pan) n.pan.value = p;
        n.connect(this.master);
        return n;
      });
      this._timer = null;
    }

    _render() {
      const sr = this.ctx.sampleRate;
      const freqs = stringFreqs(this.saFreq, this.first);
      // Strings 2 and 3 are both Sa but never quite identical, so render them separately.
      // Every string is set up slightly differently, as on a real instrument.
      const opts = [
        { seed: 11, contact: 0.75, sweepTo: 2100 },
        { seed: 23, contact: 0.85, sweepTo: 2300 },
        { seed: 37, contact: 0.8, sweepTo: 2200, sweepTime: 1.3 },
        { seed: 51, contact: 0.6, sweepTo: 1800, t60: 18, seconds: 9 },
      ];
      this.buffers = freqs.map((f, i) => {
        const data = renderString(f * (i === 2 ? 1.0004 : 1), sr, opts[i]);
        const b = this.ctx.createBuffer(1, data.length, sr);
        b.getChannelData(0).set(data);
        return b;
      });
    }

    /** Pluck times within one cycle, in seconds (scaled by speed). */
    _pattern() {
      const u = 1.05 / this.speed;
      return { times: [0, u, 2 * u, 3 * u], cycle: 4.6 * u, gains: [0.6, 0.85, 0.85, 0.35] };
    }

    _pluck(i, when) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers[i];
      const g = this.ctx.createGain();
      g.gain.value = this._pattern().gains[i] * (0.9 + 0.2 * Math.random()); // human touch
      src.connect(g).connect(this.pans[i]);
      src.start(when);
      src.onended = () => g.disconnect();
    }

    _schedule() {
      const ahead = this.ctx.currentTime + 0.25;
      const p = this._pattern();
      while (this.nextTime < ahead) {
        this._pluck(this.step, this.nextTime + 0.025 * Math.random()); // no player is a metronome
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
