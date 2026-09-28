/*
 * swar-core.js — pitch detection + sargam mapping for Swar Pehchan.
 * Works in the browser (window.SwarCore) and in Node (module.exports) so it can be tested.
 */
(function (root) {
  'use strict';

  // The 12 swaras, indexed by semitones above Sa.
  const SWARAS = [
    { name: 'Sa',  short: 'S' },
    { name: 'Re',  short: 'r', komal: true },
    { name: 'Re',  short: 'R' },
    { name: 'Ga',  short: 'g', komal: true },
    { name: 'Ga',  short: 'G' },
    { name: 'Ma',  short: 'm' },
    { name: 'Ma',  short: 'M', tivra: true },
    { name: 'Pa',  short: 'P' },
    { name: 'Dha', short: 'd', komal: true },
    { name: 'Dha', short: 'D' },
    { name: 'Ni',  short: 'n', komal: true },
    { name: 'Ni',  short: 'N' },
  ];

  const WESTERN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  /** Frequency of a western note, e.g. noteFreq('C#', 3). A4 = 440 Hz. */
  function noteFreq(name, octave) {
    const midi = WESTERN.indexOf(name) + 12 * (octave + 1);
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function westernName(freq) {
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    return WESTERN[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  /**
   * YIN pitch detector (de Cheveigné & Kawahara, 2002).
   * Returns { freq, clarity } or null when no clear pitch is found.
   */
  function detectPitch(buf, sampleRate, opts) {
    const o = Object.assign({ minFreq: 65, maxFreq: 1100, threshold: 0.15 }, opts || {});
    const W = buf.length >> 1;
    const tauMin = Math.max(2, Math.floor(sampleRate / o.maxFreq));
    const tauMax = Math.min(W - 1, Math.floor(sampleRate / o.minFreq));
    const d = new Float32Array(tauMax + 2);

    for (let tau = 1; tau <= tauMax + 1 && tau < W; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) {
        const x = buf[i] - buf[i + tau];
        s += x * x;
      }
      d[tau] = s;
    }
    // Cumulative mean normalised difference
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      running += d[tau];
      d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }

    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < o.threshold) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) return null;

    // Parabolic interpolation for sub-sample accuracy
    const x0 = d[tau - 1], x1 = d[tau], x2 = d[tau + 1];
    const denom = x0 + x2 - 2 * x1;
    const shift = denom !== 0 ? (x0 - x2) / (2 * denom) : 0;
    const freq = sampleRate / (tau + (Math.abs(shift) < 1 ? shift : 0));
    if (freq < o.minFreq || freq > o.maxFreq) return null;
    return { freq, clarity: 1 - x1 };
  }

  function rms(buf) {
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  /** Semitones (float) of freq above Sa. */
  function semitonesFromSa(freq, saFreq) {
    return 12 * Math.log2(freq / saFreq);
  }

  /**
   * Describe a (rounded) semitone offset from Sa.
   * octave: 0 = madhya, -1 = mandra, +1 = taar.
   */
  function swarFor(semi) {
    const idx = ((semi % 12) + 12) % 12;
    const octave = Math.floor(semi / 12);
    return Object.assign({ semi, idx, octave }, SWARAS[idx]);
  }

  /** Plain-text label: komal "(k)", tivra "(t)", mandra prefix ".", taar suffix "'". */
  function swarText(s) {
    let t = s.name + (s.komal ? '(k)' : '') + (s.tivra ? '(t)' : '');
    if (s.octave < 0) t = '.'.repeat(-s.octave) + t;
    if (s.octave > 0) t = t + "'".repeat(s.octave);
    return t;
  }

  /**
   * Turns a stream of per-frame pitches into discrete notes.
   * A note is committed once it has been held steadily for minDuration seconds.
   * Frames far from any semitone (glides / meend) don't reset the current note.
   */
  class Segmenter {
    constructor(onEvent, opts) {
      this.onEvent = onEvent;
      this.minDuration = (opts && opts.minDuration) || 0.12;
      this.gapTime = (opts && opts.gapTime) || 0.45;
      this.tolerance = (opts && opts.tolerance) || 0.35; // semitones
      this.reset();
    }
    reset() {
      this.cand = null;
      this.candStart = 0;
      this.last = null;
      this.lastVoiced = -Infinity;
      this.gapEmitted = true;
    }
    /** semiFloat: semitones above Sa (float), or null for silence/unvoiced. */
    push(time, semiFloat) {
      if (semiFloat === null) {
        this.cand = null;
        if (!this.gapEmitted && time - this.lastVoiced > this.gapTime) {
          this.gapEmitted = true;
          this.last = null;
          this.onEvent({ type: 'gap', time });
        }
        return;
      }
      this.lastVoiced = time;
      const r = Math.round(semiFloat);
      if (Math.abs(semiFloat - r) > this.tolerance) return; // in a glide
      if (this.cand !== r) {
        this.cand = r;
        this.candStart = time;
        return;
      }
      if (time - this.candStart >= this.minDuration && this.last !== r) {
        this.last = r;
        this.gapEmitted = false;
        this.onEvent({ type: 'note', time: this.candStart, swar: swarFor(r) });
      }
    }
  }

  /** Average-and-decimate a signal (cheap low-pass + downsample). */
  function decimate(data, factor) {
    if (factor <= 1) return data;
    const out = new Float32Array(Math.floor(data.length / factor));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      const b = i * factor;
      for (let j = 0; j < factor; j++) s += data[b + j];
      out[i] = s / factor;
    }
    return out;
  }

  const api = {
    SWARAS, WESTERN, noteFreq, westernName, detectPitch, rms,
    semitonesFromSa, swarFor, swarText, Segmenter, decimate,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SwarCore = api;
})(typeof window !== 'undefined' ? window : this);
