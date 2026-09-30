/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End to end for wall joins (#6232 D1): author two walls on a fresh storey
 * through the mutation overlay, join them with `applyWallJoinToStore`, export
 * with `StepExporter`, re-parse, and mesh through the real wasm geometry
 * pipeline.
 *
 * The oracle samples a grid of points around the joint at mid-height and asks
 * each wall MESH whether the point is inside it (ray parity). No point may be
 * inside both meshes (no overlapping volume), and each mesh must hold exactly
 * the points of the body quad the join computed (the file carries the join; the
 * quads themselves are checked against the ideal footprint in
 * `wall-join.test.ts`). The unjoined pair is run through the same oracle to show
 * it does catch the overlap.
 *
 * The wasm half skips (never fails) when `packages/wasm/pkg/ifc-lite_bg.wasm`
 * is not built on this host — see `pnpm build:wasm:fetch`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { IfcCreator } from '../ifc-creator.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addWallToStore, type WallInStoreParams } from './wall.js';
import { applyWallJoinToStore, wallJoinTargetFromBuild } from './wall-join-apply.js';
import type { PlanPoint, WallJoin } from './wall-join.js';
import { HEIGHT, bodyQuad, meshWalls, parse, sample } from './wall-join-mesh.oracle.js';

const WASM_PATH = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const WASM_AVAILABLE = existsSync(WASM_PATH);

interface Authored { text: string; wallIds: [number, number]; join: WallJoin | null }

/** A fresh storey with walls `a` and `b` on it, joined unless `join` is false. */
async function author(schema: 'IFC2X3' | 'IFC4' | 'IFC4X3', a: WallInStoreParams, b: WallInStoreParams, join = true): Promise<Authored> {
  const creator = new IfcCreator({ Name: 'Wall joins', Schema: schema });
  const storeyId = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  const store = await parse(creator.toIfc().content);
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storeyId, view);
  const ta = wallJoinTargetFromBuild(addWallToStore(editor, anchor, a), a);
  const tb = wallJoinTargetFromBuild(addWallToStore(editor, anchor, b), b);
  const result = join ? applyWallJoinToStore(editor, anchor, ta, tb) : null;
  const exported = new StepExporter(store, view).export({ schema, applyMutations: true });
  return { text: new TextDecoder().decode(exported.content), wallIds: [ta.wallId, tb.wallId], join: result?.join ?? null };
}

const DEG = Math.PI / 180;
const at = (angle: number, length: number, from: PlanPoint = [0, 0]): [number, number, number] =>
  [from[0] + Math.cos(angle * DEG) * length, from[1] + Math.sin(angle * DEG) * length, 0];

const CASES: Array<{ name: string; a: WallInStoreParams; b: WallInStoreParams; kind: WallJoin['kind'] }> = [
  {
    name: 'L at 90 degrees',
    a: { Start: [-4, 0, 0], End: [0, 0, 0], Thickness: 0.2, Height: HEIGHT },
    b: { Start: [0, 0, 0], End: [0, 4, 0], Thickness: 0.2, Height: HEIGHT },
    kind: 'L',
  },
  {
    name: 'L at 60 degrees, thickness mismatch, left-aligned',
    a: { Start: [-4, 0, 0], End: [0, 0, 0], Thickness: 0.3, Height: HEIGHT, Alignment: 'left' },
    b: { Start: [0, 0, 0], End: at(120, 4), Thickness: 0.15, Height: HEIGHT },
    kind: 'L',
  },
  {
    name: 'T at 50 degrees, offset body',
    a: { Start: at(50, 4, [0.4, 0]), End: [0.4, 0.2, 0], Thickness: 0.2, Height: HEIGHT, Offset: 0.03 },
    b: { Start: [-4, 0, 0], End: [4, 0, 0], Thickness: 0.3, Height: HEIGHT },
    kind: 'T',
  },
  {
    name: 'butt in line, thickness mismatch',
    a: { Start: [-4, 0, 0], End: [0, 0, 0], Thickness: 0.3, Height: HEIGHT },
    b: { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: HEIGHT, Alignment: 'right' },
    kind: 'butt',
  },
];

describe.skipIf(!WASM_AVAILABLE)('wall join -> StepExporter -> wasm mesh (#6232)', () => {
  let api: IfcAPI;
  beforeAll(() => {
    initSync({ module: readFileSync(WASM_PATH) });
    api = new IfcAPI();
  });

  it('the oracle sees the overlap of two unjoined walls drawn to the corner', async () => {
    const { a, b } = CASES[0];
    const { text, wallIds } = await author('IFC4', { ...a, End: [0.1, 0, 0] }, b, false);
    const meshes = meshWalls(api, text);
    const tally = sample(meshes.get(wallIds[0]) ?? [], meshes.get(wallIds[1]) ?? [], [0, 0]);
    expect(tally.inside).toBeGreaterThan(100);
    expect(tally.both).toBeGreaterThan(0);
  });

  for (const c of CASES) {
    it(`${c.name}: meshes with no overlapping volume, exactly the joined bodies`, async () => {
      const { text, wallIds, join } = await author('IFC4', c.a, c.b);
      expect(join?.kind).toBe(c.kind);
      const meshes = meshWalls(api, text);
      const meshA = meshes.get(wallIds[0]) ?? [];
      const meshB = meshes.get(wallIds[1]) ?? [];
      expect(meshA.length).toBeGreaterThan(0);
      expect(meshB.length).toBeGreaterThan(0);
      const tally = sample(meshA, meshB, join!.point, [bodyQuad(join!.a.wall), bodyQuad(join!.b.wall)]);
      expect(tally.inside).toBeGreaterThan(100);
      expect(tally.both).toBe(0);
      expect(tally.mismatches).toEqual([]);
    });
  }
});

describe('wall join -> StepExporter -> re-parse (#6232)', () => {
  it.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s: the connects relationship and axis round-trip', async (schema) => {
    const { a, b } = CASES[1];
    const { text, wallIds } = await author(schema, a, b);
    const store = await parse(text);
    const rels = store.entityIndex.byType.get('IFCRELCONNECTSPATHELEMENTS') ?? [];
    expect(rels).toHaveLength(1);
    // The thicker wall a runs through: it relates, at its end; b is related at its start.
    expect(store.relationships.getRelated(wallIds[0], RelationshipType.ConnectsPathElements, 'forward')).toEqual([wallIds[1]]);
    expect(store.relationships.getRelated(wallIds[1], RelationshipType.ConnectsPathElements, 'inverse')).toEqual([wallIds[0]]);
    expect(text).toMatch(new RegExp(`IFCRELCONNECTSPATHELEMENTS\\('.{22}',(#\\d+|\\$),\\$,\\$,\\$,#${wallIds[0]},#${wallIds[1]},\\(\\),\\(\\),\\.ATSTART\\.,\\.ATEND\\.\\);`));
    expect(text).toMatch(/IFCSHAPEREPRESENTATION\(#\d+,'Axis','Curve2D',\(#\d+\)\);/);
    expect(store.entityIndex.byType.get('IFCARBITRARYCLOSEDPROFILEDEF')?.length).toBe(2);
  });
});
