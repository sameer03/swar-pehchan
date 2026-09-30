// Synthesises sung phrases and checks Swar Pehchaan transcribes them. Run: node test/core.test.js
const assert = require('assert');
const C = require('../swar-core.js');

const FRAME = +(process.env.FRAME || 512);
const SR = 44100, SA = C.noteFreq('C#', 3);

/** Render a pitch contour: list of [semitoneStart, semitoneEnd, seconds, {vibrato, andolan}] (null = silence). */
function sing(parts, noise = 0) {
  const out = [];
  let phase = 0, seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (const p of parts) {
    if (p === null || p[0] === null) { const n = SR * (p ? p[2] : 0.6); for (let i = 0; i < n; i++) out.push(noise * rnd() * 0.3); continue; }
    const [a, b, secs, o = {}] = p, n = Math.round(SR * secs);
    for (let i = 0; i < n; i++) {
      const t = i / SR, k = i / n;
      let semi = a + (b - a) * k;
      if (o.vibrato) semi += o.vibrato * Math.sin(2 * Math.PI * 5.5 * t);
      if (o.andolan) semi += o.andolan * Math.sin(2 * Math.PI * 1.5 * t);
      phase += 2 * Math.PI * SA * Math.pow(2, semi / 12) / SR;
      out.push(0.5 * Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase) + noise * rnd());
    }
  }
  return Float32Array.from(out);
}

function transcribe(sig, detail = 'kan') {
  const q = 4, data = C.decimate(sig, q), rate = SR / q;
  const items = [], byId = {};
  const seg = new C.Segmenter((e) => {
    if (e.type === 'gap') items.push({ kind: 'gap' });
    else if (e.type === 'note') { byId[e.id] = { kind: 'pending', swar: e.swar, meend: e.meend }; items.push(byId[e.id]); }
    else if (e.type === 'main') byId[e.id].kind = 'main';
    else if (e.type === 'end') byId[e.id].kind = e.kind;
  });
  seg.setDetail(detail);
  let t = 0;
  for (let i = 0; i + FRAME < data.length; i += 128) {
    const fr = data.subarray(i, i + FRAME); t = i / rate;
    if (C.rms(fr) < 0.02) { seg.push(t, null); continue; }
    const p = C.detectPitch(fr, rate);
    seg.push(t, p ? C.semitonesFromSa(p.freq, SA) : undefined);
  }
  seg.flush(t);
  return C.notationText(items);
}

function check(name, got, want) {
  console.log(`${got === want ? 'ok  ' : 'FAIL'} ${name}\n     got:  ${got.replace(/\n/g, ' ')}${got === want ? '' : '\n     want: ' + want.replace(/\n/g, ' ')}`);
  assert.strictEqual(got, want);
}

// 1. Plain scale with vibrato, all octaves and altered swaras
const scale = [0, 2, 3, 5, 6, 7, 8, 11, 12, -1, -5].map((s) => [s, s, 0.4, { vibrato: 0.25 }]);
check('scale with vibrato', transcribe(sing([...scale, null, [0, 0, 0.4], null])),
  "Sa Re Ga(k) Ma Ma(t) Pa Dha(k) Ni Sa' .Ni .Pa |\nSa");

// 2. Kan swar: a quick touch of Ga before landing on Re
check('kan swar', transcribe(sing([[0, 0, 0.4], [4, 4, 0.07], [2, 2, 0.45], null])),
  'Sa [Ga]Re');

// 3. Meend: slide from Pa down to Ga
check('meend', transcribe(sing([[7, 7, 0.4], [7, 4, 0.09], [4, 4, 0.45], null])),
  'Pa~Ga');

// 4. Andolan on komal Ga stays one note, not a flicker of Ga/Re/Ma
check('andolan', transcribe(sing([[2, 2, 0.35], [3, 3, 1.2, { andolan: 0.3 }], [2, 2, 0.35], null])),
  'Re Ga(k) Re');

