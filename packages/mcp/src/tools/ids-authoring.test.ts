/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS authoring over MCP (IDS-118), driven through the real server and
 * JSON-RPC dispatch, the way an external agent sees it.
 *
 * The hard rule under test: `ids_apply_ops` goes through `validateOp` and
 * the grounding gate. A batch with a hallucinated name is refused, nothing
 * is applied, and the refusal reason (code, path, candidates) reaches the
 * caller in both the text and the structured result.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '../protocol/index.js';
import { liveToolSession } from '../test/live-tool-session.js';

type Session = Awaited<ReturnType<typeof liveToolSession>>;
let session: Session;

beforeAll(async () => {
  session = await liveToolSession(0);
});

const SPEC = '00000000-0000-7000-8000-000000000001';

function doorBatch(property: string): unknown[] {
  return [
    { kind: 'spec.add', opId: '00000000-0000-7000-8000-0000000000a1', payload: { specId: SPEC, name: 'Fire rating on doors', ifcVersions: ['IFC4'] } },
    {
      kind: 'facet.add',
      opId: '00000000-0000-7000-8000-0000000000a2',
      payload: { specId: SPEC, section: 'applicability', facetId: '00000000-0000-7000-8000-000000000002', facet: { type: 'entity', name: { kind: 'equals', value: 'IfcDoor' } } },
    },
    {
      kind: 'facet.add',
      opId: '00000000-0000-7000-8000-0000000000a3',
      payload: {
        specId: SPEC,
        section: 'requirements',
        facetId: '00000000-0000-7000-8000-000000000003',
        facet: { type: 'property', propertySet: { kind: 'equals', value: 'Pset_DoorCommon' }, baseName: { kind: 'equals', value: property } },
      },
    },
  ];
}

