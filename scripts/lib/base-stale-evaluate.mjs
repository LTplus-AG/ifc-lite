/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { combine, evaluatePerf, evaluateRust, prRelevance } from './base-stale.mjs';
import { BudgetError, slim } from './base-stale-io.mjs';
import { matchesAny } from './ci-path-coverage.mjs';

/**
 * Judge one PR. Never throws: a fault while gathering inputs is an `unknown`
 * verdict naming it, so one unreadable PR neither passes nor stops the sweep.
 */
export function evaluatePr(io, { pr, headSha, mainTip, ceilings, globs, measured = null, prRun = null, baseRef = null, baseSha = null }) {
  const record = { pr, head: headSha, mainTip, testedBase: null, prRun: null };
  try {
    const files = io.prFiles(pr, headSha, baseRef, baseSha);
    const rel = prRelevance(files, globs);
    const nativeRequired = files.some((file) => matchesAny(file, globs.nativeGlobs));
    let prMeasured = null;
    if (measured) {
      prMeasured = measured.families.map(slim);
      record.testedBase = io.mergeParents(measured.mergeSha, headSha);
    } else if (rel.perf || rel.rust) {
      const m = io.prMeasurement(headSha, prRun, pr);
      if (m) {
        prMeasured = m.families;
        record.testedBase = m.testedBase;
        record.prRun = m.runId;
      }
    }
    const tb = record.testedBase;
    const sameMain = tb === mainTip;
    let perf;
    if (rel.perf && prMeasured && !tb) {
      perf = { verdict: 'unknown', reasons: ["the PR measurement's base could not be read"], rows: [] };
    } else {
      const needsMain = rel.perf && prMeasured && !rel.editsCeilings;
      // Main has not moved since the PR was measured: main at the base IS main
      // now, so the drift is zero by construction, not by absence.
      const atTip = sameMain ? { sha: tb, behindTip: 0, families: prMeasured } : null;
      let mainAtBase = null;
      let mainLatest = null;
      let mainFault = null;
      if (needsMain) {
        try {
          mainAtBase = atTip ?? io.mainMeasurementAt(tb);
          mainLatest = atTip ?? io.latestMainMeasurement(mainTip);
        } catch (err) {
          // Perf becomes "could not be read"; the Rust half is still judged.
          if (err instanceof BudgetError) throw err;
          mainFault = err.message.split('\n')[0];
        }
      }
      perf = mainFault
        ? { verdict: 'unknown', reasons: [`main's measurement could not be read (${mainFault})`], rows: [] }
        : evaluatePerf({ relevant: rel.perf, editsCeilings: rel.editsCeilings, nativeRequired, prMeasured, testedBase: tb, ceilings, mainAtBase, mainLatest });
    }
    let moved = null;
    if (rel.rust && tb) {
      try {
        moved = sameMain ? { files: [], commits: 0, capped: false } : io.movedSince(tb, mainTip);
      } catch (err) {
        // Rust becomes "could not be read"; a stale perf half still stands.
        if (err instanceof BudgetError) throw err;
        console.log(`base-stale: #${pr}: main's changes since ${tb} not read (${err.message.split('\n')[0]})`);
        moved = null;
      }
    }
    const rust = evaluateRust({ relevant: rel.rust, prFiles: files, rustGlobs: globs.rustGlobs, testedBase: tb, moved });
    return { ...record, ...combine(perf, rust), perf: { verdict: perf.verdict, rows: perf.rows }, rust: { verdict: rust.verdict, mainRustFiles: rust.mainRustFiles, overlap: rust.overlap } };
  } catch (err) {
    const budget = err instanceof BudgetError;
    return { ...record, verdict: 'unknown', reasons: [`${budget ? 'not judged' : 'harness'}: ${err.message.split('\n')[0]}`], ...(budget ? { budget: true } : {}) };
  }
}