// 5. Murki: fast Pa-Dha-Pa-Ma turn into Ga, captured in "every" mode
check('murki (every movement)', transcribe(sing([[4, 4, 0.35], [7, 7, 0.06], [9, 9, 0.06], [7, 7, 0.06], [5, 5, 0.06], [4, 4, 0.4], null]), 'every'),
  'Ga [Pa][Dha][Pa][Ma]Ga');

// 6. Same murki in "main notes" mode shows only the held notes, joined by ~ (an ornament happened here)
check('murki (main notes only)', transcribe(sing([[4, 4, 0.35], [7, 7, 0.06], [9, 9, 0.06], [7, 7, 0.06], [5, 5, 0.06], [2, 2, 0.4], null]), 'main'),
  'Ga~Re');

// 7. Breathy voice with noise still transcribes
check('breathy voice', transcribe(sing([[0, 0, 0.35, { vibrato: 0.2 }], [2, 2, 0.35, { vibrato: 0.2 }], [4, 4, 0.35, { vibrato: 0.2 }], null], 0.12)),
  'Sa Re Ga');

// 8. Tanpura strings are in tune with Sa (first string Pa, Ma or Ni)
const T = require('../tanpura.js');
for (const first of ['Pa', 'Ma', 'Ni']) {
  const freqs = T.stringFreqs(SA, first);
  const cents = freqs.map((f) => {
    const b = T.renderString(f, 48000, { seconds: 1.5 });
    const p = C.detectPitch(b.subarray(24000, 28096), 48000, { minFreq: 50 });
    return Math.abs(1200 * Math.log2(p.freq / f));
  });
  const worst = Math.max(...cents);
  console.log(`${worst < 3 ? 'ok  ' : 'FAIL'} tanpura tuned (${first}): worst ${worst.toFixed(1)}¢`);
  assert.ok(worst < 3);
}

// 9. The Sa of a tanpura recording is found, whatever the key and first string
{
  const sr = 22050;
  let worst = 0;
  for (const [note, oct, first] of [['D', 3, 'Pa'], ['G#', 3, 'Ma'], ['A#', 2, 'Ni'], ['F', 3, 'Pa']]) {
    const sa = C.noteFreq(note, oct), strings = T.stringFreqs(sa, first).map((f, i) => T.renderString(f, sr, { seconds: 4, seed: i + 3 }));
    const x = new Float32Array(sr * 10);
    for (let k = 0, t = 0; t < 9.5; k++, t += 1.05) { const b = strings[k % 4], s = Math.floor(t * sr); for (let i = 0; i < b.length && s + i < x.length; i++) x[s + i] += 0.2 * b[i]; }
    const got = T.detectRecordingSa(x, sr, C.detectPitch).cents, want = ((1200 * Math.log2(sa / 440)) % 1200 + 1200) % 1200;
    worst = Math.max(worst, Math.abs(((got - want + 1800) % 1200 + 1200) % 1200 - 600));
  }
  console.log(`${worst < 10 ? 'ok  ' : 'FAIL'} recording Sa detection: worst ${worst.toFixed(1)}¢`);
  assert.ok(worst < 10);
}

// 10. Playback plan: timing kept, legato joins, meend slides, long pauses shortened
{
  const sw = (semi) => C.swarFor(semi);
  const items = [
    { kind: 'main', swar: sw(0), start: 1.0, end: 1.48 },
    { kind: 'kan', swar: sw(4), start: 1.5, end: 1.56 },
    { kind: 'main', swar: sw(2), start: 1.58, end: 2.0 },
    { kind: 'main', swar: sw(7), start: 2.3, end: 2.7 },
    { kind: 'main', swar: sw(4), meend: true, start: 2.8, end: 3.2 },
    { kind: 'gap' },
    { kind: 'main', swar: sw(0), start: 8.0, end: 8.5 },
  ];
  const plan = C.playbackPlan(items);
  assert.strictEqual(plan.length, 3, 'three phrases (break after Re, pause before last Sa)');
  assert.strictEqual(plan[0].t0, 0, 'starts at 0');
  assert.ok(Math.abs(plan[0].notes[0].t1 - 0.5) < 1e-9, 'Sa joined legato to the kan swar');
  const m = plan[1].points.filter((p) => p.glide);
  assert.ok(m.some((p) => p.semi === 4), 'meend slides into Ga');
  assert.ok(Math.abs(plan[2].t0 - plan[1].t1 - 0.8) < 1e-9, 'long pause shortened to 0.8 s');
  const slow = C.playbackPlan(items, { speed: 0.5 });
  assert.ok(Math.abs(slow[0].notes[2].t0 - 2 * plan[0].notes[2].t0) < 1e-9, 'half speed doubles the timing');
  console.log('ok   playback plan');
}

