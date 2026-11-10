import { FFT, findPeaks, KeyEngine, estimateTuning } from './dsp.js';
import { analyzeEngine, describe, spellScale, refineMinor, SCALES, FIFTHS, TITLE_WORD } from './theory.js';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';

const LIVE_HALF_LIFE = 30; // seconds: older music fades so a new song takes over
const QUIET_DB = -62; // input RMS below this counts as silence
const FIRST_READ = 6; // seconds of music before the first answer
const EARLY_READ = 15; // answers before this are labelled "early read"
const TICK_MS = 150;
const SWITCH_AFTER = 3; // consecutive evaluations a new key must win before it replaces the shown one

const CHAR_DEGREES = { dorian: [5], phrygian: [1], lydian: [3], mixolydian: [6], harmonicMinor: [6], melodicMinor: [5, 6] };
const CONF_TEXT = { strong: 'Strong match', likely: 'Likely', close: 'Close call', early: 'Early read' };
const SIGNAL = '#ff4429';

const state = {
  mode: 'idle', // idle | listening | analyzing
  engine: null,
  ctx: null,
  master: null,
  stream: null,
  nodes: null,
  timer: null,
  wake: null,
  last: 0,
  tick: 0,
  shown: null,
  pending: null,
  pendingCount: 0,
  muteUntil: 0,
  current: null, // { desc, analysis, tuning }
  pick: null, // id of the scale the user selected among the closest three
  last3: null, // last render inputs, so a pick can re-render without new audio
  deferredInstall: null,
  updateRequested: false,
};

/* ---------- Audio context (shared by mic and preview synth) ---------- */

function ensureCtx() {
  if (!state.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    state.ctx = new AC();
    state.master = state.ctx.createGain();
    state.master.gain.value = 0.8;
    state.master.connect(state.ctx.destination);
  }
  if (state.ctx.state === 'suspended') state.ctx.resume().catch(() => {});
  return state.ctx;
}

/* ---------- Waveform strip ---------- */

const wave = { el: null, g: null, w: 0, h: 0, dpr: 1, history: [], ref: 0.02, overview: null, progress: 0.64, mode: 'example' };

function sizeWave() {
  const r = wave.el.getBoundingClientRect();
  wave.dpr = Math.min(3, window.devicePixelRatio || 1);
  wave.w = Math.max(1, Math.round(r.width * wave.dpr));
  wave.h = Math.max(1, Math.round(r.height * wave.dpr));
  wave.el.width = wave.w;
  wave.el.height = wave.h;
  drawWave();
}

function exampleOverview(n = 220) {
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => {
    const env = 0.45 + 0.35 * Math.sin(i / 9) * Math.sin(i / 23);
    return Math.max(0.06, Math.min(1, env * (0.35 + rnd() * 0.9)));
  });
}

function drawWave() {
  const { g, w, h, dpr } = wave;
  if (!g) return;
  g.clearRect(0, 0, w, h);
  const step = 4 * dpr;
  const bw = 1.5 * dpr;
  const mid = h * 0.58;
  const maxH = h * 0.8;
  let px;
  let bars = [];
  if (wave.mode === 'live') {
    px = Math.round(w * 0.64);
    const hist = wave.history;
    for (let k = 0, x = px; x >= 0; k++, x -= step) bars.push([x, hist[hist.length - 1 - k] || 0]);
  } else {
    const ov = wave.overview || [];
    px = Math.round(w * Math.max(0, Math.min(1, wave.progress)));
    const n = Math.floor(w / step);
    for (let i = 0; i <= n; i++) {
      const x = i * step + step / 2;
      if (x > px) break;
      const v = ov.length ? ov[Math.min(ov.length - 1, Math.floor((i / n) * ov.length))] : 0;
      bars.push([x, v]);
    }
  }
  // Shaded windows behind the bars: grey (earlier) and red (what is being analyzed now).
  const redW = w * 0.2, greyW = w * 0.22;
  g.fillStyle = 'rgba(0,0,0,0.045)';
  g.fillRect(Math.max(0, px - redW - greyW), 0, Math.max(0, Math.min(greyW, px - redW)), h * 0.52);
  const grad = g.createLinearGradient(0, 0, 0, h * 0.56);
  grad.addColorStop(0, 'rgba(255,68,41,0.95)');
  grad.addColorStop(1, 'rgba(255,68,41,0)');
  g.fillStyle = grad;
  g.fillRect(Math.max(0, px - redW), 0, Math.min(redW, px), h * 0.56);

  g.fillStyle = '#111';
  for (const [x, v] of bars) {
    const bh = Math.max(1.5 * dpr, v * maxH);
    g.fillRect(x - bw / 2, mid - bh / 2, bw, bh);
  }
  g.fillStyle = '#a3a3a3';
  for (let x = px + step; x < w; x += step) g.fillRect(x - 0.6 * dpr, mid - 0.6 * dpr, 1.2 * dpr, 1.2 * dpr);

  g.fillStyle = SIGNAL;
  g.fillRect(px - 0.75 * dpr, 4 * dpr, 1.5 * dpr, h - 4 * dpr);
  g.beginPath();
  g.arc(px, 4 * dpr, 3 * dpr, 0, Math.PI * 2);
  g.fill();
}

