#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Prose-versus-artifact numeral report for the moonshot bets.
 *
 * WHY THIS EXISTS. The G4 standing adversarial review
 * (docs/vision/reviews/g4-red-team-2026-07-29.md, section 6) found that five
 * of the seven things the orchestrator's verification structurally cannot
 * catch are the same thing: prose that no artifact backs. All three hard
 * catches in that review were of this class -- the code was re-run and
 * reproduced to the digit, but nobody diffed the sentences against the JSON.
 * Its named cheap fix is this script: "make every number quoted in a REPORT
 * or DESIGN emit from the scorecard JSON, and add a check that every numeral
 * in the prose appears in the artifact."
 *
 * REPORT, NOT GATE -- and that is a deliberate choice, not a shortcut.
 * Prose legitimately contains numbers no artifact emits: bars from the plan,
 * figures re-quoted from another bet's run, arithmetic done in the sentence
 * ("43.7% of the DAG"), and counts from a variant run whose output was never
 * committed. A checker strict enough to catch a stale transcription is
 * therefore also loud enough to flag a dozen honest lines per document, and a
 * red gate that is wrong a dozen times per document gets `|| true`-d within a
 * week. So the default is exit 0 with a RANKED list, ordered by how much it
 * looks like a transcription error rather than by how loudly it fails to
 * match. `--gate` turns it into exit 1 for a directory that has been curated
 * to zero findings and wants to stay there.
 *
 * WHAT COUNTS AS BACKED. For a numeral written as `N` in the prose, the
 * tolerance is the half-ULP of its own last written digit -- 56.5 admits
 * [56.45, 56.55), so the artifact's 56.494 backs it; 2.19e-13 admits
 * +/- 0.5e-15. That is the rule a careful writer already follows, so it
 * neither invents slack nor punishes rounding. On top of that the value is
 * compared under scale factors chosen BY THE UNIT the prose wrote: x100 for a
 * percent against a stored fraction, /1e3 for seconds against milliseconds,
 * and /1e3, /1e6, /1e9 plus the three 1024 powers for byte units. So `0.0239%`
 * matches an artifact `0.023944` and `2.80 s` matches `2796`. Scales are NOT
 * applied blindly across units -- see scalesFor() for what that cost.
 * Thousands separators are stripped before parsing, so `250,582` and `250582`
 * are the same number.
 *
 * WHAT IS IGNORED, AND WHY (the false-positive controls):
 *   - fenced code blocks and inline code spans. Reproduction commands, flags,
 *     file names and type names (`f32`, `--segment 96`) are the single largest
 *     source of noise and none of them are claims.
 *   - link targets, bare URLs, HTML comments.
 *   - ISO dates (2026-07-29) and semver-shaped triples (0.8.5, 22.14.0).
 *   - ordered-list markers and numbered headings at the start of a line.
 *   - any numeral glued to a letter or underscore on either side, unless the
 *     trailing run is a known unit: B4.5, IFC4X3, ISSUE_053, node-hash-v0 and
 *     sha256 are identifiers, while 8.9x and 500ms are quantities.
 *   - a numeral whose immediately preceding word is structural: section, act,
 *     clause, phase, gate, bet, step, line, item, instrument, table, figure,
 *     version, round, tier, note, page, appendix, cycle, chapter, milestone,
 *     entry, footnote, or a leading `#`.
 * Everything else is checked. The suppressions are deliberately about SHAPE
 * (this token is not a measurement) and never about VALUE, so no rule here
 * can hide a wrong number.
 *
 * RANKING. Unbacked numerals are ordered by whether the artifact contains
 * something *close but not equal*. A prose 56.5 sitting 0.9% away from an
 * artifact 55.971 is far more likely to be a stale transcription than a prose
 * 40,028 with nothing within 10% of it anywhere in the JSON -- the latter is
 * usually a real quantity from a run that was never committed, which is worth
 * knowing but is a different problem. Near-misses are printed first, closest
 * first, and are suppressed when the neighbourhood is crowded (see
 * matchDirect) so the report never points at an unrelated field.
 *
 * DIMENSIONLESS numerals that are only explicable as a ratio over two artifact
 * values (a/b, a/b*100, percent change) get their own lower tier. It is always
 * printed, never folded into "backed": over a 50-number scorecard those
 * pairings match by coincidence often enough that a hit is a hint, not a
 * clearance. Read that tier as "a reader could plausibly have computed this in
 * the sentence", not as "this is correct".
 *
 * KNOWN FALSE-POSITIVE CLASSES, so nobody has to rediscover them:
 *   - a number the prose itself is quoting in order to RETRACT it (B4.5's
 *     correction paragraph quotes the removed row's figures verbatim);
 *   - prose that truncates rather than rounds a unit conversion (`36 MB` from
 *     36,536,090 B is 36.5, outside the half-ULP of "36");
 *   - a bar, budget or target from the plan (`< 500 ms`, `< 5%`, `> 90%`);
 *   - a figure re-quoted from a DIFFERENT bet's run, whose artifact is not in
 *     this directory.
 * All four are cheap for a human to dismiss and none can be removed without
 * also removing a real catch, which is the whole reason this is a report.
 *
 * Usage:
 *   node scripts/moonshot/ci/check-report-numerals.mjs
 *   node scripts/moonshot/ci/check-report-numerals.mjs <dir-or-repo-root> ...
 *   node scripts/moonshot/ci/check-report-numerals.mjs --gate      # exit 1 on findings
 *   node scripts/moonshot/ci/check-report-numerals.mjs --json
 *
 * Exit codes: 0 report produced (default, whatever it found), 1 findings with
 * --gate, 2 usage/IO problem.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

const argv = process.argv.slice(2);
const GATE = argv.includes('--gate');
const AS_JSON = argv.includes('--json');
const targets = argv.filter((a) => !a.startsWith('--'));

/** Prose documents a bet is expected to keep in sync with its artifacts. */
const PROSE_NAMES = new Set(['REPORT.md', 'DESIGN.md']);
/** Not artifacts: build/config JSON that happens to sit in a bet directory. */
const JSON_IGNORE = /^(package(-lock)?|tsconfig.*|jsconfig|\.eslintrc)\.json$/;
/** Beyond this many artifact numbers the O(n^2) derived pass is skipped. */
const DERIVED_LIMIT = 600;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every file under `dir` down to `depth` levels. */
function walk(dir, depth = 2, out = []) {
  for (const e of listDir(dir)) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0 && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(abs, depth - 1, out);
    } else if (e.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * A "bet directory" is any directory holding at least one prose doc AND at
 * least one non-config .json. Deliberately broader than the review's literal
 * list (`scorecard.json`, `battery.json`, `results*.json`, `report*.json`):
 * B4.4's contradicted figure lives in `kernel-cross-check.json`, which none of
 * those globs match, and a checker that cannot see the artifact holding the
 * error is not worth running.
 */
function findBetDirs(root) {
  const base = path.join(root, 'scripts/moonshot');
  const roots = [];
  if (statSafe(base)?.isDirectory()) {
    for (const e of listDir(base)) if (e.isDirectory()) roots.push(path.join(base, e.name));
  } else if (statSafe(root)?.isDirectory()) {
    roots.push(root);
  }
  const found = [];
  for (const dir of roots) {
    const files = walk(dir);
    const prose = files.filter((f) => PROSE_NAMES.has(path.basename(f)));
    const artifacts = files.filter(
      (f) => f.endsWith('.json') && !JSON_IGNORE.test(path.basename(f)),
    );
    if (prose.length > 0 && artifacts.length > 0) found.push({ dir, prose, artifacts });
  }
  return found;
}

function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Artifact index
// ---------------------------------------------------------------------------

/** Every finite numeric leaf in the artifacts, with the path that produced it. */
function indexArtifacts(files) {
  const entries = [];
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      continue; // a malformed artifact is a different problem than a wrong numeral
    }
    const rel = path.basename(file);
    const visit = (node, keyPath) => {
      if (typeof node === 'number') {
        if (Number.isFinite(node)) entries.push({ v: node, src: `${rel}:${keyPath || '(root)'}` });
        return;
      }
      if (typeof node === 'string') {
        // Numbers stored as strings still count as emitted by the artifact,
        // and so do numbers EMBEDDED in a label. B4.4's battery.json records
        // its seed as `"family": "A/seed-20260727"` rather than as a numeric
        // field, and a checker that cannot see it reports the prose's seed as
        // unbacked -- a false positive created purely by where the artifact
        // chose to put the digits.
        const t = node.trim();
        if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
          const v = Number(t);
          if (Number.isFinite(v)) entries.push({ v, src: `${rel}:${keyPath || '(root)'}` });
          return;
        }
        for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) {
          const v = Number(m[0]);
          if (Number.isFinite(v)) entries.push({ v, src: `${rel}:${keyPath || '(root)'} (in string)` });
        }
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((c, i) => visit(c, `${keyPath}[${i}]`));
        return;
      }
      if (node && typeof node === 'object') {
        for (const [k, c] of Object.entries(node)) visit(c, keyPath ? `${keyPath}.${k}` : k);
      }
    };
    visit(doc, '');
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Prose extraction
// ---------------------------------------------------------------------------

