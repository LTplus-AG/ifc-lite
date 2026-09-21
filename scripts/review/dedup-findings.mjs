#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DUPLICATE FINDINGS ARE MERGED BEFORE THE JUDGE SEES THEM.
 *
 * The cheap ensemble (ensemble-reviewer.mjs) pools several models' findings and
 * leaves the same defect reported two or three times for judge.md to fold. The
 * judge's rule for that is prose ("two findings about the SAME line ... if they
 * describe the same underlying problem, keep the one with the strongest
 * evidence"), which a haiku-class judge applies unevenly, and which cannot see
 * a duplicate that sits on a different line or in a sibling file at all. On 7
 * maintainer-confirmed duplicate pairs against 31 non-duplicates from this
 * repository's own review threads (bench, 2026-09-21), the yes/no below scored
 * AUC 1.0 and, at 0.7, 7/7 recall with 0 false merges; three of the seven were
 * cross-file same-root-cause pairs.
 *
 * IT CAN ONLY MERGE, AND IT FAILS SOFT. No key, no network, a malformed answer:
 * every path writes the input findings through unchanged and says so. The
 * survivor of a pair is chosen deterministically (verified sibling first, then
 * the more specific text), never by the model, and the dropped finding is
 * recorded under `dedup.dropped` with the index it duplicated, so nothing is
 * silently deleted.
 *
 * Usage: dedup-findings.mjs --findings <in.json> --out <out.json>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { available, noul, systemOne } from './lib/jev-client.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

/** Above this a pair is merged. From the bench: 0.5 already gave 7/7 with 2/31 false merges; 0.7 gave 0. */
export const DUPLICATE_THRESHOLD = 0.7;

/** Pure: one request holding every finding once and one yes/no per unordered pair. */
export function buildDedupRequest(findings) {
  const state = {
    findings: findings.map((f, i) => ({ index: i, file: f.path, line: f.line ?? null, severity: f.severity ?? null, defect_class: f.class ?? null, text: f.body ?? '', quoted_code: f.quote ?? null, cross_file_evidence: f.sibling?.path ? `${f.sibling.path}:${f.sibling.line ?? ''}` : null })),
  };
  const questions = {};
  const pairs = [];
  for (let a = 0; a < findings.length; a += 1) {
    for (let b = a + 1; b < findings.length; b += 1) {
      pairs.push([a, b]);
      questions[`dup_${a}_${b}`] = noul({
        question: `Do \`findings[${a}]\` and \`findings[${b}]\` describe the same underlying defect, so that one fix would resolve both?`,
        note: 'Two findings on the same lines that raise genuinely different problems are not duplicates; two findings on different lines or files caused by the same root cause are.',
      });
    }
  }
  return { state, questions, pairs };
}

/**
 * Pure: given pair probabilities, decide which findings survive. Groups are
 * CLIQUES, not connected components: a finding joins a group only if its
 * probability with EVERY member is above the threshold. Union-find would let
 * B and C (P 0.1, distinct defects) merge through a shared resemblance to A
 * (P 0.8 each) and silently drop one of two real findings. The survivor of
 * each group is the finding with a verified sibling, else the longest body,
 * else the earliest index.
 * @returns {{ kept: object[], dropped: Array<{ index: number, duplicateOf: number, probability: number, path: string, line: number }> }}
 */
