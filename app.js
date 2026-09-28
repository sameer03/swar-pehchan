/* app.js — UI for Swar Pehchaan. Depends on swar-core.js (window.SwarCore). */
(function () {
  'use strict';
  const C = window.SwarCore;
  const $ = (id) => document.getElementById(id);

  const els = {
    micBtn: $('micBtn'), micLabel: $('micLabel'),
    saNote: $('saNote'), saOct: $('saOct'), saHz: $('saHz'),
    setSaBtn: $('setSaBtn'), droneBtn: $('droneBtn'),
    minDur: $('minDur'), minDurVal: $('minDurVal'),
    nowSwar: $('nowSwar'), nowDetail: $('nowDetail'), needle: $('meterNeedle'),
    trace: $('trace'), transcript: $('transcript'),
    copyBtn: $('copyBtn'), clearBtn: $('clearBtn'),
    fileIn: $('fileIn'), fileStatus: $('fileStatus'),
  };

  const SILENCE_RMS = 0.01;
  let ctx = null, stream = null, analyser = null, rafId = 0, buf = null;
  let saFreq = 0;
  let calibrating = null; // { until, samples: [] }
  let drone = null;
  const history = []; // { t, semi } for the trace
  const TRACE_SECONDS = 8;

  /* ---------- Sa selection ---------- */
  C.WESTERN.forEach((n) => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    els.saNote.appendChild(o);
  });
  els.saNote.value = 'C#';

  function updateSa(freq) {
    saFreq = freq || C.noteFreq(els.saNote.value, +els.saOct.value);
    els.saHz.textContent = saFreq.toFixed(1) + ' Hz';
    if (drone) { stopDrone(); startDrone(); }
  }
  els.saNote.addEventListener('change', () => updateSa());
  els.saOct.addEventListener('change', () => updateSa());
  updateSa();

  /* ---------- Segmenter & transcript ---------- */
  const notes = []; // {type:'note', swar} | {type:'gap'}
  let hasContent = false;

  const segmenter = new C.Segmenter(onEvent, { minDuration: 0.12 });
  els.minDur.addEventListener('input', () => {
    segmenter.minDuration = +els.minDur.value / 1000;
    els.minDurVal.textContent = els.minDur.value + ' ms';
  });

  function markAttrs(el, s) {
    el.classList.toggle('komal', !!s.komal);
    let top = '';
    if (s.tivra) top += '|';
    if (s.octave > 0) top += '•'.repeat(s.octave);
    el.setAttribute('data-top', top);
    el.setAttribute('data-bot', s.octave < 0 ? '•'.repeat(-s.octave) : '');
  }

  function onEvent(e) {
    if (e.type === 'gap' && (!notes.length || notes[notes.length - 1].type === 'gap')) return;
    notes.push(e);
    if (!hasContent) { els.transcript.innerHTML = ''; hasContent = true; }
    if (e.type === 'gap') {
      const b = document.createElement('span');
      b.className = 'bar'; b.textContent = '|';
      els.transcript.appendChild(b);
    } else {
      const prev = els.transcript.querySelector('.fresh');
      if (prev) prev.classList.remove('fresh');
      const sp = document.createElement('span');
      sp.className = 'sw fresh';
      sp.textContent = e.swar.name;
      sp.title = C.swarText(e.swar);
      markAttrs(sp, e.swar);
      els.transcript.appendChild(sp);
      els.transcript.appendChild(document.createTextNode(' '));
    }
  }

  function clearTranscript() {
    notes.length = 0; hasContent = false; segmenter.reset();
    els.transcript.innerHTML = '<span class="muted">Notes you sing appear here. A pause starts a new phrase.</span>';
  }
  els.clearBtn.addEventListener('click', clearTranscript);

  function transcriptText() {
    return notes.map((n) => (n.type === 'gap' ? '|' : C.swarText(n.swar)))
      .join(' ').replace(/\s*\|\s*$/, '').replace(/ \| /g, ' |\n');
  }
  els.copyBtn.addEventListener('click', async () => {
    const txt = transcriptText();
    if (!txt) return;
    try { await navigator.clipboard.writeText(txt); flash(els.copyBtn, 'Copied'); }
    catch { flash(els.copyBtn, 'Copy failed'); }
  });
  function flash(btn, msg) {
    const old = btn.textContent; btn.textContent = msg;
    setTimeout(() => (btn.textContent = old), 1200);
  }

  /* ---------- Microphone ---------- */
  async function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  async function startMic() {
    try {
      await ensureCtx();
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      els.nowDetail.textContent = 'Microphone blocked. Allow mic access and open the page over https or localhost.';
      return;
    }
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    buf = new Float32Array(analyser.fftSize);
    segmenter.reset();
    els.micBtn.setAttribute('aria-pressed', 'true');
    els.micLabel.textContent = 'Stop';
    els.nowDetail.textContent = 'Listening…';
    loop();
  }

  function stopMic() {
    cancelAnimationFrame(rafId);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; analyser = null;
    els.micBtn.setAttribute('aria-pressed', 'false');
    els.micLabel.textContent = 'Start listening';
    showNow(null);
  }

  els.micBtn.addEventListener('click', () => (stream ? stopMic() : startMic()));

  function loop() {
    rafId = requestAnimationFrame(loop);
    analyser.getFloatTimeDomainData(buf);
    const t = ctx.currentTime;
    let freq = null;
    if (C.rms(buf) > SILENCE_RMS) {
      const p = C.detectPitch(buf, ctx.sampleRate);
      if (p) freq = p.freq;
    }

    if (calibrating) {
      if (freq) calibrating.samples.push(freq);
      const left = Math.max(0, calibrating.until - performance.now());
      els.nowDetail.textContent = `Hold your Sa… ${(left / 1000).toFixed(1)}s`;
      if (left <= 0) finishCalibration();
      return;
    }

    const semi = freq ? C.semitonesFromSa(freq, saFreq) : null;
    segmenter.push(t, semi);
    history.push({ t, semi });
    while (history.length && t - history[0].t > TRACE_SECONDS) history.shift();
    showNow(freq, semi);
    drawTrace(t);
  }

  function showNow(freq, semi) {
    if (!freq) {
      els.nowSwar.textContent = '—';
      markAttrs(els.nowSwar, { octave: 0 });
      els.needle.style.left = '50%';
      els.needle.classList.remove('in-tune');
      if (stream && !calibrating) els.nowDetail.textContent = 'Listening…';
      return;
    }
    const r = Math.round(semi);
    const s = C.swarFor(r);
    const cents = Math.round((semi - r) * 100);
    els.nowSwar.textContent = s.name;
    markAttrs(els.nowSwar, s);
    els.nowDetail.textContent =
      `${C.swarText(s)} · ${freq.toFixed(1)} Hz · ${C.westernName(freq)} · ${cents >= 0 ? '+' : ''}${cents}¢`;
    els.needle.style.left = 50 + Math.max(-50, Math.min(50, cents)) + '%';
    els.needle.classList.toggle('in-tune', Math.abs(cents) <= 12);
  }

  /* ---------- Sing-your-Sa calibration ---------- */
  els.setSaBtn.addEventListener('click', async () => {
    if (!stream) await startMic();
    if (!stream) return;
    calibrating = { until: performance.now() + 2000, samples: [] };
    els.setSaBtn.setAttribute('aria-pressed', 'true');
  });

  function finishCalibration() {
    const xs = calibrating.samples.sort((a, b) => a - b);
    calibrating = null;
    els.setSaBtn.setAttribute('aria-pressed', 'false');
    if (xs.length < 10) { els.nowDetail.textContent = 'Couldn’t hear a steady note. Try again, a little louder.'; return; }
    const median = xs[xs.length >> 1];
    // Snap the dropdowns to the nearest western note, but keep the exact sung frequency as Sa.
    const midi = Math.round(69 + 12 * Math.log2(median / 440));
    els.saNote.value = C.WESTERN[((midi % 12) + 12) % 12];
    const oct = Math.floor(midi / 12) - 1;
    if ([...els.saOct.options].some((o) => +o.value === oct)) els.saOct.value = String(oct);
    updateSa(median);
    segmenter.reset();
    els.nowDetail.textContent = `Sa set to ${median.toFixed(1)} Hz (≈ ${C.westernName(median)})`;
  }

  /* ---------- Tanpura-ish drone ---------- */
  async function startDrone() {
    await ensureCtx();
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.6);
    g.connect(ctx.destination);
    const oscs = [
      [saFreq / 2, 'sawtooth', 0.35], [saFreq * 1.5 / 2, 'sawtooth', 0.25], [saFreq, 'triangle', 0.5],
    ].map(([f, type, amp]) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200;
      const og = ctx.createGain(); og.gain.value = amp;
      o.connect(lp).connect(og).connect(g); o.start();
      return o;
    });
    drone = { g, oscs };
    els.droneBtn.setAttribute('aria-pressed', 'true');
  }
  function stopDrone() {
    if (!drone) return;
    const { g, oscs } = drone;
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    oscs.forEach((o) => o.stop(ctx.currentTime + 0.35));
    drone = null;
    els.droneBtn.setAttribute('aria-pressed', 'false');
  }
  els.droneBtn.addEventListener('click', () => (drone ? stopDrone() : startDrone()));

  /* ---------- Pitch trace ---------- */
  const tctx = els.trace.getContext('2d');
  const LOW = -5, HIGH = 17; // from mandra Ma to taar Ma
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function drawTrace(now) {
    const c = els.trace, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.clearRect(0, 0, w, h);
    const left = 44, y = (s) => h - 6 - ((s - LOW) / (HIGH - LOW)) * (h - 12);

    tctx.font = '10.5px Inter, system-ui, sans-serif';
    tctx.textBaseline = 'middle';
    for (let s = LOW; s <= HIGH; s++) {
      const sw = C.swarFor(s);
      const isSa = sw.idx === 0;
      tctx.strokeStyle = cssVar(isSa ? '--grid-sa' : '--grid');
      tctx.lineWidth = isSa ? 1.5 : 1;
      tctx.beginPath(); tctx.moveTo(left, y(s)); tctx.lineTo(w, y(s)); tctx.stroke();
      if (!sw.komal && !sw.tivra) {
        tctx.fillStyle = cssVar('--muted');
        tctx.fillText(C.swarText(sw), 2, y(s));
      }
    }

    tctx.strokeStyle = cssVar('--trace');
    tctx.lineWidth = 2.5; tctx.lineJoin = 'round';
    tctx.beginPath();
    let pen = false;
    for (const p of history) {
      const x = left + (1 - (now - p.t) / TRACE_SECONDS) * (w - left);
      if (p.semi === null || p.semi < LOW - 1 || p.semi > HIGH + 1) { pen = false; continue; }
      pen ? tctx.lineTo(x, y(p.semi)) : tctx.moveTo(x, y(p.semi));
      pen = true;
    }
    tctx.stroke();
  }
  window.addEventListener('resize', () => drawTrace(ctx ? ctx.currentTime : 0));
  drawTrace(0);

  /* ---------- File analysis ---------- */
  els.fileIn.addEventListener('change', async () => {
    const file = els.fileIn.files[0];
    if (!file) return;
    if (stream) stopMic();
    els.fileStatus.textContent = 'Decoding…';
    try {
      await ensureCtx();
      const audio = await ctx.decodeAudioData(await file.arrayBuffer());
      await analyseBuffer(audio, file.name);
    } catch (err) {
      els.fileStatus.textContent = 'Could not read that file.';
    }
    els.fileIn.value = '';
  });

  async function analyseBuffer(audio, name) {
    // Mix to mono
    const n = audio.length, mono = new Float32Array(n);
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const d = audio.getChannelData(ch);
      for (let i = 0; i < n; i++) mono[i] += d[i] / audio.numberOfChannels;
    }
    // Downsample to ~11 kHz: plenty for voice, and ~16x faster pitch tracking
    const q = Math.max(1, Math.floor(audio.sampleRate / 11025));
    const data = C.decimate(mono, q), sr = audio.sampleRate / q;
    const FRAME = 1024, HOP = 128;

    // Loudness gate relative to the recording's own level
    let peak = 0;
    for (let i = 0; i + FRAME < data.length; i += HOP * 8) peak = Math.max(peak, C.rms(data.subarray(i, i + FRAME)));
    const gate = Math.max(0.005, peak * 0.08);

    clearTranscript();
    segmenter.reset();
    const total = data.length;
    let i = 0;
    await new Promise((resolve) => {
      function chunk() {
        const end = Math.min(total - FRAME, i + HOP * 400);
        for (; i < end; i += HOP) {
          const fr = data.subarray(i, i + FRAME);
          const t = i / sr;
          if (C.rms(fr) < gate) { segmenter.push(t, null); continue; }
          const p = C.detectPitch(fr, sr);
          segmenter.push(t, p ? C.semitonesFromSa(p.freq, saFreq) : null);
        }
        els.fileStatus.textContent = `Analysing ${name}… ${Math.round((i / total) * 100)}%`;
        if (i < total - FRAME) setTimeout(chunk, 0); else resolve();
      }
      chunk();
    });
    segmenter.push(total / sr + 1, null);
    const count = notes.filter((x) => x.type === 'note').length;
    els.fileStatus.textContent = `${name}: ${count} notes found.`;
  }
})();
