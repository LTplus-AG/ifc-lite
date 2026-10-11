/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * E2 executable-agreement scorer (IDS-090, scorer part).
 *
 * Input: a candidate IDS (XML text written by the agent, or by anything else)
 * and an E2 case. The scorer parses the candidate with `@ifc-lite/ids` and
 * validates it against the case's paired corpus IFC. It parses the IFC and
 * builds the accessor exactly as `packages/ids/src/__corpus__/corpus.test.ts`
 * does. The case agrees when the candidate's verdict equals the corpus
 * verdict (`expected`). The candidate is also audited, because the ship gate
 * in 06-ai-agent.md §9 needs an audit pass rate next to the agreement.
 *
 * This is the oracle the future agent runner calls: it makes no LLM calls,
 * reads nothing from the network and is deterministic for a given candidate.
 *
 * Verdict rule: a candidate with at least one specification is `fail` if any
 * specification fails, otherwise `pass`. A candidate that does not parse, or
 * has no specifications, gets verdict `null` and never agrees. An empty
 * answer must not score as a lenient one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './e2-dataset.mjs';
import { loadIdsToolchain } from './packages.mjs';

const message = error => (error instanceof Error ? error.message : String(error));

/**
 * @typedef {{ id: string, corpusIfc: string, expected: 'pass' | 'fail' }} E2Case
 * @typedef {{
 *   id: string, expected: 'pass' | 'fail', verdict: 'pass' | 'fail' | null, agreement: boolean,
 *   error: string | null,
 *   audit: { status: 'valid' | 'warning' | 'error', errors: number, warnings: number, codes: string[] },
 *   specifications: { name: string, status: string, applicable: number, passed: number, failed: number }[],
 * }} E2Score
 */

/**
 * Build a scorer. IFC models are parsed once and cached by path, because a
 * run scores many candidates against the same 307 models.
 *
 * @param {{ root?: string, toolchain?: Awaited<ReturnType<typeof loadIdsToolchain>> }} [options]
 */
export async function createE2Scorer(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const ids = options.toolchain ?? await loadIdsToolchain(root);
  /** @type {Map<string, Promise<{ accessor: unknown, schemaVersion: string }>>} */
  const models = new Map();

  const modelFor = ifcRel => {
    let model = models.get(ifcRel);
    if (!model) {
      model = (async () => {
        const bytes = readFileSync(join(root, ifcRel));
        const store = await new ids.IfcParser().parseColumnar(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        );
        return { accessor: ids.createDataAccessor(store), schemaVersion: String(store.schemaVersion ?? 'IFC4') };
      })();
      models.set(ifcRel, model);
    }
    return model;
  };

  /**
   * @param {string} candidateXml
   * @param {E2Case} e2Case
   * @returns {Promise<E2Score>}
   */
  async function scoreCase(candidateXml, e2Case) {
    const report = await ids.auditIDSDocument(candidateXml);
    const audit = {
      status: report.status,
      errors: report.issues.filter(issue => issue.severity === 'error').length,
      warnings: report.issues.filter(issue => issue.severity === 'warning').length,
      codes: [...new Set(report.issues.map(issue => issue.code))].sort(),
    };
    const base = { id: e2Case.id, expected: e2Case.expected, audit };
    let document;
    try {
      document = ids.parseIDS(candidateXml);
    } catch (error) {
      return { ...base, verdict: null, agreement: false, error: `candidate does not parse: ${message(error)}`, specifications: [] };
    }
    if (!document.specifications?.length) {
      return { ...base, verdict: null, agreement: false, error: 'candidate has no specifications', specifications: [] };
    }
    const { accessor, schemaVersion } = await modelFor(e2Case.corpusIfc);
    const validation = await ids.validateIDS(document, accessor, { modelId: e2Case.id, schemaVersion, entityCount: 0 });
    const specifications = validation.specificationResults.map(result => ({
      name: result.specification.name,
      status: result.status,
      applicable: result.applicableCount,
      passed: result.passedCount,
      failed: result.failedCount,
    }));
    const verdict = specifications.some(spec => spec.status === 'fail') ? 'fail' : 'pass';
    return { ...base, verdict, agreement: verdict === e2Case.expected, error: null, specifications };
  }

  return { scoreCase };
}

/**
 * Aggregate scores into the numbers a run reports.
 *
 * @param {E2Score[]} scores
 */
export function summariseE2(scores) {
  const bucket = expected => {
    const subset = scores.filter(score => score.expected === expected);
    return { cases: subset.length, agreed: subset.filter(score => score.agreement).length };
  };
  const agreed = scores.filter(score => score.agreement).length;
  return {
    cases: scores.length,
    agreed,
    // No cases is not perfect agreement: an empty run reports null.
    agreement: scores.length ? agreed / scores.length : null,
    byExpected: { pass: bucket('pass'), fail: bucket('fail') },
    unscorable: scores.filter(score => score.verdict === null).length,
    audit: {
      valid: scores.filter(score => score.audit.status === 'valid').length,
      warning: scores.filter(score => score.audit.status === 'warning').length,
      error: scores.filter(score => score.audit.status === 'error').length,
    },
    disagreements: scores.filter(score => !score.agreement).map(score => score.id),
  };
}
