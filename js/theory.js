// Music theory: key profiles, key scoring, mode refinement, spelling, chords, Camelot.

export const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
export const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

// Krumhansl–Kessler (1982) probe-tone ratings and Temperley (Kostka–Payne corpus) profiles.
const PROFILES = {
  major: [
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4],
  ],
  minor: [
    [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
    [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33],
  ],
};

export const SCALES = {
  major: { name: 'Major', detail: 'Ionian mode', steps: [0, 2, 4, 5, 7, 9, 11], quality: 'major' },
  minor: { name: 'Natural minor', detail: 'Aeolian mode', steps: [0, 2, 3, 5, 7, 8, 10], quality: 'minor' },
  dorian: { name: 'Dorian', detail: 'Minor with a raised 6th', steps: [0, 2, 3, 5, 7, 9, 10], quality: 'minor' },
  phrygian: { name: 'Phrygian', detail: 'Minor with a flat 2nd', steps: [0, 1, 3, 5, 7, 8, 10], quality: 'minor' },
  harmonicMinor: { name: 'Harmonic minor', detail: 'Minor with a raised 7th', steps: [0, 2, 3, 5, 7, 8, 11], quality: 'minor' },
  melodicMinor: { name: 'Melodic minor', detail: 'Minor with a raised 6th and 7th', steps: [0, 2, 3, 5, 7, 9, 11], quality: 'minor' },
  lydian: { name: 'Lydian', detail: 'Major with a raised 4th', steps: [0, 2, 4, 6, 7, 9, 11], quality: 'major' },
  mixolydian: { name: 'Mixolydian', detail: 'Major with a flat 7th', steps: [0, 2, 4, 5, 7, 9, 10], quality: 'major' },
};

