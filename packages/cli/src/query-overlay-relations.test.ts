/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression for #3502: `refIds()` (the `'#42'` reference parser inside
 * `foldQueuedRelated`, `query-overlay-relations.ts`) used
 * `Number.parseInt(trimmed.slice(1), 10)`, which stops at the first
 * non-digit character. A malformed relationship end — `#42junk`, `#42.5` —
 * resolved to express id 42 instead of being rejected, so a near-miss
 * reference silently bound to a real entity. Exercised through
 * `HeadlessBackend.query.related()`, same as the sibling overlay test
 * (`headless-backend-related-overlay.test.ts`), since `refIds` itself is
 * not exported.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { loadIfcFile } from './loader.js';
import { HeadlessBackend } from './headless-backend.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_IFC = join(__dirname, '../../../apps/viewer/public/samples/building-architecture.ifc');

describe('foldQueuedRelated / refIds — #3502', () => {
  it('rejects a near-miss reference with trailing garbage instead of parsing its numeric prefix', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');
    const [parent] = backend.query.entities({ types: ['IfcWall'] });

    backend.store.addEntity('default', {
      type: 'IfcRelAggregates',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzz'", null, null, null, `#${parent.ref.expressId}`, ['#42junk']],
    });

    const forward = backend.query.related(parent.ref, 'IfcRelAggregates', 'forward');
    expect(forward).toEqual([]); // was resolved to express id 42 under `parseInt`
  });

  it('rejects a decimal reference instead of truncating it to an integer', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');
    const [parent] = backend.query.entities({ types: ['IfcWall'] });

    backend.store.addEntity('default', {
      type: 'IfcRelAggregates',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzz'", null, null, null, `#${parent.ref.expressId}`, ['#42.5']],
    });

    const forward = backend.query.related(parent.ref, 'IfcRelAggregates', 'forward');
    expect(forward).toEqual([]); // was resolved to express id 42 under `parseInt`
  });

  it('rejects a bare "#" with no digits', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');
    const [parent] = backend.query.entities({ types: ['IfcWall'] });

    backend.store.addEntity('default', {
      type: 'IfcRelAggregates',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzz'", null, null, null, `#${parent.ref.expressId}`, ['#']],
    });

    const forward = backend.query.related(parent.ref, 'IfcRelAggregates', 'forward');
    expect(forward).toEqual([]);
  });

  it('rejects a reference past Number.MAX_SAFE_INTEGER', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');
    const [parent] = backend.query.entities({ types: ['IfcWall'] });
    const unsafe = `#${(Number.MAX_SAFE_INTEGER + 2).toString()}`;

    backend.store.addEntity('default', {
      type: 'IfcRelAggregates',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzz'", null, null, null, `#${parent.ref.expressId}`, [unsafe]],
    });

    const forward = backend.query.related(parent.ref, 'IfcRelAggregates', 'forward');
    expect(forward).toEqual([]);
  });

  it('control: a well-formed reference still resolves', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');
    const [parent, child] = backend.query.entities({ types: ['IfcWall'] });

    backend.store.addEntity('default', {
      type: 'IfcRelAggregates',
      attributes: [
        "'3N1x3zzzzzzzzzzzzzzzzz'",
        null,
        null,
        null,
        `#${parent.ref.expressId}`,
        [`#${child.ref.expressId}`],
      ],
    });

    const forward = backend.query.related(parent.ref, 'IfcRelAggregates', 'forward');
    expect(forward.some((r) => r.expressId === child.ref.expressId)).toBe(true);
  });
});

describe('relationship rows name a retyped endpoint by its effective class (#5009 review)', () => {
  it('reports the queued setEntityType class on parsed and rebuilt rows alike', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');
    const [parent, child] = backend.query.entities({ types: ['IfcWall'] });

    // A rebuilt (queued) edge and a parsed edge to the same retyped endpoint.
    backend.store.addEntity('default', {
      type: 'IfcRelAggregates',
      attributes: ["'3N1x3zzzzzzzzzzzzzzzzz'", null, null, null, `#${parent.ref.expressId}`, [`#${child.ref.expressId}`]],
    });
    const view = (backend as unknown as { mutationView: MutablePropertyView }).mutationView;
    view.setEntityType(child.ref.expressId, 'IfcColumn');

    expect(backend.query.entityData(child.ref)?.type).toBe('IfcColumn');
    const rows = backend.query.relationships(parent.ref).relations ?? [];
    const queued = rows.filter((row) => row.entity.id === child.ref.expressId);
    expect(queued.length).toBeGreaterThan(0);
    for (const row of queued) expect(row.entity.type).toBe('IfcColumn');

    const parsed = backend.query.relationships(child.ref).relations ?? [];
    const storey = parsed.find((row) => row.relationshipType.toUpperCase() === 'IFCRELCONTAINEDINSPATIALSTRUCTURE');
    expect(storey?.entity.type).toBe('IfcBuildingStorey');
  });
});

describe('created entities are filtered and read by their effective class (#5009 review)', () => {
  it('moves a retyped created wall into the IfcColumn query and out of the IfcWall query', async () => {
    const store = await loadIfcFile(SAMPLE_IFC);
    const backend = new HeadlessBackend(store, 'building-architecture.ifc');
    const created = backend.store.addEntity('default', {
      type: 'IfcWall',
      attributes: ["'3N1x3yyyyyyyyyyyyyyyyy'", null, "'Authored'", "'Desc'", null, null, null, "'tag'", null],
    });
    const view = (backend as unknown as { mutationView: MutablePropertyView }).mutationView;
    view.setEntityType(created.expressId, 'IfcColumn');

    const columns = backend.query.entities({ types: ['IfcColumn'] }).map((entity) => entity.ref.expressId);
    const walls = backend.query.entities({ types: ['IfcWall'] }).map((entity) => entity.ref.expressId);
    expect(columns).toContain(created.expressId);
    expect(walls).not.toContain(created.expressId);
    const data = backend.query.entityData(created);
    expect(data?.type).toBe('IfcColumn');
    expect(data?.name).toBe('Authored');
    expect(data?.description).toBe('Desc');
  });
});