function pushLevels(time) {
  const N = time.length;
  const seg = 2400;
  for (let c = 3; c >= 1; c--) {
    let pk = 0;
    for (let i = N - c * seg; i < N - (c - 1) * seg; i++) {
      const v = Math.abs(time[i]);
      if (v > pk) pk = v;
    }
    wave.ref = Math.max(0.02, wave.ref * 0.995, pk);
    wave.history.push(Math.min(1, Math.sqrt(pk / wave.ref)));
  }
  if (wave.history.length > 600) wave.history.splice(0, wave.history.length - 600);
}

/* ---------- Record (circle of fifths) ---------- */

const dial = { maj: [], min: [], majLabel: [], minLabel: [], petals: [] };

function svg(tag, attrs, parent) {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}

function sector(r0, r1, a0, a1) {
  const c = 200;
  const pt = (r, a) => `${(c + r * Math.sin(a)).toFixed(2)} ${(c - r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${pt(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${pt(r1, a1)}L${pt(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${pt(r0, a0)}Z`;
}

const majorLabel = (pc) => spellScale(pc, SCALES.major.steps)[0].name;
const minorLabel = (pc) => spellScale(pc, SCALES.minor.steps)[0].name + 'm';

function buildDial() {
  const root = $('dial');
  const deg = Math.PI / 180;
  svg('circle', { cx: 200, cy: 200, r: 198, class: 'disc' }, root);
  for (let r = 70; r <= 196; r += 3.2) svg('circle', { cx: 200, cy: 200, r: r.toFixed(1), class: 'groove' }, root);
  FIFTHS.forEach((pc, i) => {
    const a = i * 30 * deg;
    const a0 = a - 14 * deg, a1 = a + 14 * deg;
    const minPc = (pc + 9) % 12;
    dial.maj[pc] = svg('path', { d: sector(154, 194, a0, a1), class: 'seg', 'fill-opacity': 0 }, root);
    dial.min[minPc] = svg('path', { d: sector(110, 150, a0, a1), class: 'seg', 'fill-opacity': 0 }, root);
    const lm = svg('text', { x: 200 + 174 * Math.sin(a), y: 200 - 174 * Math.cos(a), class: 'seg-label maj' }, root);
    lm.textContent = majorLabel(pc);
    dial.majLabel[pc] = lm;
    const ln = svg('text', { x: 200 + 130 * Math.sin(a), y: 200 - 130 * Math.cos(a), class: 'seg-label min' }, root);
    ln.textContent = minorLabel(minPc);
    dial.minLabel[minPc] = ln;
    dial.petals[pc] = { el: svg('path', { d: '', class: 'petal' }, root), a };
  });
  svg('circle', { cx: 200, cy: 200, r: 60, class: 'label' }, root);
  dial.lTop = svg('text', { x: 200, y: 168, class: 'label-text big' }, root);
  dial.lLeft = svg('text', { x: 168, y: 201, class: 'label-text' }, root);
  dial.lRight = svg('text', { x: 232, y: 201, class: 'label-text' }, root);
  dial.lBottom = svg('text', { x: 200, y: 233, class: 'label-text' }, root);
  svg('circle', { cx: 200, cy: 200, r: 5.5, class: 'spindle' }, root);
}

function drawPetals(chroma, desc) {
  const max = Math.max(...chroma, 1e-9);
  const deg = Math.PI / 180;
  for (let pc = 0; pc < 12; pc++) {
    const { el, a } = dial.petals[pc];
    const v = chroma[pc] / max;
    const r1 = 66 + Math.max(0.05, v) * 38;
    el.setAttribute('d', sector(65, r1, a - 7 * deg, a + 7 * deg));
    const cls = !desc ? 'petal in' : pc === desc.tonic ? 'petal tonic' : desc.pcs.has(pc) ? 'petal in' : 'petal';
    el.setAttribute('class', cls);
  }
}

