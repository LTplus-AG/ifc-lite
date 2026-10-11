/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { checkOps } from '@ifc-lite/ids-authoring';
import { describe, expect, it } from 'vitest';
import { createToolRegistry } from './registry.js';
import { SCHEMA_TOOLS } from './schema-tools.js';
import { rankNames } from './rank.js';
import { doorOps, emptyDoc, sandboxFor, schemaContexts, toolContext } from '../../test/helpers.js';

const registry = createToolRegistry(SCHEMA_TOOLS);

async function call(name: string, input: unknown) {
  const ctx = await toolContext(await sandboxFor());
  const outcome = await registry.call(name, input, undefined, ctx);
  return outcome as { ok: boolean; data: Record<string, unknown> };
}

describe('schema read tools', () => {
  it('search ranks the plain match first and hides abstract entities unless asked', async () => {
    const out = await call('schema_search_entities', { query: 'door', version: 'IFC4' });
    const names = (out.data.results as { name: string }[]).map((r) => r.name);
    expect(names[0]).toBe('IfcDoor');
    const abstract = await call('schema_search_entities', { query: 'BuildingElement', version: 'IFC4', includeAbstract: true });
    expect((abstract.data.results as { name: string; abstract: boolean }[]).some((r) => r.abstract)).toBe(true);
    const concrete = await call('schema_search_entities', { query: 'BuildingElement', version: 'IFC4' });
    expect((concrete.data.results as { abstract: boolean }[]).every((r) => !r.abstract)).toBe(true);
  });

  it('entity card lists inheritance, predefined types and applicable sets', async () => {
    const out = await call('schema_entity', { name: 'IfcDoor', version: 'IFC4' });
    expect(out.ok).toBe(true);
    expect(out.data.inheritance).toEqual(expect.arrayContaining(['IfcDoor', 'IfcBuildingElement', 'IfcRoot']));
    expect(out.data.predefinedTypes).toContain('DOOR');
    expect(out.data.propertySets).toContain('Pset_DoorCommon');
  });

  it('an unknown entity is an error with candidates, not a guess', async () => {
    const out = await call('schema_entity', { name: 'IfcDor', version: 'IFC4' });
    expect(out.ok).toBe(false);
    expect(out.data.candidates).toContain('IfcDoor');
  });

  it('psets_for filters applicable sets by a word', async () => {
    const out = await call('schema_psets_for', { entity: 'IfcWall', version: 'IFC4', query: 'fire' });
    const sets = out.data.propertySets as { name: string; properties: string[] }[];
    expect(sets.some((s) => s.name === 'Pset_WallCommon' && s.properties.includes('FireRating'))).toBe(true);
  });

  it('pset card returns kinds, data types and enumerations', async () => {
    const out = await call('schema_pset', { name: 'Pset_DoorCommon', version: 'IFC4' });
    const props = out.data.properties as { name: string; dataType?: string }[];
    expect(props.find((p) => p.name === 'FireRating')?.dataType).toBeDefined();
    const missing = await call('schema_pset', { name: 'Pset_DoorFireSafety', version: 'IFC4' });
    expect(missing.ok).toBe(false);
  });

  it('find_property finds the sets that define a property, restricted to an entity', async () => {
    const out = await call('schema_find_property', { name: 'FireRating', version: 'IFC4', entity: 'IfcDoor' });
    const results = out.data.results as { property: string; propertySets: string[] }[];
    expect(results[0].property).toBe('FireRating');
    expect(results[0].propertySets).toEqual(['Pset_DoorCommon']);
  });

  it('every name a lookup returns is one the gate accepts', async () => {
    const { gate } = await schemaContexts();
    const out = await call('schema_find_property', { name: 'FireRating', version: 'IFC4', entity: 'IfcDoor' });
    const [hit] = out.data.results as { property: string; propertySets: string[] }[];
    const ops = doorOps(hit.propertySets[0], hit.property).map((op, i) => ({ ...(op as object), opId: `00000000-0000-8000-8000-00000000000${i}` }));
    const sandbox = await sandboxFor();
    const resolved = sandbox.handles.resolve(ops);
    expect(checkOps(resolved, emptyDoc(), gate).ok).toBe(true);
  });
});

describe('rankNames', () => {
  it('prefers exact, then prefix, then token matches, then near typos', () => {
    const names = ['IfcDoorType', 'IfcDoor', 'IfcWindow', 'IfcDoorStyle'];
    expect(rankNames('door', names, 3)).toEqual(['IfcDoor', 'IfcDoorType', 'IfcDoorStyle']);
    expect(rankNames('windw', names, 1)).toEqual(['IfcWindow']);
    expect(rankNames('', names, 3)).toEqual([]);
  });
});