// 11. Tanpura heard through the speakers is not written down, and the voice still is
{
  const sr = 44100, secs = 14, sa = SA;
  const strings = T.stringFreqs(sa, 'Pa').map((f, i) => T.renderString(f, sr, { seconds: 6, seed: i + 5 }));
  const out = new Float32Array(secs * sr);
  for (let k = 0, t = 0; t < secs; k++, t += 1.1) { const b = strings[k % 4], s = Math.floor(t * sr); for (let i = 0; i < b.length && s + i < out.length; i++) out[s + i] += 0.1 * b[i]; }
  const voice = sing([[null, null, 3.5], [0, 0, 0.5, { vibrato: 0.2 }], [4, 4, 0.5, { vibrato: 0.2 }], [7, 7, 0.6, { vibrato: 0.2 }], [null, null, 0.7], [5, 5, 0.5, { vibrato: 0.2 }], [2, 2, 0.5, { vibrato: 0.2 }], [0, 0, 0.7, { vibrato: 0.2 }], null]);
  const D = Math.floor(0.05 * sr), mic = new Float32Array(secs * sr);
  for (let i = 0; i < mic.length; i++) mic[i] = (i < voice.length ? 0.25 * voice[i] : 0) + 0.7 * (i >= D ? out[i - D] : 0);
  const run = (useGate) => {
    const FRAME = 2048, HOP = 735, items = [], byId = {}, gate = new C.LeakGate();
    const seg = new C.Segmenter((e) => {
      if (e.type === 'gap') items.push({ kind: 'gap' });
      else if (e.type === 'note') { byId[e.id] = { kind: 'pending', swar: e.swar, meend: e.meend }; items.push(byId[e.id]); }
      else if (e.type === 'main') byId[e.id].kind = 'main'; else if (e.type === 'end') byId[e.id].kind = e.kind;
    });
    let t = 0;
    for (let i = 0; i + FRAME < mic.length; i += HOP) {
      const fr = mic.subarray(i, i + FRAME), rms = C.rms(fr); t = i / sr;
      let o = 0; for (let j = Math.max(0, i - 6615); j <= i; j += HOP) o = Math.max(o, C.rms(out.subarray(j, j + FRAME)));
      const p = rms > 0.01 ? C.detectPitch(fr, sr) : null, semi = p ? C.semitonesFromSa(p.freq, sa) : null;
      if (t < 3) { if (useGate) gate.learn(rms, o, semi); continue; }
      if (useGate && !gate.ready) gate.finish();
      let x = p ? semi : rms > 0.01 ? undefined : null;
      if (useGate && !gate.accept(rms, semi, o)) x = null;
      seg.push(t, x);
    }
    seg.flush(t);
    return C.notationText(items).replace(/\n/g, ' ');
  };
  const without = run(false), filtered = run(true);
  assert.notStrictEqual(without, filtered, 'the leak must actually cause stray notes without the filter');
  console.log('     (without filter: ' + without + ')');
  check('tanpura leak filtered out', filtered, 'Sa Ga Pa | Ma Re Sa');
}

assert.strictEqual(C.westernName(C.noteFreq('A', 4)), 'A4');
console.log('all tests passed');
