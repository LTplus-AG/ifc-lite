/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hard rule (ADR-002/003, ADR-008): the agent changes a document ONLY
 * through `ids_apply_ops`, and that goes through the grounding gate. A
 * hallucinated name is refused, nothing is applied, and the refusal (with
 * candidates) is fed back to the model, which corrects itself.
 */

import { describe, expect, it } from 'vitest';
import { lastResults, scriptedTransport, toolCall, turn } from '../testing/index.js';
import { doorOps, emptyDoc, schemaContexts } from '../../test/helpers.js';
import { runAgent } from './loop.js';

describe('grounding gate in the loop', () => {
  it('refuses a hallucinated property set, feeds the refusal back, and applies only the corrected batch', async () => {
    const { gate, lint } = await schemaContexts();
    const doc = emptyDoc();
    const seen: { isError: boolean; data: unknown }[] = [];
    const { transport, calls } = scriptedTransport([
      turn([toolCall('ids_apply_ops', { ops: doorOps('Pset_DoorFireSafety', 'FireRating'), rationale: 'Doors need a fire rating.' })]),
      (call) => {
        seen.push(...lastResults(call));
        return turn([toolCall('ids_apply_ops', { ops: doorOps('Pset_DoorCommon', 'FireRating'), rationale: 'Doors need a fire rating.' })]);
      },
      (call) => {
        seen.push(...lastResults(call));
        return turn([{ type: 'text', text: 'Added one specification for door fire ratings.' }]);
      },
    ]);
    const run = await runAgent({ transport, mode: 'draft', request: 'Doors must have a fire rating.', doc, gate, lint });

    expect(run.status).toBe('completed');
    expect(calls).toHaveLength(3);
    // The first batch was refused and the model was told why, with candidates.
    expect(seen[0].isError).toBe(true);
    expect(seen[0].data).toMatchObject({ ok: false, applied: false });
    const issues = (seen[0].data as { issues: { code: string; value?: string; candidates: string[] }[] }).issues;
    expect(issues.some((i) => i.code === 'GATE-PSET-001' && i.value === 'Pset_DoorFireSafety')).toBe(true);
    expect(issues.find((i) => i.code === 'GATE-PSET-001')?.candidates.length).toBeGreaterThan(0);
    // The corrected batch went through.
    expect(seen[1]).toMatchObject({ isError: false, data: { ok: true, applied: true, batchId: 'b1' } });

    // Only the gated batch reached the sandbox; the hallucinated name appears nowhere.
    expect(run.proposal.batches).toHaveLength(1);
    expect(JSON.stringify(run.proposal.draft.ids)).not.toContain('Pset_DoorFireSafety');
    expect(run.proposal.draft.ids.specifications.map((s) => s.name)).toEqual(['Door fire rating']);
    // The user's document is untouched: a proposal, not a mutation.
    expect(doc.ids.specifications).toHaveLength(0);
    expect(run.proposal.summary).toBe('Added one specification for door fire ratings.');
  });

  it('refuses a hallucinated property and entity in the same way', async () => {
    const { gate, lint } = await schemaContexts();
    const { transport } = scriptedTransport([
      turn([toolCall('ids_apply_ops', { ops: doorOps('Pset_DoorCommon', 'FireRatingClass') })]),
      turn([toolCall('ids_apply_ops', { ops: [{ kind: 'spec.add', payload: { specId: '@s', name: 'X', ifcVersions: ['IFC4'] } },
        { kind: 'facet.add', payload: { specId: '@s', section: 'applicability', facetId: '@f', facet: { type: 'entity', name: { kind: 'equals', value: 'IfcFireDoor' } } } }] })]),
      (call) => turn([{ type: 'text', text: JSON.stringify(lastResults(call)) }]),
    ]);
    const run = await runAgent({ transport, mode: 'draft', request: 'x', doc: emptyDoc(), gate, lint });
    const toolMessages = run.transcript.filter((m) => m.role === 'tool');
    const codes = toolMessages.flatMap((m) => (m.role === 'tool' ? m.results.map((r) => (JSON.parse(r.content) as { issues: { code: string }[] }).issues.map((i) => i.code)) : []));
    expect(codes[0]).toContain('GATE-PROP-001');
    expect(codes[1]).toContain('GATE-ENT-001');
    expect(run.proposal.batches).toHaveLength(0);
  });

  it('offers no tool that writes the document other than through the sandbox gate', async () => {
    const { ALL_TOOLS } = await import('../tools/index.js');
    const writers = ALL_TOOLS.filter((t) => !t.readOnly).map((t) => t.name).sort();
    // Each of these writes only via `sandbox.apply` (gate → reducer) or records proposal metadata.
    expect(writers).toEqual(['ids_apply_fix', 'ids_apply_ops', 'ids_ask_user', 'ids_mark_unresolved', 'ids_undo']);
  });
});