function shortTuning(cents) {
  if (cents === null || cents === undefined) return 'A440';
  const c = Math.round(cents);
  return Math.abs(c) < 3 ? 'A440' : `${c > 0 ? '+' : '−'}${Math.abs(c)}¢`;
}

function drawRecord(analysis, desc, tuning) {
  const best = new Map();
  if (analysis) {
    for (const k of analysis.ranked) {
      const id = k.quality + k.tonic;
      if (!best.has(id)) best.set(id, k.r);
    }
  }
  const top = analysis ? analysis.ranked[0].r : 0;
  for (let pc = 0; pc < 12; pc++) {
    for (const q of ['major', 'minor']) {
      const seg = q === 'major' ? dial.maj[pc] : dial.min[pc];
      const label = q === 'major' ? dial.majLabel[pc] : dial.minLabel[pc];
      const isBest = !!desc && desc.tonic === pc && desc.quality === q;
      let op = 0;
      if (analysis && best.has(q + pc)) {
        const t = Math.max(0, Math.min(1, (best.get(q + pc) - (top - 0.45)) / 0.45));
        op = 0.5 * t * t;
      }
      seg.setAttribute('fill-opacity', isBest ? 1 : op.toFixed(3));
      seg.classList.toggle('best', isBest);
      label.classList.toggle('on', isBest);
    }
  }
  dial.lTop.textContent = desc ? desc.title.toUpperCase() : 'LISTENING';
  dial.lLeft.textContent = desc ? desc.camelot : '—';
  dial.lRight.textContent = desc ? shortTuning(tuning) : '—';
  dial.lBottom.textContent = desc ? desc.scaleName.replace('Natural ', '').toUpperCase() : 'TONIC';
}

/* ---------- Piano ---------- */

const pianoKeys = [];
function buildPiano() {
  const root = $('piano');
  const W = 28, H = 110;
  const whitePcs = [0, 2, 4, 5, 7, 9, 11];
  for (let o = 0; o < 2; o++) {
    whitePcs.forEach((pc, i) => {
      const x = 0.5 + (o * 7 + i) * W;
      const rect = svg('rect', { x, y: 0.5, width: W, height: H, rx: 4, class: 'w' }, root);
      const label = svg('text', { x: x + W / 2, y: H - 10, class: 'pl' }, root);
      pianoKeys.push({ pc, rect, label, white: true });
    });
  }
  for (let o = 0; o < 2; o++) {
    [[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]].forEach(([pc, after]) => {
      const x = 0.5 + (o * 7 + after) * W - 9;
      const rect = svg('rect', { x, y: 0.5, width: 18, height: 68, rx: 3, class: 'b' }, root);
      const dot = svg('circle', { cx: x + 9, cy: 56, r: 3, class: 'bd' }, root);
      pianoKeys.push({ pc, rect, dot, white: false });
    });
  }
}

function drawPiano(desc) {
  const names = new Map(desc.notes.map((n) => [n.pc, n.name]));
  for (const k of pianoKeys) {
    const base = k.white ? 'w' : 'b';
    const cls = k.pc === desc.tonic ? `${base} tonic` : desc.pcs.has(k.pc) ? `${base} in` : `${base} out`;
    k.rect.setAttribute('class', cls);
    if (k.dot) k.dot.setAttribute('class', desc.pcs.has(k.pc) && k.pc !== desc.tonic ? 'bd on' : 'bd');
    if (k.label) {
      k.label.textContent = names.get(k.pc) || '';
      k.label.setAttribute('class', k.pc === desc.tonic ? 'pl tonic' : 'pl');
    }
  }
}

/* ---------- Readout ---------- */

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function setKeyName(desc) {
  const key = $('key-name');
  key.replaceChildren();
  key.append(desc.tonicName, ' ', el('span', 'word', TITLE_WORD[desc.scaleId]));
}

function setConfidence(level, seconds, margin) {
  let pct;
  if (level === 'early') pct = Math.min(60, (seconds / EARLY_READ) * 60);
  else pct = Math.max(8, Math.min(100, (margin / 0.16) * 100));
  $('conf-fill').style.width = pct.toFixed(0) + '%';
  $('conf-tick').style.left = pct.toFixed(0) + '%';
  $('conf-label').textContent = CONF_TEXT[level];
}


