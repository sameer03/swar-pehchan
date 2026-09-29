/*
 * player.js — plays transcribed notation back so you can hear what was written.
 * Uses a plan from SwarCore.playbackPlan: one continuous voice per phrase, with each
 * swar re-articulated, and meend played as a real slide.
 */
(function (root) {
  'use strict';

  // Harmonic recipes (sine amplitudes for harmonics 1..N)
  const SOUNDS = {
    // Free reeds: rich, slightly hollow; two reeds a few cents apart give the harmonium's shimmer
    harmonium: { harmonics: Array.from({ length: 28 }, (_, i) => { const n = i + 1; return Math.pow(n, -0.95) * (n % 2 ? 1 : 0.62); }), cutoff: 2600, detune: 5, vibrato: 0 },
    // Bansuri-like: nearly pure, a little breathy vibrato
    flute: { harmonics: [1, 0.22, 0.09, 0.04, 0.02], cutoff: 5000, detune: 0, vibrato: 7 },
    // Plain tone: easiest for checking exact pitch
    pure: { harmonics: [1], cutoff: 8000, detune: 0, vibrato: 0 },
  };

  class NotationPlayer {
    constructor(ctx) {
      this.ctx = ctx;
      this.out = ctx.createGain();
      this.out.gain.value = 0.9;
      this.out.connect(ctx.destination);
      this.voices = [];
      this.waves = {};
      this.startAt = 0;
      this.endAt = 0;
    }

    _wave(name) {
      if (!this.waves[name]) {
        const h = SOUNDS[name].harmonics, real = new Float32Array(h.length + 1), imag = new Float32Array(h.length + 1);
        h.forEach((a, i) => { imag[i + 1] = a; });
        this.waves[name] = this.ctx.createPeriodicWave(real, imag);
      }
      return this.waves[name];
    }

    get playing() { return this.voices.length > 0 && this.ctx.currentTime < this.endAt; }

    /** Schedule all phrases. Returns the context time at which playback starts. */
    play(phrases, saFreq, soundName) {
      this.stop(true);
      const ctx = this.ctx, snd = SOUNDS[soundName] || SOUNDS.harmonium;
      const T = ctx.currentTime + 0.12;
      const hz = (semi) => saFreq * Math.pow(2, semi / 12);
      const level = 0.22;
      this.startAt = T;
      this.endAt = T;

      for (const p of phrases) {
        const filt = ctx.createBiquadFilter();
        filt.type = 'lowpass'; filt.frequency.value = snd.cutoff; filt.Q.value = 0.5;
        const g = ctx.createGain();
        g.gain.value = 0;
        filt.connect(g).connect(this.out);

        const oscs = (snd.detune ? [-snd.detune, snd.detune] : [0]).map((cents) => {
          const o = ctx.createOscillator();
          o.setPeriodicWave(this._wave(soundName in SOUNDS ? soundName : 'harmonium'));
          o.detune.value = cents;
          o.connect(filt);
          return o;
        });

        const extras = [];
        if (snd.vibrato) {
          const lfo = ctx.createOscillator(), depth = ctx.createGain();
          lfo.frequency.value = 5.2; depth.gain.value = snd.vibrato;
          lfo.connect(depth);
          oscs.forEach((o) => depth.connect(o.detune));
          extras.push(lfo);
        }

        // Pitch: steps between swaras, slides for meend
        let last = -Infinity;
        for (const q of p.points) {
          const t = Math.max(T + q.t, last);
          for (const o of oscs) {
            if (q.glide) o.frequency.exponentialRampToValueAtTime(hz(q.semi), t);
            else o.frequency.setValueAtTime(hz(q.semi), t);
          }
          last = t;
        }

        // Loudness: soft attack, a small dip to re-articulate each new swar, gentle release
        const G = g.gain;
        G.setValueAtTime(0, T + p.t0);
        G.linearRampToValueAtTime(level, T + p.t0 + 0.035);
        let lastG = T + p.t0 + 0.035;
        p.notes.forEach((n, i) => {
          if (i === 0 || n.item.meend) return;
          // Short notes (murki, kan) get a lighter, quicker touch so they aren't swallowed
          const dur = n.t1 - n.t0, a = T + n.t0;
          const lead = Math.min(0.03, dur * 0.25), back = Math.min(0.045, dur * 0.35), depth = dur < 0.12 ? 0.8 : 0.55;
          const s0 = Math.max(lastG + 0.001, a - lead);
          G.setValueAtTime(level, s0);
          G.linearRampToValueAtTime(level * depth, Math.max(s0 + 0.001, a));
          G.linearRampToValueAtTime(level, Math.max(s0 + 0.002, a + back));
          lastG = Math.max(s0 + 0.002, a + back);
        });
        G.setValueAtTime(level, Math.max(lastG + 0.001, T + p.t1));
        G.linearRampToValueAtTime(0, T + p.t1 + 0.14);

        const all = oscs.concat(extras);
        all.forEach((o) => { o.start(T + p.t0); o.stop(T + p.t1 + 0.2); });
        this.voices.push({ oscs: all, g });
        this.endAt = Math.max(this.endAt, T + p.t1 + 0.2);
      }
      return T;
    }

    stop(now) {
      const t = this.ctx.currentTime;
      for (const v of this.voices) {
        v.g.gain.cancelScheduledValues(t);
        v.g.gain.setTargetAtTime(0, t, now ? 0.01 : 0.05);
        v.oscs.forEach((o) => { try { o.stop(t + 0.3); } catch (e) { /* already stopped */ } });
      }
      this.voices = [];
      this.endAt = t;
    }
  }

  const api = { NotationPlayer, SOUNDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SwarPlayer = api;
})(typeof window !== 'undefined' ? window : this);
