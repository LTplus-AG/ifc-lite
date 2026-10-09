/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { ACT_TOOLS } from './act-tools.js';
import { IDS_READ_TOOLS } from './ids-read.js';
import { ASK_USER_TOOLS } from './ask-user.js';
import { createToolRegistry, type ToolOutcome } from './registry.js';
import { createSandbox } from '../sandbox/sandbox.js';
import { MODES } from '../modes.js';
import { doorDoc, doorOps, emptyDoc, entity, sandboxFor, schemaContexts, toolContext } from '../../test/helpers.js';

const registry = createToolRegistry([...IDS_READ_TOOLS, ...ACT_TOOLS, ...ASK_USER_TOOLS]);
type Data = Record<string, unknown>;
const data = (o: ToolOutcome) => o.data as Data;

describe('ids_apply_ops', () => {
  it('applies a gated batch, resolves handles to stable ids and reports the diagnostics delta', async () => {
    const sandbox = await sandboxFor();
    const ctx = await toolContext(sandbox);
    const out = await registry.call('ids_apply_ops', { ops: doorOps(), rationale: 'r', sources: [{ quote: 'Doors must have a fire rating.', page: 3 }] }, undefined, ctx);
    expect(out.ok).toBe(true);
    const handles = data(out).handles as Record<string, string>;
    expect(Object.keys(handles).sort()).toEqual(['@doors', '@doors-app', '@doors-req']);
    expect(sandbox.doc.nodes.specs[0].id).toBe(handles['@doors']);
    expect(sandbox.batches[0]).toMatchObject({ id: 'b1', origin: 'apply_ops', rationale: 'r', specIds: [handles['@doors']],
      sources: [{ quote: 'Doors must have a fire rating.', page: 3 }] });
    expect(sandbox.batches[0].ops.every((op) => /^[0-9a-f-]{36}$/.test(op.opId))).toBe(true);
    expect(data(out).diagnostics).toMatchObject({ resolvedCount: 0 });

    // A later batch can address the node by the same handle.
    const more = await registry.call('ids_apply_ops', { ops: [{ kind: 'spec.set', payload: { specId: '@doors', field: 'description', value: 'All doors' } }] }, undefined, ctx);
    expect(more.ok).toBe(true);
    expect(sandbox.doc.ids.specifications[0].description).toBe('All doors');
  });

  it('applies nothing when any op of the batch is refused', async () => {
    const sandbox = await sandboxFor();
    const ctx = await toolContext(sandbox);
    const ops = [...doorOps(), { kind: 'facet.add', payload: { specId: '@doors', section: 'requirements', facetId: '@bad', facet: { type: 'attribute', name: { kind: 'equals', value: 'FireProofness' } } } }];
    const out = await registry.call('ids_apply_ops', { ops }, undefined, ctx);
    expect(out.ok).toBe(false);
    expect(out.signature?.[0]).toMatch(/^GATE-ATT-001:/);
    expect(sandbox.doc.ids.specifications).toHaveLength(0);
    expect(sandbox.batches).toHaveLength(0);
  });

  it('refuses fidelity ops the reducer only emits as inverses', async () => {
    const sandbox = await sandboxFor();
    const outcome = sandbox.apply([{ kind: 'spec.patch', opId: '0190e2c4-5f6a-7b8c-9d0e-1f2a3b4c5d6e', payload: {} }], { origin: 'apply_ops' });
    expect(outcome).toMatchObject({ applied: false, refusals: [{ code: 'AGENT-OP-001' }] });
  });

  it('refuses ops outside a mode\'s op guard (Translate writes text only)', async () => {
    const { doc, specId } = doorDoc();
    const { gate, lint } = await schemaContexts();
    const sandbox = createSandbox({ doc, gate, lint, runId: 'r', model: 'm', ...(MODES.translate.opGuard ? { opGuard: MODES.translate.opGuard } : {}) });
    expect(sandbox.apply([{ kind: 'spec.set', payload: { specId, field: 'name', value: 'Türen' } }], { origin: 'apply_ops' }).applied).toBe(true);
    const refused = sandbox.apply([{ kind: 'spec.set', payload: { specId, field: 'identifier', value: 'X' } }], { origin: 'apply_ops' });
    expect(refused).toMatchObject({ applied: false, refusals: [{ code: 'AGENT-MODE-001' }] });
    const value = sandbox.apply([{ kind: 'facet.add', payload: { specId, section: 'applicability', facetId: '@w', facet: entity('IfcWall') } }], { origin: 'apply_ops' });
    expect(value).toMatchObject({ applied: false, refusals: [{ code: 'AGENT-MODE-001' }] });
  });
});