const text = (r: CallToolResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('\n');
const structured = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;

describe('MCP ids_apply_ops goes through the grounding gate', () => {
  it('refuses a hallucinated property and returns the reason to the caller', async () => {
    const r = await session.call('ids_apply_ops', { title: 'Doors', ops: doorBatch('FireResistanceRating') });
    expect(r.isError).toBe(true);
    const s = structured(r);
    expect(s.code).toBe('INVALID_INPUT');
    const details = s.details as { refused: boolean; issues: Array<{ code: string; path: string; candidates: Array<{ value: string }> }> };
    expect(details.refused).toBe(true);
    expect(details.issues[0]).toMatchObject({ code: 'GATE-PROP-001', path: 'ops[2].payload.facet.baseName' });
    expect(details.issues[0].candidates.map((c) => c.value)).toContain('FireRating');
    // An agent that reads only the text still gets the reason and the fix.
    expect(text(r)).toContain('nothing was applied');
    expect(text(r)).toContain('GATE-PROP-001 at ops[2].payload.facet.baseName');
    expect(text(r)).toMatch(/Did you mean: [^?]*FireRating/);
  });

  it('refuses a hallucinated entity in an existing document and leaves it unchanged', async () => {
    const created = await session.call('ids_apply_ops', { title: 'Doors', ops: doorBatch('FireRating') });
    const doc = structured(created).doc;
    const r = await session.call('ids_apply_ops', {
      doc,
      ops: [{ kind: 'facet.replace', opId: '00000000-0000-7000-8000-0000000000b1', payload: { facetId: '00000000-0000-7000-8000-000000000002', facet: { type: 'entity', name: { kind: 'equals', value: 'IfcFireDoor' } } } }],
    });
    expect(r.isError).toBe(true);
    expect((structured(r).details as { issues: Array<{ code: string }> }).issues[0].code).toBe('GATE-ENT-001');
  });

  it('refuses an op that is not in the vocabulary (validateOp)', async () => {
    const r = await session.call('ids_apply_ops', { ops: [{ kind: 'spec.explode', opId: '00000000-0000-7000-8000-0000000000c1', payload: {} }] });
    expect(r.isError).toBe(true);
    expect((structured(r).details as { issues: Array<{ code: string }> }).issues[0].code).toBe('GATE-OP-001');
  });

  it('applies a grounded batch, and the document lints, writes and reads back', async () => {
    const applied = await session.call('ids_apply_ops', { title: 'Doors', ops: doorBatch('FireRating') });
    expect(applied.isError).toBeFalsy();
    const doc = structured(applied).doc as { ids: { specifications: Array<{ name: string }> } };
    expect(doc.ids.specifications.map((s) => s.name)).toEqual(['Fire rating on doors']);
    expect(structured(applied).applied).toBe(3);

    const lint = await session.call('ids_lint', { doc });
    expect((structured(lint).counts as { error: number }).error).toBe(0);

    const written = await session.call('ids_write', { doc });
    expect(written.isError).toBeFalsy();
    const xml = structured(written).xml as string;
    expect(xml).toContain('<simpleValue>FireRating</simpleValue>');
    expect(JSON.parse(structured(written).sidecar as string)).toMatchObject({ format: 'ifc-lite.ids-studio.sidecar' });

    const audit = await session.call('ids_audit', { ids_xml: xml });
    expect(structured(audit).status).toBe('valid');

    const first = await session.call('ids_read', { ids_xml: xml });
    const again = await session.call('ids_read', { ids_xml: xml });
    expect(structured(again).doc).toEqual(structured(first).doc);
    expect((structured(first).outline as Array<{ name: string }>)[0].name).toBe('Fire rating on doors');
  });

  it('ids_write refuses a document whose JSON was edited past the gate', async () => {
    const applied = await session.call('ids_apply_ops', { title: 'Doors', ops: doorBatch('FireRating') });
    const doc = structuredClone(structured(applied).doc) as { ids: { specifications: Array<{ requirements: Array<{ facet: { baseName: { value: string } } }> }> } };
    doc.ids.specifications[0].requirements[0].facet.baseName.value = 'FireResistanceRating';
    const r = await session.call('ids_write', { doc });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('fails the IDS audit');
  });

  it('lint returns quick fixes as op batches that ids_apply_ops accepts', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema"><info><title>t</title></info><specifications>
<specification name="Walls" ifcVersion="IFC4"><applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
<requirements><attribute cardinality="required"><name><simpleValue>Name</simpleValue></name><value><simpleValue>Wall </simpleValue></value></attribute></requirements></specification>
</specifications></ids>`;
    const read = await session.call('ids_read', { ids_xml: xml });
    const doc = structured(read).doc;
    const lint = await session.call('ids_lint', { doc, rules: ['IDSL-VAL-006'] });
    const diagnostics = structured(lint).diagnostics as Array<{ code: string; path: string; fixes: Array<{ ops: unknown[] }> }>;
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].path).toBe('specifications[0].requirements[0].value');
    const fixed = await session.call('ids_apply_ops', { doc, ops: diagnostics[0].fixes[0].ops });
    expect(fixed.isError).toBeFalsy();
    const relint = await session.call('ids_lint', { doc: structured(fixed).doc, rules: ['IDSL-VAL-006'] });
    expect(structured(relint).diagnostics).toEqual([]);
  });

  it('rejects a doc argument that is not a Studio document', async () => {
    const r = await session.call('ids_lint', { doc: { hello: 'world' } });
    expect(r.isError).toBe(true);
    expect(structured(r).code).toBe('INVALID_INPUT');
  });
});

describe('MCP ids_schema_* lookups', () => {
  it('finds and describes the names the gate accepts', async () => {
    const search = await session.call('ids_schema_search', { query: 'FireResistanceRating', kind: 'property' });
    expect((structured(search).hits as Array<{ value: string }>).map((h) => h.value)).toContain('FireRating');
    const entity = await session.call('ids_schema_entity', { name: 'IFCDOOR' });
    expect((structured(entity).entity as { propertySets: string[] }).propertySets).toContain('Pset_DoorCommon');
    const pset = await session.call('ids_schema_pset', { name: 'Pset_DoorCommon' });
    expect((structured(pset).pset as { properties: Array<{ name: string }> }).properties.map((p) => p.name)).toContain('FireRating');
  });

  it('answers an unknown name with candidates instead of a description', async () => {
    const r = await session.call('ids_schema_entity', { name: 'IfcFireDoor' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Did you mean');
  });
});

describe('tools/list', () => {
  it('advertises the op JSON Schema on ids_apply_ops', async () => {
    const listed = (await session.transport.send({ jsonrpc: '2.0', id: 999, method: 'tools/list', params: {} })) as {
      result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    };
    const names = listed.result.tools.map((t) => t.name);
    for (const n of ['ids_audit', 'ids_lint', 'ids_read', 'ids_apply_ops', 'ids_write', 'ids_schema_search', 'ids_schema_entity', 'ids_schema_pset']) {
      expect(names).toContain(n);
    }
    const apply = listed.result.tools.find((t) => t.name === 'ids_apply_ops')!;
    expect(apply.inputSchema.$defs).toHaveProperty('Op_spec_add');
    expect(apply.inputSchema).not.toHaveProperty('oneOf');
  });
});
