#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tally council verdicts against a packet key (#8802).
 *
 *   node tests/ui-scenes/tally.mjs --key <key.json> --out <summary.md> verdict1.json verdict2.json ...
 *
 * Reports, per reviewer and pooled:
 * - win rate of capture A over B: (wins + ties / 2) / decided items, controls excluded;
 * - per-axis win rates and mean absolute scores of A and B;
 * - control accuracy: share of identical-image controls judged `tie`
 *   (a reviewer under ~0.5 here is inventing differences; weigh it down);
 * - hard-constraint vetoes from the two manifests (see COUNCIL.md);
 * - every defect raised against A, most severe and most repeated first.
 * Solo packets (one image per item) report absolute scores and defects only.
 * Writes markdown to --out and the same numbers as JSON next to it.
 *
 * @unwired-by-design council tooling, run by hand between rounds; not a CI gate.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const AXES = ['hierarchy', 'coherence', 'density', 'modelPrimacy', 'stateClarity', 'craft'];
// The model is these scenes' subject; see COUNCIL.md's veto list for why selected-properties counts.
const MODEL_SCENES = new Set(['loaded', 'isolated', 'selected-properties', 'mobile-loaded']);

function parseArgs(argv) {
  const args = { verdicts: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--key') args.key = resolve(argv[++i]);
    else if (argv[i] === '--out') args.out = resolve(argv[++i]);
    else args.verdicts.push(resolve(argv[i]));
  }
  if (!args.key || !args.out || args.verdicts.length === 0) throw new Error('usage: tally.mjs --key <key> --out <md> <verdict.json>...');
  return args;
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const fmt = (x, d = 2) => (x === null || x === undefined ? '–' : x.toFixed(d));

/** Map an X/Y/tie choice onto the A/B captures for one item. */
function side(choice, x) {
  if (choice === 'tie') return 'tie';
  if (choice !== 'X' && choice !== 'Y') return null;
  if (x === 'a') return choice === 'X' ? 'a' : 'b';
  return choice === 'X' ? 'b' : 'a';
}

function winRate(sides) {
  const decided = sides.filter((s) => s !== null);
  if (decided.length === 0) return null;
  return decided.reduce((n, s) => n + (s === 'a' ? 1 : s === 'tie' ? 0.5 : 0), 0) / decided.length;
}

function vetoes(key) {
  const out = [];
  for (const [id, item] of Object.entries(key.items)) {
    if (item.control || !item.metrics?.a) continue;
    const { a, b } = item.metrics;
    const scene = id.split('.')[0];
    if (MODEL_SCENES.has(scene) && a.modelVisibleFraction < b.modelVisibleFraction - 0.03) {
      out.push(`${id}: modelVisibleFraction ${a.modelVisibleFraction} < baseline ${b.modelVisibleFraction} - 0.03`);
    }
    if (a.minFontPx !== null && a.minFontPx < 10) out.push(`${id}: minFontPx ${a.minFontPx} < 10`);
    if (a.smallTextShare > b.smallTextShare + 0.05) out.push(`${id}: smallTextShare ${a.smallTextShare} > baseline ${b.smallTextShare} + 0.05`);
    const newErrors = (item.pageErrors?.a ?? []).filter((e) => !(item.pageErrors?.b ?? []).includes(e));
    if (newErrors.length) out.push(`${id}: new page errors: ${newErrors.join(' | ').slice(0, 300)}`);
  }
  return out;
}

function tallyReviewer(key, verdict) {
  const sides = []; const axisSides = Object.fromEntries(AXES.map((a) => [a, []]));
  const scores = { a: Object.fromEntries(AXES.map((a) => [a, []])), b: Object.fromEntries(AXES.map((a) => [a, []])) };
  const controls = []; const defects = []; const missing = [];
  const seen = new Set();
  for (const v of verdict.verdicts ?? []) {
    const id = `${v.scene}.${v.theme}`;
    const item = key.items[id];
    if (!item) { missing.push(`unknown item ${id}`); continue; }
    seen.add(id);
    if (item.control) { controls.push(v.preferred === 'tie' || (v.confidence ?? 3) <= 1); continue; }
    if (key.mode === 'solo') {
      for (const axis of AXES) if (typeof v.scores?.X?.[axis] === 'number') scores.a[axis].push(v.scores.X[axis]);
      for (const d of v.defects ?? []) defects.push({ ...d, item: id });
      continue;
    }
    sides.push(side(v.preferred, item.x));
    for (const axis of AXES) axisSides[axis].push(side(v.axes?.[axis], item.x));
    for (const label of ['X', 'Y']) {
      const capture = side(label, item.x);
      for (const axis of AXES) if (typeof v.scores?.[label]?.[axis] === 'number') scores[capture][axis].push(v.scores[label][axis]);
    }
    for (const d of v.defects ?? []) {
      const capture = key.mode === 'solo' ? 'a' : side(d.image, item.x);
      if (capture === 'a') defects.push({ ...d, item: id });
    }
  }
  for (const id of Object.keys(key.items)) if (!seen.has(id)) missing.push(`no verdict for ${id}`);
  return {
    reviewer: verdict.reviewer ?? 'unknown',
    winRate: winRate(sides),
    axes: Object.fromEntries(AXES.map((a) => [a, winRate(axisSides[a])])),
    scoreA: Object.fromEntries(AXES.map((a) => [a, mean(scores.a[a])])),
    scoreB: Object.fromEntries(AXES.map((a) => [a, mean(scores.b[a])])),
    controlAccuracy: controls.length ? controls.filter(Boolean).length / controls.length : null,
    defects, missing,
    crossScene: verdict.crossScene ?? [],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = JSON.parse(await readFile(args.key, 'utf8'));
  const reviewers = [];
  for (const file of args.verdicts) reviewers.push(tallyReviewer(key, JSON.parse(await readFile(file, 'utf8'))));
  const veto = key.mode === 'pair' ? vetoes(key) : [];
  const pooledWin = mean(reviewers.map((r) => r.winRate).filter((x) => x !== null));
  const overallA = mean(reviewers.flatMap((r) => AXES.map((a) => r.scoreA[a]).filter((x) => x !== null)));
  const overallB = mean(reviewers.flatMap((r) => AXES.map((a) => r.scoreB[a]).filter((x) => x !== null)));

  const lines = [`# Council tally: ${key.a?.label ?? key.solo?.label ?? 'A'}${key.b ? ` vs ${key.b.label}` : ''}`, ''];
  if (key.mode === 'pair') {
    lines.push(`- pooled win rate of A: **${fmt(pooledWin)}**`, `- mean absolute score A ${fmt(overallA)} / B ${fmt(overallB)}`,
      `- vetoes: ${veto.length ? '' : 'none'}`, ...veto.map((v) => `  - ${v}`), '');
    lines.push(`| reviewer | win A | control acc. | ${AXES.join(' | ')} |`, `|---|---|---|${AXES.map(() => '---').join('|')}|`);
    for (const r of reviewers) lines.push(`| ${r.reviewer} | ${fmt(r.winRate)} | ${fmt(r.controlAccuracy)} | ${AXES.map((a) => fmt(r.axes[a])).join(' | ')} |`);
    lines.push('', '| reviewer | score | ' + AXES.join(' | ') + ' |', `|---|---|${AXES.map(() => '---').join('|')}|`);
    for (const r of reviewers) {
      lines.push(`| ${r.reviewer} | A | ${AXES.map((a) => fmt(r.scoreA[a], 1)).join(' | ')} |`);
      lines.push(`| ${r.reviewer} | B | ${AXES.map((a) => fmt(r.scoreB[a], 1)).join(' | ')} |`);
    }
  } else {
    lines.push(`- mean absolute score: **${fmt(overallA)}**`, '', `| reviewer | ${AXES.join(' | ')} |`, `|---|${AXES.map(() => '---').join('|')}|`);
    for (const r of reviewers) lines.push(`| ${r.reviewer} | ${AXES.map((a) => fmt(r.scoreA[a], 1)).join(' | ')} |`);
  }
  const defects = reviewers.flatMap((r) => r.defects.map((d) => ({ ...d, reviewer: r.reviewer })))
    .sort((x, y) => (y.severity ?? 1) - (x.severity ?? 1) || x.item.localeCompare(y.item));
  lines.push('', `## Defects raised against ${key.mode === 'solo' ? 'the capture' : 'A'} (${defects.length})`, '');
  for (const d of defects) lines.push(`- [s${d.severity ?? '?'}] **${d.item}** (${d.reviewer}) — ${d.element}: ${d.problem} → ${d.fix}`);
  const cross = reviewers.flatMap((r) => r.crossScene.map((c) => ({ ...c, reviewer: r.reviewer })));
  if (cross.length) {
    lines.push('', '## Cross-scene patterns', '');
    for (const c of cross) lines.push(`- (${c.reviewer}, image ${c.image}) ${c.problem} [${(c.scenes ?? []).join(', ')}] → ${c.fix}`);
  }
  const missing = reviewers.flatMap((r) => r.missing.map((m) => `${r.reviewer}: ${m}`));
  if (missing.length) lines.push('', '## Incomplete verdicts', '', ...missing.map((m) => `- ${m}`));
  await writeFile(args.out, `${lines.join('\n')}\n`);
  await writeFile(args.out.replace(/\.md$/, '') + '.json', `${JSON.stringify({ mode: key.mode, pooledWin, overallA, overallB, veto, reviewers }, null, 2)}\n`);
  console.log(lines.slice(0, 20).join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
