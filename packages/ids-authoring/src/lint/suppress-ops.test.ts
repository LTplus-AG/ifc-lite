/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'vitest';
import { counterIds } from '../../test/corpus.js';
import { docFromXml, entity, idsXml, property, specXml } from '../../test/lint-helpers.js';
import type { StudioDocument, Suppression } from '../document/types.js';
import { checkOps } from '../gate/check.js';
import { commit, createStudioState, undo } from '../history/history.js';
import { validateOp } from '../ops/schema.js';
import type { StudioOp } from '../ops/types.js';
import { apply, OpApplyError } from '../reducer/apply.js';
import { createLintContext } from './context.js';
import { createLinter } from './engine.js';
import type { LintContext } from './types.js';

let ctx: LintContext;
beforeAll(async () => {
  ctx = await createLintContext();
});

const ids = counterIds(0x5e9);
const AT = '2026-10-11T00:00:00Z';
const SPEC_008 = 'IDSL-SPEC-008';

function doc(): StudioDocument {
  return docFromXml(idsXml(specXml(entity('IFCWALL'), property('Pset_WallCommon', 'IsExternal'), 'ifcVersion="IFC4"', 'Walls')));
}

function suppress(nodeId: string, rule: string, reason = 'Reviewed with the client', index?: number): StudioOp {
  const suppression: Suppression = { rule, reason, by: 'a@example.com', at: AT };
  return { kind: 'meta.suppress', opId: ids(), payload: { nodeId, suppression, ...(index === undefined ? {} : { index }) } };
}

function unsuppress(nodeId: string, rule: string): StudioOp {
  return { kind: 'meta.unsuppress', opId: ids(), payload: { nodeId, rule } };
}

/** SPEC-008 is opt-in; enable it so there is a finding to suppress. */
const lint = (d: StudioDocument) => createLinter(ctx, { severity: { [SPEC_008]: 'info' } }).lint(d);

/** apply then the inverses gives back the input exactly. */
function roundTrips(d: StudioDocument, ops: StudioOp[]): StudioDocument {
  const forward = apply(d, ops);
  for (const inv of forward.inverses) expect(validateOp(inv).ok, inv.kind).toBe(true);
  expect(apply(forward.doc, forward.inverses).doc).toEqual(d);
  return forward.doc;
}

