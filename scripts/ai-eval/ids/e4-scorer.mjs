/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * E4 edit-task scorer (IDS-090, scorer part).
 *
 * Input: the IDS a candidate produced after applying an E4 instruction to the
 * case's input IDS. The case is correct when the candidate parses to the same
 * document as the expected IDS (`@ifc-lite/ids` `parseIDS`, compared as
 * JSON). Comparing parsed documents ignores formatting, attribute order and
 * XML comments, but not content. The candidate is also audited, as for E2.
 *
 * Deterministic and offline: it makes no LLM or network calls. A candidate
 * that does not parse never counts as correct, and a candidate equal to the
 * unedited input is reported as `unchanged`, so a no-op answer is visible in
 * the summary instead of only as a miss.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './e2-dataset.mjs';
import { E4_DIR_REL } from './e4-e5-datasets.mjs';
import { loadIdsToolchain } from './packages.mjs';

const message = error => (error instanceof Error ? error.message : String(error));

/**
 * @typedef {{ id: string, input: string, expected: string }} E4Case
 * @typedef {{
 *   id: string, correct: boolean, unchanged: boolean, error: string | null,
 *   audit: { status: 'valid' | 'warning' | 'error', codes: string[] },
 * }} E4Score
 */

/**
 * @param {{ root?: string, toolchain?: Awaited<ReturnType<typeof loadIdsToolchain>> }} [options]
 */
export async function createE4Scorer(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const ids = options.toolchain ?? await loadIdsToolchain(root);
  /** @type {Map<string, string>} */
  const parsedFiles = new Map();
  const parsedFile = rel => {
    let json = parsedFiles.get(rel);
    if (json === undefined) {
      json = JSON.stringify(ids.parseIDS(readFileSync(join(root, E4_DIR_REL, rel), 'utf8')));
      parsedFiles.set(rel, json);
    }
    return json;
  };

  /**
   * @param {string} candidateXml
   * @param {E4Case} e4Case
   * @returns {Promise<E4Score>}
   */
  async function scoreCase(candidateXml, e4Case) {
    const report = await ids.auditIDSDocument(candidateXml);
    const audit = { status: report.status, codes: [...new Set(report.issues.map(issue => issue.code))].sort() };
    let candidate;
    try {
      candidate = JSON.stringify(ids.parseIDS(candidateXml));
    } catch (error) {
      return { id: e4Case.id, correct: false, unchanged: false, error: `candidate does not parse: ${message(error)}`, audit };
    }
    return {
      id: e4Case.id,
      correct: candidate === parsedFile(e4Case.expected),
      unchanged: candidate === parsedFile(e4Case.input),
      error: null,
      audit,
    };
  }

  return { scoreCase };
}

/**
 * @param {E4Score[]} scores
 */
export function summariseE4(scores) {
  const correct = scores.filter(score => score.correct).length;
  return {
    cases: scores.length,
    correct,
    // No cases is not a perfect score: an empty run reports null.
    accuracy: scores.length ? correct / scores.length : null,
    unchanged: scores.filter(score => score.unchanged).length,
    unparseable: scores.filter(score => score.error !== null).length,
    auditErrors: scores.filter(score => score.audit.status === 'error').length,
    misses: scores.filter(score => !score.correct).map(score => score.id),
  };
}