/** The shown scale plus the next two distinct scales (tonic + scale type), with relative match. */
function closestScales(analysis, shown) {
  const { ranked, chroma } = analysis;
  const typed = ranked.map((k) => ({ ...k, scale: refineMinor(chroma, k.tonic, k.type) }));
  const hit = typed.find((k) => k.tonic === shown.tonic && k.scale === shown.scaleId);
  const top = hit ? hit.r : ranked[0].r;
  const pct = (r) => Math.max(1, Math.min(100, Math.round(((r - (top - 0.45)) / 0.45) * 100)));
  const list = [{ id: `${shown.tonic}:${shown.scaleId}`, desc: shown, pct: 100 }];
  for (const k of typed) {
    if (list.length === 3) break;
    const id = `${k.tonic}:${k.scale}`;
    if (list.some((o) => o.id === id)) continue;
    list.push({ id, desc: describe(k.tonic, k.scale), pct: pct(k.r) });
  }
  return list;
}

function renderPicker(options, selectedId) {
  const wrap = $('scales');
  wrap.replaceChildren();
  options.forEach((o, i) => {
    const b = el('button');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(o.id === selectedId));
    b.setAttribute('aria-label', `${o.desc.title}, ${i === 0 ? 'best match' : `${o.pct} percent of the best match`}`);
    const sn = el('span', 'sn', o.desc.title);
    const sp = el('span', 'sp');
    if (i === 0) sp.append(el('b', '', 'Best'), ` · ${o.pct}%`);
    else sp.append(`${o.pct}%`);
    b.append(sn, sp);
    b.addEventListener('click', () => {
      state.pick = o.id;
      if (state.last3) renderResult(...state.last3);
    });
    wrap.append(b);
  });
}

function renderResult(analysis, shownDesc, opts) {
  state.last3 = [analysis, shownDesc, opts];
  const { confidence, sourceText, tuning } = opts;
  const options = closestScales(analysis, shownDesc);
  const selected = options.find((o) => o.id === state.pick) || options[0];
  const desc = selected.desc;
  const isAlt = selected !== options[0];
  renderPicker(options, selected.id);
  const app = $('app');
  app.classList.remove('pending');
  setKeyName(desc);

  const scaleText = {
    major: 'Major scale · Ionian mode',
    minor: 'Natural minor scale · Aeolian mode',
  }[desc.scaleId] || `${desc.scaleName} · ${desc.scaleDetail.toLowerCase()}`;
  $('scale-line').textContent = scaleText;
  $('source').textContent = sourceText;

  $('track-title').textContent = desc.title;
  $('track-sub').textContent = desc.sibling.label === 'Relative' ? `Relative · ${desc.sibling.name}` : `${desc.sibling.label} ${desc.sibling.name}`;
  if (isAlt) {
    $('conf-fill').style.width = selected.pct + '%';
    $('conf-tick').style.left = selected.pct + '%';
    $('conf-label').textContent = `${selected.pct}% of best`;
  } else {
    setConfidence(confidence, analysis.seconds, analysis.margin);
  }
  const tuneText = tuning === null || Math.abs(tuning) < 3 ? '' : ` · A4 ${(440 * Math.pow(2, tuning / 1200)).toFixed(1)}`;
  $('tuning').textContent = `Camelot ${desc.camelot}${tuneText}`;

  const chars = CHAR_DEGREES[desc.scaleId] || [];
  const notes = $('notes');
  notes.replaceChildren();
  desc.notes.forEach((n, i) => {
    const li = el('li');
    const pill = el('span', 'note-pill' + (i === 0 ? ' tonic' : '') + (chars.includes(i) ? ' char' : ''));
    pill.append(n.name, el('span', 'deg', n.degree));
    li.append(pill);
    notes.append(li);
  });
  $('notes-sub').textContent = chars.length
    ? `The outlined note (${chars.map((i) => desc.notes[i].name).join(', ')}) is what gives ${desc.title.split(' ').slice(1).join(' ')} its sound.`
    : 'The seven notes that fit this key. Numbers are scale degrees.';
  drawPiano(desc);

  const chords = $('chords');
  chords.replaceChildren();
  desc.chords.forEach((c) => {
    const li = el('li');
    const b = el('button', 'chord');
    b.type = 'button';
    b.setAttribute('aria-label', `Play ${c.name}, the ${c.roman} chord`);
    b.append(el('span', 'rn', c.roman), c.name);
    b.addEventListener('click', () => playChord(desc, c, b));
    li.append(b);
    chords.append(li);
  });

  drawRecord(analysis, desc, tuning);
  drawPetals(analysis.chroma, desc);
  state.current = { desc, analysis, tuning };
}