describe('ids_undo, ids_lint, ids_apply_fix, ids_mark_unresolved', () => {
  it('undo reverts whole batches', async () => {
    const sandbox = await sandboxFor();
    const ctx = await toolContext(sandbox);
    await registry.call('ids_apply_ops', { ops: doorOps() }, undefined, ctx);
    await registry.call('ids_apply_ops', { ops: doorOps('Pset_DoorCommon', 'FireRating', '@more') }, undefined, ctx);
    const out = await registry.call('ids_undo', { steps: 5 }, undefined, ctx);
    expect(data(out)).toMatchObject({ undone: 2, remainingBatches: 0 });
    expect(sandbox.doc.ids.specifications).toHaveLength(0);
  });

  it('lint lists diagnostics with stable ids; apply_fix applies a quick fix through the gate', async () => {
    const sandbox = await sandboxFor();
    const ctx = await toolContext(sandbox);
    // An anchored pattern triggers a lint rule with a quick fix.
    await registry.call('ids_apply_ops', { ops: [
      { kind: 'spec.add', payload: { specId: '@s', name: 'Walls', ifcVersions: ['IFC4'] } },
      { kind: 'facet.add', payload: { specId: '@s', section: 'applicability', facetId: '@a', facet: entity('IfcWall') } },
      { kind: 'facet.add', payload: { specId: '@s', section: 'requirements', facetId: '@r', facet: { type: 'attribute', name: { kind: 'equals', value: 'Name' }, value: { kind: 'pattern', pattern: '^W-[0-9]+$' } } } },
    ] }, undefined, ctx);
    const lint = data(await registry.call('ids_lint', {}, undefined, ctx));
    const diagnostics = lint.diagnostics as { diagnosticId: string; code: string; fixes: string[] }[];
    const anchored = diagnostics.find((d) => d.code === 'IDSL-REGEX-001');
    expect(anchored?.fixes.length).toBeGreaterThan(0);
    const fixed = await registry.call('ids_apply_fix', { diagnosticId: anchored?.diagnosticId, fixIndex: 0 }, undefined, ctx);
    expect(fixed.ok).toBe(true);
    expect(sandbox.batches[1]).toMatchObject({ origin: 'apply_fix', fix: { code: 'IDSL-REGEX-001' } });
    expect(sandbox.diagnostics().some((d) => d.code === 'IDSL-REGEX-001')).toBe(false);

    const unknown = await registry.call('ids_apply_fix', { diagnosticId: 'IDSL-X@nothing', fixIndex: 0 }, undefined, ctx);
    expect(unknown.ok).toBe(false);
  });

  it('mark_unresolved records the statement in the proposal, not the document', async () => {
    const sandbox = await sandboxFor();
    const ctx = await toolContext(sandbox);
    const out = await registry.call('ids_mark_unresolved', { statement: 'Escape routes are at most 35 m long.', category: 'geometry', reason: 'Lengths along a path are geometry.' }, undefined, ctx);
    expect(data(out)).toMatchObject({ id: 'u1', unresolvedCount: 1 });
    expect(sandbox.unresolved[0]).toMatchObject({ category: 'geometry' });
    expect(sandbox.doc.ids.specifications).toHaveLength(0);
    const bad = await registry.call('ids_mark_unresolved', { statement: 's', category: 'vibes', reason: 'r' }, undefined, ctx);
    expect(bad.ok).toBe(false);
  });

  it('ids_read returns summaries with node ids, full content and plain text', async () => {
    const { doc, specId } = doorDoc();
    const ctx = await toolContext(await sandboxFor(doc));
    const summary = data(await registry.call('ids_read', { view: 'summary' }, undefined, ctx));
    expect(summary).toMatchObject({ specificationCount: 1, specifications: [{ specId, name: 'Doors', cardinality: 'required' }] });
    const full = data(await registry.call('ids_read', { view: 'full', specIds: [specId] }, undefined, ctx));
    expect((full.specifications as unknown[])).toHaveLength(1);
    const plain = data(await registry.call('ids_read', { view: 'plain' }, undefined, ctx));
    expect(plain.text).toContain('Doors');
    expect(emptyDoc().ids.specifications).toHaveLength(0);
  });
});

describe('ids_ask_user', () => {
  const choices = [
    { label: 'Door common set', ops: doorOps('Pset_DoorCommon', 'FireRating', '@a') },
    { label: 'Nothing', ops: [] },
  ];

  it('gates every choice before asking and applies the picked one', async () => {
    const sandbox = await sandboxFor();
    const asked: string[][] = [];
    const ctx = await toolContext(sandbox, { askUser: async (q) => { asked.push(q.choices.map((c) => c.label)); return 0; } });
    const out = await registry.call('ids_ask_user', { question: 'Which?', choices }, undefined, ctx);
    expect(out.ok).toBe(true);
    expect(asked).toEqual([['Door common set', 'Nothing']]);
    expect(sandbox.batches[0]).toMatchObject({ origin: 'ask_user' });
  });

  it('never shows the user an ungrounded choice', async () => {
    const sandbox = await sandboxFor();
    let asked = false;
    const ctx = await toolContext(sandbox, { askUser: async () => { asked = true; return 0; } });
    const out = await registry.call('ids_ask_user', { question: 'Which?', choices: [choices[0], { label: 'Invented', ops: doorOps('Pset_DoorMagic', 'FireRating', '@b') }] }, undefined, ctx);
    expect(out.ok).toBe(false);
    expect(asked).toBe(false);
    expect(sandbox.batches).toHaveLength(0);
  });

  it('a dismissed question or an empty choice applies nothing; more than four choices are refused', async () => {
    const sandbox = await sandboxFor();
    const dismissed = await registry.call('ids_ask_user', { question: 'Which?', choices }, undefined, await toolContext(sandbox, { askUser: async () => null }));
    expect(data(dismissed)).toMatchObject({ answered: false });
    const empty = await registry.call('ids_ask_user', { question: 'Which?', choices }, undefined, await toolContext(sandbox, { askUser: async () => 1 }));
    expect(data(empty)).toMatchObject({ answered: true, applied: false });
    expect(sandbox.batches).toHaveLength(0);
    const five = Array.from({ length: 5 }, (_, i) => ({ label: `c${i}`, ops: [] }));
    expect((await registry.call('ids_ask_user', { question: 'q', choices: five }, undefined, await toolContext(sandbox))).ok).toBe(false);
  });
});