function pearson(x, y) {
  let mx = 0, my = 0;
  for (let i = 0; i < 12; i++) { mx += x[i]; my += y[i]; }
  mx /= 12; my /= 12;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < 12; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

const swap = (arr, a, b) => { const o = arr.slice(); [o[a], o[b]] = [o[b], o[a]]; return o; };
// Natural-minor variant: make sure ♭7 outweighs the leading tone.
const natural = (p) => p.slice(0, 10).concat([Math.max(p[10], p[11]), Math.min(p[10], p[11])]);

// Modal profiles: the parent major/minor profile with the mode's characteristic note
// given the weight of the note it replaces. Modes carry a small prior penalty so
// plain major/minor wins unless the evidence is clear.
const TYPES = {
  major: { profiles: PROFILES.major, prior: 0 },
  minor: { profiles: PROFILES.minor.map(natural), prior: 0 },
  mixolydian: { profiles: PROFILES.major.map((p) => swap(p, 10, 11)), prior: -0.045 },
  dorian: { profiles: PROFILES.minor.map((p) => swap(natural(p), 8, 9)), prior: -0.045 },
  lydian: { profiles: PROFILES.major.map((p) => swap(p, 5, 6)), prior: -0.09 },
  phrygian: { profiles: PROFILES.minor.map((p) => swap(natural(p), 1, 2)), prior: -0.09 },
};

function corrType(chroma, profiles, t) {
  let r = 0;
  for (const prof of profiles) {
    const rot = new Array(12);
    for (let i = 0; i < 12; i++) rot[(i + t) % 12] = prof[i];
    r += pearson(chroma, rot);
  }
  return r / profiles.length;
}

/**
 * Rank keys. Each candidate is { tonic, type, quality, r }.
 * bass (optional): pitch-class profile of the low register, strong evidence for the tonic.
 * modes: include Dorian, Mixolydian, Lydian and Phrygian candidates.
 */
export function scoreKeys(chroma, { bass = null, bassWeight = 0.4, modes = true } = {}) {
  const out = [];
  const types = modes ? Object.keys(TYPES) : ['major', 'minor'];
  for (const type of types) {
    const { profiles, prior } = TYPES[type];
    const steps = SCALES[type].steps;
    for (let t = 0; t < 12; t++) {
      let r = corrType(chroma, profiles, t);
      if (bass) {
        // Tonic bonus: how much the bass favours this tonic over the scale's other notes.
        let mean = 0;
        for (const s of steps) mean += bass[(t + s) % 12];
        r += bassWeight * (bass[t] - mean / 7);
      }
      out.push({ tonic: t, type, quality: SCALES[type].quality, r: r + prior });
    }
  }
  return out.sort((a, b) => b.r - a.r);
}

/** Within a minor reading, check for a raised 7th (harmonic) or raised 6th and 7th (melodic). */
export function refineMinor(chroma, tonic, type) {
  if (type !== 'minor') return type;
  const c = (i) => chroma[(tonic + i) % 12];
  const clearly = (x, y) => c(x) > c(y) * 1.35 && c(x) > (1 / 12) * 0.75;
  if (clearly(11, 10)) return clearly(9, 8) ? 'melodicMinor' : 'harmonicMinor';
  return 'minor';
}

const accText = (a) => (a > 0 ? '♯'.repeat(a) : a < 0 ? '♭'.repeat(-a) : '');

function spell(letterIdx, tonicPc, steps) {
  return steps.map((s, i) => {
    const li = (letterIdx + i) % 7;
    const pc = (tonicPc + s) % 12;
    const acc = ((pc - LETTER_PC[li] + 18) % 12) - 6;
    return { name: LETTERS[li] + accText(acc), pc, acc };
  });
}

/** Spell a scale on tonic pc, choosing the enharmonic with the fewest accidentals. */
export function spellScale(tonicPc, steps) {
  const majorish = steps[2] === 4;
  const options = [];
  for (let li = 0; li < 7; li++) {
    const acc = ((tonicPc - LETTER_PC[li] + 18) % 12) - 6;
    if (Math.abs(acc) > 1) continue;
    const notes = spell(li, tonicPc, steps);
    let cost = 0;
    for (const n of notes) cost += Math.abs(n.acc) + (Math.abs(n.acc) > 1 ? 10 : 0);
    cost += Math.abs(acc) * 0.1;
    if (acc !== 0) cost += (acc > 0) === majorish ? 0 : 0.01; // ties: sharps for major-type, flats for minor-type
    options.push({ cost, notes });
  }
  options.sort((a, b) => a.cost - b.cost);
  return options[0].notes;
}

/**
 * One-call analysis of an engine's accumulated profile.
 * Modes are only considered once there is enough material to judge them.
 */
const MODE_MARGIN = 0.02;

export function analyzeEngine(engine, { minModeSeconds = 20, useBass = true, modeMargin = MODE_MARGIN } = {}) {
  const chroma = engine.normalized();
  const bass = useBass && engine.bassSeconds > 2 ? engine.normalized(engine.bass) : null;
  const ranked = scoreKeys(chroma, { bass, modes: engine.seconds >= minModeSeconds });
  // A mode has to clearly beat the best plain major/minor reading, otherwise report that.
  let best = ranked[0];
  if (best.type !== 'major' && best.type !== 'minor') {
    const plain = ranked.find((k) => k.type === 'major' || k.type === 'minor');
    if (best.r - plain.r < modeMargin) best = plain;
  }
  const type = refineMinor(chroma, best.tonic, best.type);
  // Margin to the strongest candidate with a different tonic.
  const rival = ranked.find((k) => k.tonic !== best.tonic) || ranked[1];
  const margin = best.r - rival.r;
  const confidence = margin >= 0.08 ? 'strong' : margin >= 0.035 ? 'likely' : 'close';
  return { chroma, ranked, best, type, rival, margin, confidence, seconds: engine.seconds };
}

export function keyName(tonic, quality) {
  return `${spellScale(tonic, SCALES[quality].steps)[0].name} ${quality}`;
}

export function camelot(tonic, quality) {
  const majorPc = quality === 'major' ? tonic : (tonic + 3) % 12;
  const idx = FIFTHS.indexOf(majorPc);
  return `${((idx + 7) % 12) + 1}${quality === 'major' ? 'B' : 'A'}`;
}

export const TITLE_WORD = {
  major: 'major', minor: 'minor', dorian: 'Dorian', phrygian: 'Phrygian', lydian: 'Lydian',
  mixolydian: 'Mixolydian', harmonicMinor: 'harmonic minor', melodicMinor: 'melodic minor',
};

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

function degreeLabel(step, i) {
  return accText(step - MAJOR_STEPS[i]) + (i + 1);
}

/** Everything the UI needs to show for one key + scale. */
export function describe(tonic, scaleId) {
  const scale = SCALES[scaleId];
  const notes = spellScale(tonic, scale.steps).map((n, i) => ({
    ...n,
    degree: degreeLabel(scale.steps[i], i),
  }));
  const chords = scale.steps.map((root, i) => {
    const third = (scale.steps[(i + 2) % 7] - root + 12) % 12;
    const fifth = (scale.steps[(i + 4) % 7] - root + 12) % 12;
    let q = 'maj';
    if (third === 3 && fifth === 7) q = 'min';
    else if (third === 3 && fifth === 6) q = 'dim';
    else if (third === 4 && fifth === 8) q = 'aug';
    const prefix = accText(root - MAJOR_STEPS[i]);
    let roman = ROMAN[i];
    if (q === 'min' || q === 'dim') roman = roman.toLowerCase();
    roman = prefix + roman + (q === 'dim' ? '°' : q === 'aug' ? '+' : '');
    const suffix = { maj: '', min: 'm', dim: 'dim', aug: 'aug' }[q];
    return {
      roman,
      name: notes[i].name + suffix,
      quality: q,
      pcs: [(tonic + root) % 12, (tonic + root + third) % 12, (tonic + root + fifth) % 12],
      rootStep: root,
      intervals: [0, third, fifth],
    };
  });
  const quality = scale.quality;
  const relTonic = quality === 'major' ? (tonic + 9) % 12 : (tonic + 3) % 12;
  const relQuality = quality === 'major' ? 'minor' : 'major';
  // Modes share their notes with a parent major key; major/minor have a relative key.
  const PARENT_OFFSET = { dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7 };
  const sibling = scaleId in PARENT_OFFSET
    ? { label: 'Same notes as', name: keyName((tonic - PARENT_OFFSET[scaleId] + 12) % 12, 'major') }
    : { label: 'Relative', name: keyName(relTonic, relQuality) };
  return {
    tonic,
    scaleId,
    quality,
    tonicName: notes[0].name,
    title: notes[0].name + ' ' + TITLE_WORD[scaleId],
    scaleName: scale.name,
    scaleDetail: scale.detail,
    notes,
    chords,
    pcs: new Set(notes.map((n) => n.pc)),
    sibling,
    camelot: camelot(tonic, quality),
  };
}

/** Score of a given tonic + scale within an analysis (harmonic/melodic minor score as minor). */
export function scoreOf(analysis, tonic, scaleId) {
  const asType = scaleId === 'harmonicMinor' || scaleId === 'melodicMinor' ? 'minor' : scaleId;
  const hit = analysis.ranked.find((k) => k.tonic === tonic && k.type === asType);
  return hit ? hit.r : -Infinity;
}

const sameNotes = (a, b) => a.pcs.size === b.pcs.size && [...a.pcs].every((pc) => b.pcs.has(pc));

/**
 * Keeps the displayed key steady. A challenger replaces the shown key only after it has
 * led by a clear margin for several evaluations in a row; re-reading the same notes with
 * another tonic (relative key, mode) or the same tonic with another scale needs more.
 */
export class KeyTracker {
  constructor() { this.reset(); }
  reset() { this.shown = null; this.pending = null; this.count = 0; }
  update(a, seconds, { early = 15 } = {}) {
    const id = `${a.best.tonic}:${a.type}`;
    if (!this.shown || id === this.shown) {
      this.shown = id;
      this.pending = null;
      this.count = 0;
      return this.shown;
    }
    const [st, sty] = this.shown.split(':');
    const shownTonic = Number(st);
    const lead = a.best.r - scoreOf(a, shownTonic, sty);
    const subtle = shownTonic === a.best.tonic || sameNotes(describe(shownTonic, sty), describe(a.best.tonic, a.type));
    const need = seconds < early ? { lead: 0.0, count: 2 } : subtle ? { lead: 0.04, count: 8 } : { lead: 0.02, count: 4 };
    if (lead >= need.lead) {
      if (this.pending === id) this.count++;
      else { this.pending = id; this.count = 1; }
    } else {
      this.pending = null;
      this.count = 0;
    }
    if (this.count >= need.count) { this.shown = id; this.pending = null; this.count = 0; }
    return this.shown;
  }
}