export function mergeDuplicates(findings, pairScores, threshold = DUPLICATE_THRESHOLD) {
  const p = new Map();
  for (const { a, b, p: prob } of pairScores) p.set(`${Math.min(a, b)}:${Math.max(a, b)}`, prob);
  const pairP = (a, b) => p.get(`${Math.min(a, b)}:${Math.max(a, b)}`) ?? 0;
  // Strongest pairs first, so a finding lands in the group it resembles most.
  const strong = pairScores.filter((x) => x.p >= threshold).sort((x, y) => y.p - x.p);
  const groupOf = new Map();
  const groupsList = [];
  const best = new Map(); // index -> highest probability that linked it
  for (const { a, b, p: prob } of strong) {
    const ga = groupOf.get(a), gb = groupOf.get(b);
    if (ga && gb) {
      if (ga === gb) continue;
      if (ga.every((x) => gb.every((y) => pairP(x, y) >= threshold))) { for (const y of gb) { ga.push(y); groupOf.set(y, ga); } groupsList.splice(groupsList.indexOf(gb), 1); }
      else continue;
    } else if (ga || gb) {
      const g = ga ?? gb, n = ga ? b : a;
      if (!g.every((x) => pairP(x, n) >= threshold)) continue;
      g.push(n); groupOf.set(n, g);
    } else {
      const g = [a, b]; groupsList.push(g); groupOf.set(a, g); groupOf.set(b, g);
    }
    best.set(a, Math.max(best.get(a) ?? 0, prob));
    best.set(b, Math.max(best.get(b) ?? 0, prob));
  }
  const groups = new Map(groupsList.map((g) => [g[0], g]));
  findings.forEach((_, i) => { if (!groupOf.has(i)) groups.set(i, [i]); });
  const strength = (i) => [findings[i].sibling?.path ? 1 : 0, String(findings[i].body ?? '').length, -i];
  const better = (i, j) => { const x = strength(i), y = strength(j); for (let k = 0; k < x.length; k += 1) if (x[k] !== y[k]) return x[k] > y[k] ? i : j; return i; };
  const keep = new Set();
  const dropped = [];
  for (const members of groups.values()) {
    const survivor = members.reduce((s, i) => better(s, i));
    keep.add(survivor);
    for (const i of members) if (i !== survivor) dropped.push({ index: i, duplicateOf: survivor, probability: best.get(i) ?? 0, path: findings[i].path, line: findings[i].line });
  }
  return { kept: findings.filter((_, i) => keep.has(i)), dropped: dropped.sort((x, y) => x.index - y.index) };
}

/** The network half. Throws on any failure; `main` turns that into a pass-through. */
export async function scorePairs(findings, { env, fetchImpl } = {}) {
  const { state, questions, pairs } = buildDedupRequest(findings);
  if (pairs.length === 0) return [];
  const { answers } = await systemOne({ state, questions, env, fetchImpl });
  return pairs.map(([a, b]) => {
    const p = Number(answers[`dup_${a}_${b}`]?.noul);
    if (!Number.isFinite(p)) throw new Error(`answer dup_${a}_${b} missing or not a number`);
    return { a, b, p };
  });
}

export async function main(argv, { readFile = readFileSync, writeFile = writeFileSync, log = console.log, env = process.env, fetchImpl } = {}) {
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };
  const inPath = arg('findings');
  const outPath = arg('out');
  if (!inPath || !outPath) throw new Error('usage: dedup-findings.mjs --findings <in.json> --out <out.json>');
  const doc = JSON.parse(readFile(inPath, 'utf8'));
  const before = Array.isArray(doc.findings) ? doc.findings : [];
  let result = { kept: before, dropped: [] };
  let ran = false;
  let note = null;
  if (before.length < 2) note = 'fewer than two findings; nothing to merge';
  else if (!available(env)) note = 'TYPESAFE_API_KEY not set; findings pass through unmerged';
  else {
    try {
      result = mergeDuplicates(before, await scorePairs(before, { env, fetchImpl }));
      ran = true;
    } catch (err) {
      note = `dedup unavailable: ${err?.message ?? err}; findings pass through unmerged`;
      result = { kept: before, dropped: [] };
    }
  }
  if (note) log(`DEDUP NOTE: ${note}`);
  for (const d of result.dropped) log(`DEDUP MERGED ${d.path}:${d.line} into finding ${d.duplicateOf} (P ${d.probability.toFixed(2)})`);
  writeFile(outPath, `${JSON.stringify({ ...doc, findings: result.kept, dedup: { ran, threshold: DUPLICATE_THRESHOLD, dropped: result.dropped, note } }, null, 2)}\n`);
  log(`dedup: ${before.length} in, ${result.kept.length} out${ran ? '' : ' (not run)'}`);
  return result;
}

if (isMainEntry(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    // Even a usage error must not leave the pipeline without an output file the
    // shell can fall back from, so this exits non-zero and the workflow's
    // `cp findings.json deduped.json` backstop takes over.
    console.error(`DEDUP FAILED: ${err?.message ?? err}`);
    process.exit(1);
  });
}