describe('meta.suppress / meta.unsuppress (#7144)', () => {
  it('writes the suppression the linter reads, and undo brings the finding back', () => {
    const d0 = doc();
    const specId = d0.nodes.specs[0].id;
    expect(lint(d0).diagnostics.map((d) => d.code)).toContain(SPEC_008);

    const ops = [suppress(specId, SPEC_008)];
    expect(checkOps(ops, d0, ctx.gate)).toEqual({ ok: true, issues: [] });
    const s1 = commit(createStudioState(d0), ops, { label: 'Suppress SPEC-008' }).state;
    expect(s1.doc.meta.suppressions[specId]).toEqual([{ rule: SPEC_008, reason: 'Reviewed with the client', by: 'a@example.com', at: AT }]);
    const after = lint(s1.doc);
    expect(after.diagnostics.map((d) => d.code)).not.toContain(SPEC_008);
    expect(after.suppressed).toMatchObject([{ diagnostic: { code: SPEC_008 }, suppressedAt: specId }]);

    const s2 = undo(s1);
    expect(s2.doc).toEqual(d0);
    expect(lint(s2.doc).diagnostics.map((d) => d.code)).toContain(SPEC_008);
  });

  it('suppresses below the node it is attached to, with wildcards', () => {
    const d0 = doc();
    const after = apply(d0, [suppress(d0.nodes.document, 'IDSL-SPEC-*')]).doc;
    expect(lint(after).suppressed.map((s) => s.diagnostic.code)).toContain(SPEC_008);
    expect(lint(after).suppressed[0].suppressedAt).toBe(d0.nodes.document);
  });

  it('inserts at an index, replaces the same rule in place and undoes both exactly', () => {
    const d0 = doc();
    const node = d0.nodes.specs[0].requirements[0].id;
    const d1 = roundTrips(d0, [suppress(node, 'IDSL-PROP-001'), suppress(node, 'IDSL-PSET-*'), suppress(node, 'IDSL-*', 'All of it', 0)]);
    expect(d1.meta.suppressions[node].map((s) => s.rule)).toEqual(['IDSL-*', 'IDSL-PROP-001', 'IDSL-PSET-*']);
    const d2 = roundTrips(d1, [suppress(node, 'IDSL-PROP-001', 'Changed reason')]);
    expect(d2.meta.suppressions[node].map((s) => [s.rule, s.reason])).toEqual([
      ['IDSL-*', 'All of it'],
      ['IDSL-PROP-001', 'Changed reason'],
      ['IDSL-PSET-*', 'Reviewed with the client'],
    ]);
  });

  it('removes a suppression, drops an emptied entry, and restores it at its index on undo', () => {
    const d0 = doc();
    const node = d0.nodes.specs[0].id;
    const d1 = apply(d0, [suppress(node, 'IDSL-SPEC-007'), suppress(node, SPEC_008)]).doc;
    const d2 = roundTrips(d1, [unsuppress(node, 'IDSL-SPEC-007')]);
    expect(d2.meta.suppressions[node].map((s) => s.rule)).toEqual([SPEC_008]);
    const d3 = roundTrips(d2, [unsuppress(node, SPEC_008)]);
    expect(node in d3.meta.suppressions).toBe(false);
    expect(d3.meta.suppressions).toEqual(d0.meta.suppressions);
  });

  it('keeps a pre-existing empty list exact through suppress and undo', () => {
    const base = doc();
    const node = base.nodes.specs[0].id;
    const d0: StudioDocument = { ...base, meta: { ...base.meta, suppressions: { [node]: [] } } };
    const forward = apply(d0, [suppress(node, SPEC_008)]);
    expect(forward.inverses[0]).toMatchObject({ kind: 'meta.unsuppress', payload: { keepEmpty: true } });
    expect(apply(forward.doc, forward.inverses).doc).toEqual(d0);
  });

  it('undoes the removal of an imported suppression the gate would not accept today', () => {
    const base = doc();
    const orphan = ids();
    const legacy: Suppression = { rule: 'old-free-form', reason: '', at: AT };
    const d0: StudioDocument = { ...base, meta: { ...base.meta, suppressions: { [orphan]: [legacy] } } };
    roundTrips(d0, [unsuppress(orphan, 'old-free-form')]);
  });

  it('is refused by the gate for an unknown node, a non-lint rule or a blank reason', () => {
    const d0 = doc();
    const specId = d0.nodes.specs[0].id;
    const codes = (ops: unknown[]) => checkOps(ops, d0, ctx.gate).issues.map((i) => [i.code, i.path]);
    expect(codes([suppress(ids(), SPEC_008)])).toEqual([['GATE-STR-001', 'ops[0].payload.nodeId']]);
    for (const rule of ['SPEC-008', 'IDSL-spec-008', 'IDSL-SPEC-8', 'IDSL-SPEC-008 ', 'GATE-ENT-001', '']) {
      expect(codes([suppress(specId, rule)]), rule).toEqual([['GATE-SUP-001', 'ops[0].payload.suppression.rule']]);
    }
    expect(codes([suppress(specId, SPEC_008, '   ')])).toEqual([['GATE-SUP-002', 'ops[0].payload.suppression.reason']]);
    expect(codes([unsuppress(specId, SPEC_008)])).toEqual([['GATE-SUP-003', 'ops[0]']]);
    // Shape errors: the reason and timestamp are required.
    const bare = { kind: 'meta.suppress', opId: ids(), payload: { nodeId: specId, suppression: { rule: SPEC_008 } } };
    expect(checkOps([bare], d0, ctx.gate).issues.map((i) => i.code)).toEqual(['GATE-OP-001', 'GATE-OP-001']);
    // A batch can suppress and then unsuppress the same rule.
    expect(checkOps([suppress(specId, SPEC_008), unsuppress(specId, SPEC_008)], d0, ctx.gate).ok).toBe(true);
  });

  it('throws OpApplyError from the reducer when there is nothing to remove', () => {
    const d0 = doc();
    expect(() => apply(d0, [unsuppress(d0.nodes.specs[0].id, SPEC_008)])).toThrow(OpApplyError);
    expect(() => apply(d0, [suppress(d0.nodes.specs[0].id, SPEC_008, 'r', 5)])).toThrow(/out of range/);
  });
});
