/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The engine-adapter contract and the agreement matrix of the IDS
 * conformance dashboard (IDS-125).
 *
 * An ENGINE is anything that can answer one or both corpus questions:
 *  - `validate(case)`: does the IFC satisfy the IDS? -> 'pass' | 'fail'
 *    (the verdict of the file's single specification);
 *  - `audit(case)`: is the IDS document itself conforming? -> 'valid' | 'invalid'.
 * An adapter implements the ones its engine supports. A missing capability,
 * or a case the adapter throws `UnsupportedCase` for, is reported as `n/a`
 * and never counted as agreement or disagreement. Any other throw is an
 * `error` cell, counted against the engine: a crash is not a verdict.
 *
 * Adapters must be honest wrappers: they may translate an engine's output
 * into a verdict, but every such translation is documented in the adapter
 * (`info.notes`) and printed in the report.
 */

/**
 * @typedef {object} EngineInfo
 * @property {string} id        stable column id, `[a-z0-9-]+`
 * @property {string} name      display name
 * @property {string} version   engine version that produced the column
 * @property {string} licence   SPDX licence expression of the engine
 * @property {string} source    where it was installed from
 * @property {string[]} [notes] how the adapter turns engine output into verdicts
 */

/**
 * @typedef {object} CaseInput
 * @property {string} id
 * @property {string} idsPath
 * @property {string} ifcPath
 */

/**
 * @typedef {object} EngineAdapter
 * @property {EngineInfo} info
 * @property {(input: CaseInput) => Promise<'pass' | 'fail' | { verdict: 'pass' | 'fail', detail?: string }>} [validate]
 * @property {(input: CaseInput) => Promise<'valid' | 'invalid' | { verdict: 'valid' | 'invalid', detail?: string }>} [audit]
 * @property {() => Promise<void>} [close]
 */

/**
 * @typedef {object} Cell
 * @property {'pass' | 'fail' | 'valid' | 'invalid' | 'n/a' | 'error'} verdict
 * @property {boolean | null} agrees   null for `n/a`
 * @property {string} [detail]
 */

/**
 * @typedef {object} Tally
 * @property {number} agree
 * @property {number} disagree
 * @property {number} error
 * @property {number} na
 */

/** Thrown by an adapter for a case its engine cannot answer (reported as n/a). */
export class UnsupportedCase extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.name = 'UnsupportedCase';
  }
}

/** @returns {Tally} */
function emptyTally() {
  return { agree: 0, disagree: 0, error: 0, na: 0 };
}

/**
 * @param {import('./corpus.mjs').CorpusCase} c
 * @param {EngineAdapter} adapter
 * @returns {Promise<Cell>}
 */
export async function runCell(c, adapter) {
  const question = c.expected === 'invalid' ? adapter.audit : adapter.validate;
  if (!question) {
    return { verdict: 'n/a', agrees: null, detail: c.expected === 'invalid' ? 'engine has no document audit' : 'engine has no model validation' };
  }
  try {
    const answer = await question.call(adapter, { id: c.id, idsPath: c.idsPath, ifcPath: c.ifcPath });
    const { verdict, detail } = typeof answer === 'string' ? { verdict: answer, detail: undefined } : answer;
    // An audit answers 'valid'/'invalid'; only `invalid-` cases are audited.
    const agrees = c.expected === 'invalid' ? verdict === 'invalid' : verdict === c.expected;
    return detail === undefined ? { verdict, agrees } : { verdict, agrees, detail };
  } catch (err) {
    if (err instanceof UnsupportedCase) return { verdict: 'n/a', agrees: null, detail: err.message };
    return { verdict: 'error', agrees: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** @param {Tally} t @param {Cell} cell */
function count(t, cell) {
  if (cell.verdict === 'n/a') t.na++;
  else if (cell.verdict === 'error') t.error++;
  else if (cell.agrees) t.agree++;
  else t.disagree++;
}

/**
 * Run every adapter over every case, sequentially (engines are not assumed
 * to be re-entrant), and summarise.
 * @param {import('./corpus.mjs').CorpusCase[]} cases
 * @param {EngineAdapter[]} adapters
 * @param {{ corpus: { name: string, licence: string, source: string }, onCase?: (done: number, total: number) => void }} meta
 */
export async function buildMatrix(cases, adapters, meta) {
  const rows = [];
  for (const [index, c] of cases.entries()) {
    /** @type {Record<string, Cell>} */
    const cells = {};
    for (const adapter of adapters) cells[adapter.info.id] = await runCell(c, adapter);
    rows.push({ id: c.id, group: c.group, expected: c.expected, cells });
    meta.onCase?.(index + 1, cases.length);
  }
  return {
    schema: 'ifc-lite/ids-conformance-matrix@1',
    corpus: { ...meta.corpus, cases: cases.length },
    engines: adapters.map((a) => a.info),
    summary: summarise(rows, adapters.map((a) => a.info.id)),
    cases: rows,
  };
}

/**
 * Per engine: overall, per expected verdict and per corpus group (facet).
 * @param {{ group: string, expected: string, cells: Record<string, Cell> }[]} rows
 * @param {string[]} engineIds
 */
export function summarise(rows, engineIds) {
  /** @type {Record<string, { overall: Tally, byExpected: Record<string, Tally>, byGroup: Record<string, Tally> }>} */
  const out = {};
  for (const id of engineIds) {
    const s = { overall: emptyTally(), byExpected: {}, byGroup: {} };
    for (const row of rows) {
      const cell = row.cells[id];
      if (!cell) continue;
      count(s.overall, cell);
      count((s.byExpected[row.expected] ??= emptyTally()), cell);
      count((s.byGroup[row.group] ??= emptyTally()), cell);
    }
    out[id] = s;
  }
  return out;
}
