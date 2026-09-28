// Synthesises a sung scale and checks Swar Pehchaan transcribes it. Run: node test/core.test.js
const assert = require('assert');
const C = require('../swar-core.js');

const sr = 44100, sa = C.noteFreq('C#', 3);
function tone(semi, secs, out) {
  const f = sa * Math.pow(2, semi / 12);
  for (let i = 0; i < sr * secs; i++) {
    const t = i / sr;
    out.push(0.5 * Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t) + 0.1 * Math.sin(6 * Math.PI * f * t));
  }
}
function silence(secs, out) { for (let i = 0; i < sr * secs; i++) out.push(0); }

const sig = [];
[0, 2, 3, 5, 6, 7, 8, 11, 12, -1, -5].forEach((s) => tone(s, 0.4, sig));
silence(0.8, sig);
tone(0, 0.4, sig);
silence(0.8, sig);

const q = 4, data = C.decimate(Float32Array.from(sig), q), rate = sr / q;
const out = [];
const seg = new C.Segmenter((e) => out.push(e.type === 'gap' ? '|' : C.swarText(e.swar)));
for (let i = 0; i + 1024 < data.length; i += 128) {
  const fr = data.subarray(i, i + 1024), t = i / rate;
  if (C.rms(fr) < 0.01) { seg.push(t, null); continue; }
  const p = C.detectPitch(fr, rate);
  seg.push(t, p ? C.semitonesFromSa(p.freq, sa) : null);
}

assert.strictEqual(out.join(' '), "Sa Re Ga(k) Ma Ma(t) Pa Dha(k) Ni Sa' .Ni .Pa | Sa |");
assert.strictEqual(C.westernName(C.noteFreq('A', 4)), 'A4');
console.log('ok:', out.join(' '));