const SPACES = (n) => ' '.repeat(n);

/** Blank out a region while preserving length AND newlines, so offsets hold. */
function blank(text, re) {
  return text.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

function maskProse(text) {
  let t = text;
  t = blank(t, /```[\s\S]*?```/g); // fenced code
  t = blank(t, /~~~[\s\S]*?~~~/g);
  t = blank(t, /<!--[\s\S]*?-->/g); // html comments
  t = blank(t, /`[^`\n]*`/g); // inline code
  t = blank(t, /\]\([^)\n]*\)/g); // link + image targets
  t = blank(t, /\bhttps?:\/\/\S+/g); // bare urls
  t = blank(t, /\b\d{4}-\d{2}-\d{2}\b/g); // ISO dates
  t = blank(t, /(?<![\w.])\d+\.\d+\.\d+(?![\w.])/g); // semver-shaped triples
  // Ordered-list markers and numbered headings, at line start only.
  t = t
    .split('\n')
    .map((line) => {
      const m = /^(\s*(?:[-*+]\s+)?)(\d+[.)])(\s)/.exec(line);
      if (m) return m[1] + SPACES(m[2].length) + line.slice(m[1].length + m[2].length);
      const h = /^(#{1,6}\s+)(\d+[.)]?)(\s)/.exec(line);
      if (h) return h[1] + SPACES(h[2].length) + line.slice(h[1].length + h[2].length);
      return line;
    })
    .join('\n');
  return t;
}

/** Trailing letter runs that are units rather than the rest of an identifier. */
const UNIT_SUFFIX = new Set([
  'x', 'ms', 's', 'm', 'mm', 'cm', 'km', 'kg', 'g', 'h', 'ns', 'us',
  'b', 'kb', 'mb', 'gb', 'tb', 'kib', 'mib', 'gib', 'k', 'M',
]);

/** Words that make the following number a reference, not a measurement. */
const STRUCTURAL_WORD = new Set([
  'section', 'sections', 'act', 'acts', 'clause', 'clauses', 'phase', 'phases',
  'gate', 'gates', 'bet', 'bets', 'step', 'steps', 'line', 'lines', 'item',
  'items', 'instrument', 'instruments', 'table', 'figure', 'appendix', 'page',
  'version', 'round', 'rounds', 'tier', 'note', 'notes', 'cycle', 'cycles',
  'chapter', 'milestone', 'entry', 'footnote', 'v', 'no', 'nr', 'issue', 'pr',
  'case', 'cases', 'point', 'points',
]);

const NUM_RE = /(?<![\w.$])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([eE][+-]?\d+)?/g;

function extractNumerals(rawText) {
  const masked = maskProse(rawText);
  // Line starts, for offset -> line number.
  const lineStarts = [0];
  for (let i = 0; i < masked.length; i += 1) if (masked[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (off) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const out = [];
  for (const m of masked.matchAll(NUM_RE)) {
    const start = m.index;
    const raw = m[0];
    const end = start + raw.length;

    // Trailing context: an identifier tail disqualifies, a unit does not.
    const tail = /^[A-Za-z_]+/.exec(masked.slice(end, end + 8));
    let unit = '';
    if (tail) {
      const word = tail[0];
      if (!UNIT_SUFFIX.has(word.toLowerCase())) continue;
      unit = word;
    } else if (masked[end] === '%') {
      unit = '%';
    } else {
      const after = /^\s?([%x]|ms|s\b|kg|MB|GB|KB|GiB|MiB|B\b)/.exec(masked.slice(end, end + 5));
      if (after) unit = after[1];
    }

    // Preceding word: structural references are not measurements.
    const beforeText = masked.slice(Math.max(0, start - 24), start);
    if (/#\s?$/.test(beforeText)) continue;
    const pw = /([A-Za-z]+)[\s]+$/.exec(beforeText);
    if (pw && STRUCTURAL_WORD.has(pw[1].toLowerCase())) continue;

    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    out.push({ raw, value, unit, line: lineOf(start) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Half the place value of the last digit actually written. */
function writtenTolerance(raw) {
  const s = raw.replace(/,/g, '');
  const em = /[eE]([+-]?\d+)$/.exec(s);
  const exp = em ? Number(em[1]) : 0;
  const mantissa = em ? s.slice(0, em.index) : s;
  const dot = mantissa.indexOf('.');
  const decimals = dot === -1 ? 0 : mantissa.length - dot - 1;
  const tol = 0.5 * 10 ** (exp - decimals);
  return Math.max(tol, Math.abs(Number(s)) * 1e-12);
}

const BYTE_UNITS = new Set(['b', 'kb', 'mb', 'gb', 'tb', 'kib', 'mib', 'gib']);

/**
 * Scale factors are chosen by the UNIT the prose wrote, not applied blindly.
 * An earlier revision tried all fifteen against every numeral and, on a bet
 * whose artifacts hold ~3,900 numbers, that cleared almost anything: fifteen
 * scales x 3,900 values is ~58,000 chances to land inside a half-ULP window.
 * Unit-gating cuts the search to at most seven and makes a "backed" verdict
 * mean something. The decoy calibration printed with each document measures
 * what is left.
 */
function scalesFor(unit) {
  const u = unit.toLowerCase();
  const out = [[1, '']];
  if (u === '%') out.push([100, 'x100 (artifact stores the fraction)']);
  else if (u === '') out.push([100, 'x100'], [0.01, '/100 (artifact stores the percent)']);
  else if (u === 's') out.push([0.001, '/1e3 (artifact in ms)']);
  else if (u === 'ms') out.push([1000, 'x1e3 (artifact in s)']);
  else if (BYTE_UNITS.has(u)) {
    out.push(
      [1e-3, '/1e3'],
      [1e-6, '/1e6 (artifact in bytes)'],
      [1e-9, '/1e9 (artifact in bytes)'],
      [1 / 1024, '/1KiB'],
      [1 / 1048576, '/1MiB'],
      [1 / 1073741824, '/1GiB'],
    );
  }
  return out;
}

function matchDirect(p, tol, unit, index) {
  const scales = scalesFor(unit);
  let best = null;
  let crowding = 0; // artifact values within 10% at scale 1 -- see below
  for (const e of index) {
    for (const [s, label] of scales) {
      const d = Math.abs(e.v * s - p);
      if (d <= tol) return { kind: s === 1 && e.v === p ? 'exact' : 'rounded', scale: label, entry: e };
    }
    const rel = p === 0 ? (e.v === 0 ? 0 : Infinity) : Math.abs((e.v - p) / p);
    if (rel < 0.1) {
      crowding += 1;
      if (best === null || rel < best.rel) best = { rel, entry: e };
    }
  }
  // `crowding` is what makes the near-miss list readable. "The artifact holds
  // 55.971 and the prose says 56.5" is a strong hint IF 55.971 is the only
  // number in that neighbourhood. In an artifact with hundreds of timings
  // something sits within 1% of anything, and the nearest neighbour is then
  // an accident of density, not evidence. Above the threshold the numeral is
  // still reported -- it is still unbacked -- but without a misleading
  // "closest value" pointing at an unrelated field.
  const informative = best !== null && best.rel <= 0.05 && crowding <= 3;
  return { kind: null, near: informative ? best : null, crowding };
}

/** Derived explanations are offered only for DIMENSIONLESS numerals. */
const DERIVABLE_UNIT = new Set(['%', 'x', '']);

/**
 * Only ratios, and only for dimensionless quantities. Both restrictions were
 * forced by measurement rather than taste.
 *
 * Sums and differences were in the first revision and had to go: over a
 * 50-number scorecard they generate ~12,000 candidate values, enough to
 * "explain" almost any numeral within its written tolerance. They swallowed
 * B4.5's headline `56.5 ms` -- a number that genuinely does not match its
 * artifact -- which is precisely the catch this script exists to make. A rule
 * that explains the one real finding is worse than no rule.
 *
 * The dimension restriction is the same argument from the other side: `43.7%
 * of the DAG` and `8.9x margin` are arithmetic a reader does in their head, so
 * a ratio is a fair explanation. `56.5 ms` is a measurement; if it is not in
 * the artifact, no amount of dividing other people's numbers makes it so.
 */
function matchDerived(p, tol, unit, index) {
  if (!DERIVABLE_UNIT.has(unit.toLowerCase())) return null;
  if (index.length > DERIVED_LIMIT) return null;
  for (let i = 0; i < index.length; i += 1) {
    const a = index[i].v;
    for (let j = 0; j < index.length; j += 1) {
      if (i === j) continue;
      const b = index[j].v;
      if (b === 0) continue;
      if (Math.abs(a / b - p) <= tol) return { how: 'a/b', a: index[i], b: index[j] };
      if (Math.abs((a / b) * 100 - p) <= tol) return { how: 'a/b*100', a: index[i], b: index[j] };
      if (Math.abs(((a - b) / b) * 100 - p) <= tol) return { how: '(a-b)/b*100', a: index[i], b: index[j] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Calibration: how often does this checker CLEAR a number that is wrong?
// ---------------------------------------------------------------------------

/**
 * The honest way to read a "107 of 117 backed" line is to know what "backed"
 * is worth against that particular artifact set. So: take the document's own
 * numerals, perturb each by a seeded 3-30% -- far outside any rounding or unit
 * story, i.e. definitely wrong -- and re-run the matcher. Whatever fraction
 * comes back "backed" is the rate at which a genuinely wrong number would be
 * silently cleared by this checker on this bet. On a small scorecard it is
 * near zero; on an artifact set with thousands of numbers it is not, and the
 * reader is entitled to know that before trusting a clean report.
 *
 * Seeded (mulberry32) so the printed rate is reproducible run to run.
 */
function calibrate(groups, index) {
  if (groups.length === 0) return { decoys: 0, cleared: 0, rate: 0 };
  let s = 0x9e3779b9;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let cleared = 0;
  let decoys = 0;
  for (const g of groups) {
    for (let k = 0; k < 3; k += 1) {
      const factor = 1 + (rnd() < 0.5 ? -1 : 1) * (0.03 + rnd() * 0.27);
      const v = g.value * factor;
      if (v === 0) continue;
      // Write the decoy at the same precision the prose used, so the tolerance
      // is the same tolerance the real numeral got.
      const decimals = (() => {
        const raw = g.raw.replace(/,/g, '');
        const dot = raw.indexOf('.');
        return dot === -1 ? 0 : raw.length - dot - 1;
      })();
      const rawDecoy = v.toFixed(Math.min(decimals, 12));
      decoys += 1;
      if (matchDirect(Number(rawDecoy), writtenTolerance(rawDecoy), g.unit, index).kind) cleared += 1;
    }
  }
  return { decoys, cleared, rate: decoys === 0 ? 0 : cleared / decoys };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const roots = targets.length > 0 ? targets.map((t) => path.resolve(t)) : [REPO_ROOT];
const bets = [];
for (const r of roots) bets.push(...findBetDirs(r));

if (bets.length === 0) {
  console.error(`::error::no bet directory found under ${roots.join(', ')}`);
  console.error('A bet directory needs at least one of REPORT.md / DESIGN.md and one non-config .json.');
  process.exit(2);
}

const results = [];

for (const bet of bets) {
  const index = indexArtifacts(bet.artifacts);
  const betOut = {
    dir: path.relative(REPO_ROOT, bet.dir) || bet.dir,
    artifacts: bet.artifacts.map((f) => path.basename(f)),
    artifactNumbers: index.length,
    derivedPassRun: index.length <= DERIVED_LIMIT,
    docs: [],
  };

  for (const doc of bet.prose) {
    const nums = extractNumerals(readFileSync(doc, 'utf-8'));
    const backed = [];
    const nearMiss = [];
    const noTrace = [];
    const derived = [];

    // Group identical (value, unit) pairs so a number quoted five times is one
    // finding with five line numbers, not five findings.
    const groups = new Map();
    for (const n of nums) {
      const key = `${n.raw}|${n.unit}`;
      if (!groups.has(key)) groups.set(key, { ...n, lines: [] });
      groups.get(key).lines.push(n.line);
    }

    for (const g of groups.values()) {
      const tol = writtenTolerance(g.raw);
      const direct = matchDirect(g.value, tol, g.unit, index);
      if (direct.kind) {
        backed.push({ ...g, via: direct.kind, scale: direct.scale, src: direct.entry.src });
        continue;
      }
      const der = matchDerived(g.value, tol, g.unit, index);
      if (der) {
        derived.push({ ...g, how: der.how, a: der.a, b: der.b });
        continue;
      }
      if (direct.near) nearMiss.push({ ...g, near: direct.near });
      else noTrace.push({ ...g, crowding: direct.crowding });
    }

    nearMiss.sort((a, b) => a.near.rel - b.near.rel);
    noTrace.sort((a, b) => a.lines[0] - b.lines[0]);
    derived.sort((a, b) => a.lines[0] - b.lines[0]);

    betOut.docs.push({
      doc: path.basename(doc),
      total: groups.size,
      backed: backed.length,
      nearMiss,
      noTrace,
      derived,
      decoy: calibrate([...groups.values()], index),
    });
  }
  results.push(betOut);
}

if (AS_JSON) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

let findings = 0;
const fmtLines = (lines) => (lines.length > 4 ? `L${lines.slice(0, 4).join(',')}+${lines.length - 4}` : `L${lines.join(',')}`);

console.log('Prose-versus-artifact numeral report');
console.log('====================================');
console.log('');

for (const bet of results) {
  console.log(`## ${bet.dir}`);
  console.log(
    `   artifacts: ${bet.artifacts.join(', ')} (${bet.artifactNumbers} numbers` +
      `${bet.derivedPassRun ? '' : '; DERIVED pass skipped, index too large'})`,
  );
  for (const d of bet.docs) {
    const unbacked = d.nearMiss.length + d.noTrace.length;
    findings += unbacked;
    console.log(
      `   ${d.doc}: ${d.total} numerals -- ${d.backed} backed, ${d.derived.length} derived-only, ` +
        `${unbacked} UNBACKED`,
    );
    console.log(
      `   calibration: ${(d.decoy.rate * 100).toFixed(1)}% of ${d.decoy.decoys} ` +
        `deliberately-wrong decoys were also "backed"`,
    );
    if (d.decoy.rate > 0.25) {
      console.log(
        `   >> the BACKED count carries little information for this bet: its artifacts hold raw`,
      );
      console.log(
        `   >> sample data (dense continua of floats), so a wrong number lands next to a real one`,
      );
      console.log(
        `   >> by chance. Only the UNBACKED list is signal here. This checker earns its keep`,
      );
      console.log(
        `   >> against a curated scorecard, not against a data dump.`,
      );
    }
    if (d.nearMiss.length > 0) {
      console.log('');
      console.log(`   UNBACKED, but the artifact holds something close (ranked, closest first):`);
      for (const n of d.nearMiss) {
        console.log(
          `     ${fmtLines(n.lines).padEnd(14)} ${(n.raw + n.unit).padEnd(14)} ` +
            `closest ${n.near.entry.v} (${(n.near.rel * 100).toFixed(2)}% off) <- ${n.near.entry.src}`,
        );
      }
    }
    if (d.noTrace.length > 0) {
      console.log('');
      console.log(`   UNBACKED, no informative nearest artifact value:`);
      for (const n of d.noTrace) {
        const why = n.crowding > 3 ? ` (${n.crowding} artifact values within 10%: neighbourhood too crowded to name one)` : '';
        console.log(`     ${fmtLines(n.lines).padEnd(14)} ${n.raw + n.unit}${why}`);
      }
    }
    if (d.derived.length > 0) {
      console.log('');
      console.log(`   DERIVED-ONLY (arithmetic over two artifact values; a hit here is a hint, not a clearance):`);
      for (const n of d.derived) {
        console.log(
          `     ${fmtLines(n.lines).padEnd(14)} ${(n.raw + n.unit).padEnd(14)} ` +
            `${n.how} with a=${n.a.v} (${n.a.src}), b=${n.b.v} (${n.b.src})`,
        );
      }
    }
    console.log('');
  }
}

console.log('------------------------------------');
console.log(`${findings} unbacked numeral(s) across ${results.length} bet director(ies).`);
console.log('');
console.log('Reading this: an UNBACKED numeral is a QUESTION, not a defect. The three');
console.log('legitimate answers are (a) it is a bar or a figure from elsewhere -- fine;');
console.log('(b) it is arithmetic the reader can do -- consider emitting it; (c) it does');
console.log('not match the artifact -- that is the catch this exists for. The near-miss');
console.log('list is where (c) lives: a number sitting 1% from the committed value is');
console.log('almost always prose left behind by a re-run.');

if (GATE && findings > 0) {
  console.error(`::error::${findings} unbacked numeral(s) and --gate was requested.`);
  process.exit(1);
}
process.exit(0);
