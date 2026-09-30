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
    const o = Object.assign({ minFreq: 65, maxFreq: 1100, threshold: 0.2 }, opts || {});
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
    if (tau < 0) {
      // Real voices are breathier than test tones: fall back to the best dip if it's reasonably clear.
      let best = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (d[t] < d[best]) best = t;
      if (d[best] > (o.fallback || 0.35)) return null;
      tau = best;
    }
    if (tau < 1 || tau > tauMax) return null;
    // Octave check: with a drone underneath, the true period can lose to a multiple of it
    // (the note reads an octave or a fifth too low). If a clear dip exists at tau/2 or tau/3,
    // the higher pitch is the real one.
    for (const m of [2, 3]) {
      const c = Math.round(tau / m);
      if (c < tauMin + 1) continue;
      let best = c;
      for (let t = c - 2; t <= c + 2; t++) if (t > tauMin && t < tauMax && d[t] < d[best]) best = t;
      if (d[best] < (o.octaveDip || 0.3) && d[best] < d[tau] + 0.12 && d[best] <= d[best - 1] && d[best] <= d[best + 1]) { tau = best; break; }
    }

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
   * How much of the singing to capture.
   *  holdTime  – a swar held this long is a main note
   *  kanTime   – anything touched at least this long is written (shorter = kan swar)
   *  hysteresis– how far (semitones) the voice must move before we call it a new swar
   *  smooth    – median filter length in frames (kills octave blips)
   */
  const DETAIL = {
    main:  { kanTime: null, hysteresis: 0.7,  smooth: 5 },  // kanTime null = same as holdTime
    kan:   { kanTime: 0.045, hysteresis: 0.6, smooth: 5 },
    every: { kanTime: 0.025, hysteresis: 0.52, smooth: 3 },
  };

  function median(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  /**
   * Turns a stream of per-frame pitches into notes, keeping ornaments.
   *
   * push(time, x):  x = semitones above Sa (float) · null = silence · undefined = loud but no clear pitch
   *
   * Events:
   *  {type:'note', id, swar, meend}  a swar has been touched long enough to write down
   *  {type:'main', id}               …and has now been held long enough to be a main note
   *  {type:'end',  id, time, kind, duration} the swar finished at `time`; kind is 'main' or 'kan'
   *  {type:'gap'}                    a pause (new phrase)
   * meend = true when the voice slid into this swar through notes too brief to write.
   */
  class Segmenter {
    constructor(onEvent, opts) {
      this.onEvent = onEvent;
      this.holdTime = 0.12;
      this.gapTime = 0.35;
      this.breakTime = 0.08; // silence shorter than this doesn't end a note (consonants, breaths)
      this.meendTime = 0.06; // a glide taking at least this long is written as meend (plain jumps settle faster)
      this.setDetail('kan');
      Object.assign(this, opts || {});
      this.reset();
    }
    setDetail(level) {
      const p = DETAIL[level] || DETAIL.kan;
      this.detail = level;
      this._kanTime = p.kanTime;
      this.hysteresis = p.hysteresis;
      this.smooth = p.smooth;
    }
    get kanTime() { return this._kanTime == null ? this.holdTime : Math.min(this._kanTime, this.holdTime); }
    reset() {
      this.cur = null;
      this.recent = [];
      this.lastVoiced = -Infinity;
      this.gapEmitted = true;
      this.passing = false;
      this.prev = null; // last written segment {semi, id, main}
      this.nextId = 1;
    }
    push(time, x) {
      if (x === undefined) return; // unclear frame: keep whatever we have
      if (x === null) {
        this.recent.length = 0;
        if (this.cur && time - this.lastVoiced > this.breakTime) {
          this._end();
          this.passing = false;
          this.prev = null;
        }
        if (!this.gapEmitted && time - this.lastVoiced > this.gapTime) {
          this.gapEmitted = true;
          this.onEvent({ type: 'gap', time });
        }
        return;
      }
      this.recent.push(x);
      if (this.recent.length > this.smooth) this.recent.shift();
      const s = median(this.recent);
      this.lastVoiced = time;

      if (this.cur && Math.abs(s - this.cur.semi) < this.hysteresis) {
        this.cur.last = time;
      } else {
        if (this.cur) this._end();
        this.cur = { semi: Math.round(s), start: time, last: time, written: false, main: false };
      }
      this._check(time);
    }
    _check(time) {
      const c = this.cur;
      if (!c.written && time - c.start >= this.kanTime) {
        c.written = true;
        if (this.prev && this.prev.semi === c.semi && this.passing) {
          // Wobbled away and straight back: same note continuing, not a new one.
          c.id = this.prev.id; c.main = this.prev.main;
        } else {
          c.id = this.nextId++;
          this.onEvent({ type: 'note', id: c.id, time: c.start, swar: swarFor(c.semi), meend: this.passing && !!this.prev && c.start - this.prev.last >= this.meendTime });
        }
        this.passing = false;
        this.gapEmitted = false;
      }
      if (c.written && !c.main && time - c.start >= this.holdTime) {
        c.main = true;
        this.onEvent({ type: 'main', id: c.id });
      }
    }
    _end() {
      const c = this.cur;
      this.cur = null;
      if (!c.written) { this.passing = true; return; } // slid through it
      this.prev = { semi: c.semi, id: c.id, main: c.main, last: c.last };
      this.onEvent({ type: 'end', id: c.id, time: c.last, kind: c.main ? 'main' : 'kan', duration: c.last - c.start });
    }
    /** Call at end of a recording to close the last note. */
    flush(time) { this.push(time, null); this.push(time + this.gapTime + 1, null); }
  }


  /**
   * Turn transcribed notes into a playback plan.
   * items: [{kind:'main'|'kan'|'pending'|'gap', swar:{semi}, meend, start, end}]
   * Returns phrases, each a continuous voice:
   *   { t0, t1, points:[{t, semi, glide}], notes:[{item, t0, t1}] }
   * Times start at 0 and are divided by `speed`. Pauses between phrases are shortened to
   * `maxPause` seconds, and small breaks inside a phrase are joined (legato), as in singing.
   */
  function playbackPlan(items, opts) {
    const o = Object.assign({ speed: 1, maxPause: 0.8, legato: 0.25, minNote: 0.05, jump: 0.018, minMeend: 0.1 }, opts || {});
    const phrases = [];
    let cur = null;
    const notes = items.filter((i) => i.kind === 'gap' || (i.swar && i.start != null));
    for (let k = 0; k < notes.length; k++) {
      const it = notes[k];
      if (it.kind === 'gap') { cur = null; continue; }
      const next = notes[k + 1] && notes[k + 1].kind !== 'gap' ? notes[k + 1] : null;
      let t0 = it.start;
      let t1 = it.end != null ? it.end : next ? next.start : it.start + 0.4;
      t1 = Math.max(t1, t0 + o.minNote);
      if (next && next.start - t1 < o.legato && !next.meend) t1 = Math.max(t1, next.start); // legato join
      if (!cur || (it.meend !== true && t0 - cur.t1 > o.legato)) {
        cur = { t0, t1, points: [], notes: [] };
        phrases.push(cur);
      }
      const prev = cur.notes[cur.notes.length - 1];
      if (it.meend && prev) {
        // Meend: hold the previous swar, then slide into this one. The detector only sees the middle
        // of a slide, so widen it (at least minMeend) so it sounds like the glide that was sung.
        const slideEnd = t0 + 0.03;
        const slideStart = Math.max(prev.t0 + 0.04, Math.min(prev.t1 - 0.03, slideEnd - o.minMeend));
        prev.t1 = Math.min(prev.t1, slideStart);
        cur.points.push({ t: slideStart, semi: prev.item.swar.semi, glide: false });
        cur.points.push({ t: slideEnd, semi: it.swar.semi, glide: true });
      } else if (prev) {
        cur.points.push({ t: t0 - o.jump, semi: prev.item.swar.semi, glide: false });
        cur.points.push({ t: t0, semi: it.swar.semi, glide: true });
      } else {
        cur.points.push({ t: t0, semi: it.swar.semi, glide: false });
      }
      cur.notes.push({ item: it, t0, t1 });
      cur.t1 = Math.max(cur.t1, t1);
    }
    // Close up long pauses and rebase to 0
    let shift = 0, lastEnd = null;
    for (const p of phrases) {
      if (lastEnd == null) shift = p.t0;
      else if (p.t0 - lastEnd > o.maxPause) shift += p.t0 - lastEnd - o.maxPause;
      lastEnd = p.t1;
      const f = (t) => (t - shift) / o.speed;
      p.t0 = f(p.t0); p.t1 = f(p.t1);
      p.points.forEach((q) => { q.t = Math.max(p.t0, f(q.t)); });
      p.notes.forEach((n) => { n.t0 = f(n.t0); n.t1 = f(n.t1); });
    }
    return phrases;
  }

  /** Plain-text notation from a list of {kind:'main'|'kan'|'gap', swar, meend}. */
  function notationText(items) {
    const out = [];
    let pendingKan = '';
    for (const it of items) {
      if (it.kind === 'gap') { if (out.length) out.push('|\n'); pendingKan = ''; continue; }
      const t = swarText(it.swar);
      const link = it.meend && out.length && !out[out.length - 1].endsWith('\n') ? '~' : '';
      if (it.kind === 'kan') { pendingKan += (link ? '~' : '') + '[' + t + ']'; continue; }
      out.push((link && !pendingKan ? '~' : '') + pendingKan + t);
      pendingKan = '';
    }
    if (pendingKan) out.push(pendingKan);
    return out.join(' ').replace(/ ~/g, '~').replace(/\|\n /g, '|\n').replace(/\s*\|\n$/, '').trim();
  }


  /**
   * Ignores the tanpura when the mic can hear it through the speakers.
   *
   * The app measures the tanpura's own output level (outRms) at every frame. While only the
   * tanpura sounds, learn() works out how loud that output arrives at the mic (the ratio k)
   * and which pitch classes it shows up as (Sa, Pa, …). Afterwards the expected leak at any
   * moment is k × outRms, so accept() can tell whether a frame has a singer in it:
   *  - a tanpura note (e.g. Sa) must be clearly louder than the expected leak,
   *  - any other swar only needs to be audible (the tanpura can't play it),
   *  - an unpitched frame at leak level is treated as silence.
   */
  class LeakGate {
    constructor(opts) {
      Object.assign(this, { margin: 1.45, otherMargin: 0.5, silenceMargin: 1.3 }, opts || {});
      this.reset();
    }
    reset() { this.frames = []; this.k = 0; this.classes = new Uint8Array(12); this.ready = false; }
    learn(micRms, outRms, semi) { if (outRms > 1e-4) this.frames.push([micRms / outRms, semi]); }
    finish() {
      const ratios = this.frames.map((f) => f[0]).sort((x, y) => x - y);
      this.k = ratios.length ? ratios[ratios.length >> 1] : 0;
      const count = new Array(12).fill(0);
      let voiced = 0;
      for (const [, semi] of this.frames) if (semi != null) { count[((Math.round(semi) % 12) + 12) % 12]++; voiced++; }
      for (let c = 0; c < 12; c++) this.classes[c] = count[c] >= Math.max(3, 0.05 * voiced) ? 1 : 0;
      this.frames = [];
      this.ready = true;
    }
    accept(micRms, semi, outRms) {
      if (!this.ready) return true;
      const leak = this.k * outRms;
      if (semi == null) return micRms > leak * this.silenceMargin;
      const c = ((Math.round(semi) % 12) + 12) % 12;
      return micRms > leak * (this.classes[c] ? this.margin : this.otherMargin);
    }
    /** Pitch classes the tanpura showed up as. */
    heard() { return [...this.classes].map((v, c) => (v ? c : -1)).filter((c) => c >= 0); }
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
    semitonesFromSa, swarFor, swarText, Segmenter, DETAIL, notationText, playbackPlan, LeakGate, decimate,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SwarCore = api;
})(typeof window !== 'undefined' ? window : this);
