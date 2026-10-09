/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ids.load` → `ids.lint` → `ids.validate` (IDS-122), run through
 * `runFlow` with the real IDS validator over a small hand-written model
 * accessor: two walls, one with a Name and one without. The failures
 * table must carry exactly the unnamed wall, with the `title` /
 * `description` columns `bcf.createTopic` reads.
 */

import { describe, expect, it } from 'vitest';
import { runFlow, type FlowDocument, type FlowEdge, type FlowNode, type Table } from '@ifc-lite/flow';
import type { IFCDataAccessor } from '@ifc-lite/ids';
import { createFakeBim } from './__tests__/fake-backend.js';
import { createStandardRegistry, headlessFeatures, type FlowHost } from './index.js';

const registry = createStandardRegistry();

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
<info><title>Walls</title></info>
<specifications>
<specification name="Walls are named" ifcVersion="IFC4">
<applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
<requirements><attribute cardinality="required"><name><simpleValue>Name</simpleValue></name></attribute></requirements>
</specification>
</specifications>
</ids>`;

/** Wall 1 is named, wall 2 is not. */
const accessor: IFCDataAccessor = {
  getEntityType: (id) => (id === 1 || id === 2 ? 'IfcWall' : undefined),
  getEntityName: (id) => (id === 1 ? 'Wall A' : undefined),
  getGlobalId: (id) => (id === 1 ? '1wallAAAAAAAAAAAAAAAAA' : '2wallBBBBBBBBBBBBBBBBB'),
  getDescription: () => undefined,
  getObjectType: () => undefined,
  getEntitiesByType: (type) => (type.toUpperCase() === 'IFCWALL' ? [1, 2] : []),
  getAllEntityIds: () => [1, 2],
  getPropertyValue: () => undefined,
  getPropertySets: () => [],
  getClassifications: () => [],
  getMaterials: () => [],
  getParent: () => undefined,
  getAttribute: (id, name) => (name === 'Name' && id === 1 ? 'Wall A' : undefined),
};

function graph(nodes: FlowNode[], edges: FlowEdge[] = []): FlowDocument {
  return { flowVersion: 1, id: 'g', name: 'g', capabilities: ['model.read'], inputs: [], outputs: [], nodes, edges };
}

const edge = (from: string, fromPort: string, to: string, toPort: string): FlowEdge => ({ from: [from, fromPort], to: [to, toPort] });

function host(extra: Partial<FlowHost> = {}): FlowHost {
  return { bim: createFakeBim().bim, idsAccessor: () => accessor, ...extra };
}

const out = (r: Awaited<ReturnType<typeof runFlow>>, node: string, port: string) => {
  const data = r.outputs.get(node)?.get(port);
  if (data?.kind !== 'item') throw new Error(`${node}.${port}: expected an item, got ${JSON.stringify(data)}`);
  return data.value;
};

const PIPELINE = graph(
  [
    { id: 'load', type: 'ids.load', params: { xml: XML } },
    { id: 'lint', type: 'ids.lint', params: {} },
    { id: 'check', type: 'ids.validate', params: {} },
  ],
  [edge('load', 'ids', 'lint', 'ids'), edge('load', 'ids', 'check', 'ids')],
);

describe('ids.* flow nodes', () => {
  it('loads, lints and validates; failures are BCF-ready rows for the failing element only', async () => {
    const r = await runFlow(PIPELINE, { host: host(), registry, features: headlessFeatures() });
    expect(r.ok, JSON.stringify(r.log)).toBe(true);
    expect(out(r, 'load', 'title')).toBe('Walls');
    expect(out(r, 'lint', 'errors')).toBe(0);
    const failures = out(r, 'check', 'failures') as Table;
    expect(failures.rows).toHaveLength(1);
    expect(failures.rows[0]).toMatchObject({ specification: 'Walls are named', globalId: '2wallBBBBBBBBBBBBBBBBB', ifcType: 'IfcWall' });
    expect(String(failures.rows[0].title)).toContain('Walls are named');
    expect(String(failures.rows[0].description).length).toBeGreaterThan(0);
    expect(failures.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['title', 'description']));
    expect(out(r, 'check', 'failed')).toBe(1);
  });

  it('lint reports a misspelt property by XML path and can fail the run', async () => {
    const typo = XML.replace(
      '<attribute cardinality="required"><name><simpleValue>Name</simpleValue></name></attribute>',
      '<property cardinality="required"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>IsExternall</simpleValue></baseName></property>',
    );
    const lint = graph(
      [
        { id: 'load', type: 'ids.load', params: { xml: typo } },
        { id: 'lint', type: 'ids.lint', params: { rules: 'IDSL-PROP-001' } },
      ],
      [edge('load', 'ids', 'lint', 'ids')],
    );
    const r = await runFlow(lint, { host: host(), registry, features: headlessFeatures() });
    const table = out(r, 'lint', 'table') as Table;
    expect(table.rows).toEqual([expect.objectContaining({ code: 'IDSL-PROP-001', path: 'specifications[0].requirements[0].baseName', specification: 'Walls are named' })]);

    const strict = { ...lint, nodes: lint.nodes.map((n) => (n.id === 'lint' ? { ...n, params: { failOn: 'error' } } : n)) };
    const failed = await runFlow(strict, { host: host(), registry, features: headlessFeatures() });
    expect(failed.ok).toBe(false);
    expect(failed.log.find((l) => l.level === 'error')?.message).toMatch(/at or above "error"/);
  });

  it('validate fails clearly on a host without model data access', async () => {
    const r = await runFlow(PIPELINE, { host: host({ idsAccessor: undefined }), registry, features: headlessFeatures() });
    expect(r.ok).toBe(false);
    expect(r.log.find((l) => l.level === 'error')?.message).toMatch(/cannot read model data/);
  });

  it('load refuses an empty input', async () => {
    const r = await runFlow(graph([{ id: 'load', type: 'ids.load', params: {} }]), { host: host(), registry, features: headlessFeatures() });
    expect(r.ok).toBe(false);
    expect(r.log.find((l) => l.level === 'error')?.message).toMatch(/no IDS XML/);
  });
});