function renderPending(title, detail, sourceText) {
  $('app').classList.add('pending');
  $('key-name').textContent = title;
  $('scale-line').textContent = detail;
  $('source').textContent = sourceText;
  $('track-title').textContent = '—';
  $('track-sub').textContent = 'Waiting for a first read';
  drawRecord(null, null, null);
  state.current = null;
}

function setStatus(kind, text) {
  const notice = $('notice');
  if (kind === 'error') {
    notice.textContent = text;
    notice.hidden = false;
    $('status-text').textContent = 'Stopped';
  } else {
    notice.hidden = true;
    $('status-text').textContent = text;
  }
}

function setClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const p = (n) => String(n).padStart(2, '0');
  $('clock').textContent = `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function setListeningUI(on) {
  $('app').classList.toggle('listening', on);
  $('listen').classList.toggle('on', on);
  $('listen-label').textContent = on ? 'Live' : 'Listen';
  $('stop').disabled = !on;
}

/* ---------- Live listening ---------- */

const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();

function micUnavailableMessage() {
  if (!window.isSecureContext) return 'The microphone needs a secure (https) page. Open Tonic from its https address, or analyze a file instead.';
  return "This browser view can't use the microphone. Open Tonic in Safari or Chrome (or the installed app), or analyze a file instead.";
}

function micErrorMessage(err) {
  const name = err && err.name;
  if (inFrame && (name === 'NotAllowedError' || name === 'SecurityError')) {
    return "The microphone isn't available inside this embedded preview. Open Tonic at its own web address to listen. File analysis works here.";
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow it for this site in your browser settings, then tap Listen again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Connect one, or analyze a file instead.';
  if (name === 'NotReadableError') return 'The microphone is busy in another app. Close that app and tap Listen again.';
  return micUnavailableMessage();
}

async function startListening() {
  if (state.mode !== 'idle') return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('error', micUnavailableMessage());
    return;
  }
  const ctx = ensureCtx(); // created inside the tap so iOS allows audio
  setStatus('idle', 'Asking for the mic…');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    setStatus('error', micErrorMessage(err));
    return;
  }
  try { await ctx.resume(); } catch { /* resumed on next tap */ }

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 32768;
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = -130;
  analyser.maxDecibels = 0;
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(analyser);
  analyser.connect(sink);
  sink.connect(ctx.destination); // keeps the graph pulled on Safari; silent

  const binHz = ctx.sampleRate / analyser.fftSize;
  const maxBin = Math.min(analyser.frequencyBinCount - 1, Math.ceil(1900 / binHz) + 2);
  state.nodes = {
    source, analyser, sink, binHz, maxBin,
    time: new Float32Array(analyser.fftSize),
    freq: new Float32Array(analyser.frequencyBinCount),
    mag: new Float32Array(maxBin + 1),
  };
  state.stream = stream;
  stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => {
    if (state.mode === 'listening') stopListening('The microphone stopped (the app may have gone to the background). Tap Listen to continue.');
  }));

  state.engine = new KeyEngine({ halfLife: LIVE_HALF_LIFE });
  state.pick = null;
  state.shown = null;
  state.pending = null;
  state.pendingCount = 0;
  state.tick = 0;
  state.last = performance.now();
  state.mode = 'listening';
  wave.mode = 'live';
  wave.history = [];
  wave.ref = 0.02;
  setListeningUI(true);
  setClock(0);
  renderPending('Listening…', `Play a song near the mic. A first read appears after about ${FIRST_READ} seconds of music.`, 'Live · microphone');
  setStatus('quiet', 'Waiting for music…');
  state.timer = setInterval(tick, TICK_MS);
  requestWakeLock();
}

function stopListening(message) {
  clearInterval(state.timer);
  state.timer = null;
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  if (state.nodes) {
    try { state.nodes.source.disconnect(); state.nodes.analyser.disconnect(); state.nodes.sink.disconnect(); } catch { /* already gone */ }
  }
  state.stream = null;
  state.nodes = null;
  releaseWakeLock();
  const wasListening = state.mode === 'listening';
  state.mode = 'idle';
  setListeningUI(false);
  if (message) setStatus('error', message);
  else if (wasListening) setStatus('idle', state.current ? 'Stopped · result kept' : 'Stopped');
  if (wasListening && !state.current) {
    renderPending('Not enough music', 'Tap Listen and let a song play for at least 10 seconds.', 'Live · microphone');
  } else if (wasListening && state.current) {
    $('source').textContent = `Mic · based on ${Math.round(state.engine.seconds)} s of music`;
  }
}

function tick() {
  const n = state.nodes;
  if (!n) return;
  const now = performance.now();
  const dt = Math.min(0.5, (now - state.last) / 1000);
  state.last = now;

  n.analyser.getFloatTimeDomainData(n.time);
  let s = 0;
  for (let i = 0; i < n.time.length; i += 2) s += n.time[i] * n.time[i];
  const db = 10 * Math.log10(s / (n.time.length / 2) + 1e-12);
  pushLevels(n.time);
  drawWave();

  if (now < state.muteUntil) {
    setStatus('quiet', 'Paused for preview');
    return;
  }
  if (db < QUIET_DB) {
    setStatus('quiet', 'Waiting for music…');
    return;
  }

  n.analyser.getFloatFrequencyData(n.freq);
  for (let i = 0; i <= n.maxBin; i++) {
    const v = n.freq[i];
    n.mag[i] = v > -200 ? Math.pow(10, v / 20) : 0;
  }
  state.engine.add(findPeaks(n.mag, n.binHz), dt);
  setStatus('listening', 'Now listening');
  setClock(state.engine.seconds);

  state.tick++;
  if (state.tick % 6 === 0) evaluateLive();
  else if (!state.current) drawPetals(state.engine.normalized(), null);
}

function sameCollection(a, b) {
  return a.pcs.size === b.pcs.size && [...a.pcs].every((pc) => b.pcs.has(pc));
}

function evaluateLive() {
  const eng = state.engine;
  if (eng.seconds < FIRST_READ) {
    drawPetals(eng.normalized(), null);
    const left = Math.ceil(FIRST_READ - eng.seconds);
    $('scale-line').textContent = `First read in about ${left} second${left === 1 ? '' : 's'}…`;
    return;
  }
  const a = analyzeEngine(eng);
  const id = `${a.best.tonic}:${a.type}`;
  if (!state.shown) {
    state.shown = id;
  } else if (id !== state.shown) {
    if (state.pending === id) state.pendingCount++;
    else { state.pending = id; state.pendingCount = 1; }
    // Re-reading the same notes with a different tonic (relative key, mode) needs more
    // evidence than a real change of song.
    const [st, sty] = state.shown.split(':');
    const sameNotes = sameCollection(describe(Number(st), sty), describe(a.best.tonic, a.type));
    if (state.pendingCount >= (sameNotes ? SWITCH_AFTER * 2 : SWITCH_AFTER)) { state.shown = id; state.pending = null; }
  } else {
    state.pending = null;
  }
  const [tonic, type] = state.shown.split(':');
  const desc = describe(Number(tonic), type);
  const confidence = eng.seconds < EARLY_READ ? 'early' : state.shown === id ? a.confidence : 'close';
  renderResult(a, desc, { confidence, sourceText: `Live · mic · ${Math.round(eng.seconds)} s of music`, tuning: eng.tuningCents });
}

/* ---------- File analysis ---------- */

async function decodeAt(arrayBuffer, rates) {
  let lastErr;
  for (const rate of rates) {
    try {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const off = new OAC(1, rate, rate);
      const copy = arrayBuffer.slice(0);
      return await new Promise((resolve, reject) => {
        const p = off.decodeAudioData(copy, resolve, reject);
        if (p && p.then) p.then(resolve, reject);
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

async function analyzeFile(file) {
  if (!file) return;
  if (state.mode === 'listening') stopListening();
  if (state.mode === 'analyzing') return;
  state.mode = 'analyzing';
  state.pick = null;
  setButtons(true);
  renderPending('Analyzing…', 'Reading the whole song. This takes a few seconds.', `File · ${file.name}`);
  setStatus('analyzing', 'Decoding file…');
  wave.mode = 'file';
  wave.overview = null;
  wave.progress = 0;
  drawWave();

  try {
    const raw = await file.arrayBuffer();
    const audio = await decodeAt(raw, [11025, 22050, 44100]);
    const sr = audio.sampleRate;
    const len = audio.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += ch[i] / audio.numberOfChannels;
    }
    // Overview waveform for the strip.
    const buckets = 220;
    const per = Math.max(1, Math.floor(len / buckets));
    const ov = new Array(buckets).fill(0);
    let gmax = 1e-6;
    for (let b = 0; b < buckets; b++) {
      let pk = 0;
      for (let i = b * per; i < Math.min(len, (b + 1) * per); i += 8) pk = Math.max(pk, Math.abs(mono[i]));
      ov[b] = pk;
      gmax = Math.max(gmax, pk);
    }
    wave.overview = ov.map((v) => Math.sqrt(v / gmax));

    const N = 2 ** Math.round(Math.log2(sr * 0.75));
    const hop = N / 2;
    const fft = new FFT(N);
    const binHz = sr / N;
    const maxBin = Math.ceil(1900 / binHz) + 2;
    const mag = new Float32Array(N / 2);
    const total = Math.max(1, Math.floor(Math.max(0, len - N) / hop) + 1);
    const frames = [];
    for (let f = 0; f < total; f++) {
      const off = f * hop;
      let s = 0;
      for (let i = 0; i < N && off + i < len; i += 4) s += mono[off + i] * mono[off + i];
      if (Math.sqrt(s / (N / 4)) < 0.003) { frames.push(null); continue; }
      fft.magnitudes(mono, off, mag, maxBin);
      frames.push(findPeaks(mag, binHz));
      if (f % 24 === 0) {
        wave.progress = f / total;
        drawWave();
        setStatus('analyzing', `Analyzing · ${Math.round((f / total) * 100)}%`);
        setClock(off / sr);
        await nextFrame();
      }
    }
    const engine = new KeyEngine();
    engine.fixedTuning = estimateTuning(frames);
    for (const fr of frames) engine.add(fr, hop / sr);
    state.engine = engine;
    wave.progress = 1;
    drawWave();
    setClock(len / sr);

    if (engine.seconds < 3) {
      renderPending('No clear notes', 'That file seems silent or has no pitched music. Try another song.', `File · ${file.name}`);
      setStatus('error', 'Could not find enough music in that file.');
    } else {
      const a = analyzeEngine(engine);
      renderResult(a, describe(a.best.tonic, a.type), {
        confidence: a.confidence,
        sourceText: `File · ${file.name}`,
        tuning: engine.tuningCents,
      });
      setStatus('idle', 'Done');
    }
  } catch (err) {
    console.error(err);
    renderPending('Can’t read file', 'Try an MP3, M4A, WAV, FLAC or OGG file. Protected Apple Music downloads can’t be opened.', `File · ${file.name}`);
    setStatus('error', 'That file could not be decoded.');
  } finally {
    state.mode = 'idle';
    setButtons(false);
  }
}

function setButtons(busy) {
  $('listen').disabled = busy;
  $('pick').disabled = busy;
  $('reset').disabled = busy;
}

/* ---------- Preview synth ---------- */

function play(midis, stagger, dur, onEnd) {
  const ctx = ensureCtx();
  const t0 = ctx.currentTime + 0.03;
  midis.forEach((m, i) => {
    const t = t0 + i * stagger;
    const f = 440 * Math.pow(2, (m - 69) / 12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    const o1 = ctx.createOscillator();
    o1.type = 'triangle';
    o1.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = f * 2;
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    o1.connect(g);
    o2.connect(g2).connect(g);
    g.connect(state.master);
    o1.start(t); o2.start(t);
    o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  });
  const ms = ((midis.length - 1) * stagger + dur) * 1000;
  state.muteUntil = performance.now() + ms + 400;
  if (onEnd) setTimeout(onEnd, ms);
}

const tonicMidi = (desc) => 60 + desc.tonic - (desc.tonic > 6 ? 12 : 0);

function playScale() {
  const cur = state.current;
  if (!cur) return;
  const base = tonicMidi(cur.desc);
  const steps = SCALES[cur.desc.scaleId].steps;
  play([...steps.map((s) => base + s), base + 12], 0.24, 0.55);
}

function playChord(desc, chord, button) {
  const root = tonicMidi(desc) + chord.rootStep - 12;
  const notes = [root - 12, root, root + chord.intervals[1], root + chord.intervals[2], root + 12];
  button.classList.add('playing');
  play(notes, 0.018, 1.5, () => button.classList.remove('playing'));
}

async function copyResult() {
  const cur = state.current;
  if (!cur) return;
  const { desc } = cur;
  const text = [
    `${desc.title} (${desc.scaleName}${desc.scaleId === 'major' || desc.scaleId === 'minor' ? '' : ', ' + desc.scaleDetail.toLowerCase()})`,
    `Notes: ${desc.notes.map((n) => n.name).join(' ')}`,
    `Chords: ${desc.chords.map((c) => `${c.roman} ${c.name}`).join(' · ')}`,
    `${desc.sibling.label}: ${desc.sibling.name} · Camelot ${desc.camelot}`,
  ].join('\n');
  const btn = $('copy');
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('done');
    btn.setAttribute('aria-label', 'Copied');
    setTimeout(() => { btn.classList.remove('done'); btn.setAttribute('aria-label', 'Copy the result'); }, 1600);
  } catch {
    setStatus('idle', 'Copy isn’t allowed here');
  }
}

/* ---------- Wake lock, install, service worker ---------- */

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) state.wake = await navigator.wakeLock.request('screen');
  } catch { /* not critical */ }
}
function releaseWakeLock() {
  try { state.wake && state.wake.release(); } catch { /* ignore */ }
  state.wake = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.mode === 'listening' && !state.wake) requestWakeLock();
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.deferredInstall = e;
  $('install').hidden = false;
});
window.addEventListener('appinstalled', () => { $('install').hidden = true; });

const APP_VERSION = '1.3.1';

/* Updates: a new service worker installs in the background and waits; we offer Refresh. */
function showUpdateToast(worker) {
  const toast = $('update-toast');
  if (!toast.hidden) return;
  toast.hidden = false;
  $('update-refresh').onclick = () => {
    $('update-refresh').disabled = true;
    $('update-refresh').textContent = 'Updating…';
    state.updateRequested = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  };
  $('update-later').onclick = () => { toast.hidden = true; };
}

function registerServiceWorker() {
  try {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !state.updateRequested) return;
      reloading = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const watch = (worker) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          // "installed" with an existing controller means a newer version is waiting.
          if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(worker);
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg.waiting);
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      // Check for a new version when the app comes back to the foreground, and every 30 minutes.
      const check = () => { if (state.mode === 'idle') reg.update().catch(() => {}); };
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      setInterval(check, 30 * 60 * 1000);
    }).catch(() => {});
  } catch { /* sandboxed previews refuse service workers */ }
}

/* ---------- Example state ---------- */

function showExample() {
  state.pick = null;
  // A clearly labelled sample: what a confident C major read looks like.
  const engine = new KeyEngine();
  [6.6, 0.4, 3.4, 0.5, 4.9, 3.9, 0.6, 5.6, 0.5, 4.1, 0.6, 2.6].forEach((v, i) => { engine.chroma[i] = v; });
  [7, 0, 0, 0, 1, 3, 0, 4, 0, 3, 0, 0.4].forEach((v, i) => { engine.bass[i] = v; });
  engine.bassSeconds = 40;
  engine.seconds = 40;
  const a = analyzeEngine(engine);
  renderResult(a, describe(a.best.tonic, a.type), {
    confidence: a.confidence,
    sourceText: 'Example · tap the red button to listen',
    tuning: null,
  });
  wave.mode = 'example';
  wave.overview = exampleOverview();
  wave.progress = 0.64;
  drawWave();
  setClock(40);
}

/* ---------- Wire up ---------- */

function init() {
  wave.el = $('wave');
  wave.g = wave.el.getContext('2d');
  buildDial();
  buildPiano();
  if ('ResizeObserver' in window) new ResizeObserver(sizeWave).observe(wave.el);
  sizeWave();
  showExample();

  $('listen').addEventListener('click', () => { if (state.mode === 'idle') startListening(); });
  $('stop').addEventListener('click', () => { if (state.mode === 'listening') stopListening(); });
  $('pick').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    analyzeFile(f);
  });
  $('reset').addEventListener('click', () => {
    if (state.mode === 'listening') {
      state.engine.reset();
      state.shown = null;
      state.pending = null;
      setClock(0);
      renderPending('Listening…', 'Started over. A fresh read appears after a few seconds of music.', 'Live · microphone');
    } else if (state.mode === 'idle') {
      setStatus('idle', 'Ready');
      showExample();
    }
  });
  $('play-scale').addEventListener('click', playScale);
  $('copy').addEventListener('click', copyResult);
  $('about-btn').addEventListener('click', () => {
    const about = $('about');
    about.open = true;
    about.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('install').addEventListener('click', async () => {
    const e = state.deferredInstall;
    if (!e) return;
    e.prompt();
    try { await e.userChoice; } catch { /* dismissed */ }
    state.deferredInstall = null;
    $('install').hidden = true;
  });

  document.addEventListener('dragover', (e) => { e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) analyzeFile(f);
  });

  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (iOS && !standalone) $('ios-hint').hidden = false;

  $('version').textContent = `Version ${APP_VERSION}`;
  registerServiceWorker();
}

init();
