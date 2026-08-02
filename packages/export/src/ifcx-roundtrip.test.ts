/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFCX (IFC5) export round-trip fidelity tests.
 *
 * Contract under test: `parseIfcx` → `Ifc5Exporter.export()` → `parseIfcx`
 * preserves the ENTITY-level model. Scope notes from reading
 * ifc5-exporter.ts — the exporter does NOT reproduce the raw node graph:
 *
 * - Only nodes carrying `bsi::ifc::class` become entities; pure geometry
 *   carrier children ("Body", "Axis", "Void", ...) are merged into their
 *   owning entity's `usd::usdgeom::mesh` attribute. Raw-node-count equality
 *   is therefore NOT part of the contract; entity path-set equality is.
 * - `onlyTreeEntities` defaults to true and drops entities outside the
 *   spatial tree (e.g. type objects). Fidelity tests run with
 *   `onlyTreeEntities: false`; the default subset behaviour is pinned as
 *   its own contract test below.
 * - `onlyKnownProperties` defaults to true and drops properties without an
 *   official IFC5 schema (IFC5_KNOWN_PROP_NAMES). Fidelity tests run with
 *   `onlyKnownProperties: false`; the default is pinned separately.
 *
 * All comparisons are set-based — node ordering and representational
 * differences (e.g. names moving from incoming-edge labels into an explicit
 * `bsi::ifc::prop::Name` attribute) are legitimate.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { parseIfcx, type IfcxParseResult } from '@ifc-lite/ifcx';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { IfcTypeEnumToString, type IfcTypeEnum } from '@ifc-lite/data';
import { Ifc5Exporter, type Ifc5ExportOptions } from './ifc5-exporter.js';

const FIXTURE = resolve(__dirname, '../../../tests/models/ifc5/Hello_Wall_hello-wall.ifcx');
const FIXTURE_AVAILABLE = existsSync(FIXTURE);

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function parseFixture(): Promise<IfcxParseResult> {
  return parseIfcx(toArrayBuffer(readFileSync(FIXTURE)));
}

/**
 * Adapt an IfcxParseResult to the IfcDataStore surface the exporter reads
 * (entities/strings/spatialHierarchy/properties — it never touches
 * entityIndex or source for IFC5 input).
 */
function asDataStore(parsed: IfcxParseResult): IfcDataStore {
  return {
    ...parsed,
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
  } as unknown as IfcDataStore;
}

async function roundTrip(
  parsed: IfcxParseResult,
  options: Ifc5ExportOptions,
): Promise<IfcxParseResult> {
  const exporter = new Ifc5Exporter(
    asDataStore(parsed),
    // parseIfcx pre-tessellates IFC5 geometry; feed it back as the
    // exporter's geometry source the same way the viewer does.
    { meshes: parsed.meshes } as unknown as GeometryResult,
  );
  const result = exporter.export(options);
  return parseIfcx(toArrayBuffer(Buffer.from(new TextEncoder().encode(result.content))));
}

/** Lossless export options used by the fidelity tests. */
const FULL_FIDELITY: Ifc5ExportOptions = {
  onlyTreeEntities: false,
  onlyKnownProperties: false,
};

/** Entity node paths (IFCX uses the node path as GlobalId). */
function pathSet(parsed: IfcxParseResult): Set<string> {
  return new Set(parsed.idToPath.values());
}

/** path -> { name, ifcClass } */
function entityInfoByPath(parsed: IfcxParseResult): Map<string, { name: string; ifcClass: string }> {
  const out = new Map<string, { name: string; ifcClass: string }>();
  const { entities, strings } = parsed;
  for (let i = 0; i < entities.count; i++) {
    const path = parsed.idToPath.get(entities.expressId[i]);
    if (!path) continue;
    out.set(path, {
      name: strings.get(entities.name[i]) ?? '',
      ifcClass: IfcTypeEnumToString(entities.typeEnum[i] as IfcTypeEnum),
    });
  }
  return out;
}

/** Hierarchy relations as "parentPath>childPath" edge strings. */
function hierarchyEdges(parsed: IfcxParseResult): Set<string> {
  const edges = new Set<string>();
  const toPath = (id: number) => parsed.idToPath.get(id) ?? `#${id}`;
  const hierarchy = parsed.spatialHierarchy;

  if (hierarchy?.project) {
    const walk = (node: { expressId: number; children: Array<{ expressId: number; children: never[] }> }) => {
      for (const child of node.children) {
        edges.add(`${toPath(node.expressId)}>${toPath(child.expressId)}`);
        walk(child as never);
      }
    };
    walk(hierarchy.project as never);
  }
  for (const map of [hierarchy?.bySite, hierarchy?.byBuilding, hierarchy?.byStorey, hierarchy?.bySpace]) {
    if (!map) continue;
    for (const [parentId, childIds] of map) {
      for (const childId of childIds) {
        edges.add(`${toPath(parentId)}>${toPath(childId)}`);
      }
    }
  }
  return edges;
}

/** path -> set of "propName=jsonValue" strings. */
function propsByPath(parsed: IfcxParseResult): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const { entities } = parsed;
  for (let i = 0; i < entities.count; i++) {
    const expressId = entities.expressId[i];
    const path = parsed.idToPath.get(expressId);
    if (!path) continue;
    const flat = new Set<string>();
    for (const pset of parsed.properties.getForEntity(expressId)) {
      for (const prop of pset.properties) {
        flat.add(`${prop.name}=${JSON.stringify(prop.value)}`);
      }
    }
    out.set(path, flat);
  }
  return out;
}

/** Paths of entities carrying tessellated geometry. */
function meshPathSet(parsed: IfcxParseResult): Set<string> {
  const out = new Set<string>();
  for (const mesh of parsed.meshes) {
    const path = parsed.idToPath.get(mesh.expressId);
    if (path) out.add(path);
  }
  return out;
}

/** path -> total triangle count across all mesh fragments. */
function triangleTotals(parsed: IfcxParseResult): Map<string, number> {
  const out = new Map<string, number>();
  for (const mesh of parsed.meshes) {
    const path = parsed.idToPath.get(mesh.expressId);
    if (!path) continue;
    out.set(path, (out.get(path) ?? 0) + mesh.indices.length / 3);
  }
  return out;
}

/** Entity paths reachable from the spatial hierarchy (tree + containment). */
function spatialTreePaths(parsed: IfcxParseResult): Set<string> {
  const ids = new Set<number>();
  const hierarchy = parsed.spatialHierarchy;
  if (hierarchy?.project) {
    const walk = (node: { expressId: number; children: Array<never> }) => {
      ids.add(node.expressId);
      for (const child of node.children) walk(child);
    };
    walk(hierarchy.project as never);
  }
  for (const map of [hierarchy?.bySite, hierarchy?.byBuilding, hierarchy?.byStorey, hierarchy?.bySpace]) {
    if (!map) continue;
    for (const childIds of map.values()) {
      for (const id of childIds) ids.add(id);
    }
  }
  const paths = new Set<string>();
  for (const id of ids) {
    const path = parsed.idToPath.get(id);
    if (path) paths.add(path);
  }
  return paths;
}

describe.skipIf(!FIXTURE_AVAILABLE)('IFCX export round-trip fidelity (Hello Wall)', () => {
  it('preserves the entity node path set exactly', async () => {
    const original = await parseFixture();
    // Guard: the fixture must actually contain a non-trivial model.
    expect(original.entityCount).toBeGreaterThanOrEqual(9);

    const reparsed = await roundTrip(original, FULL_FIDELITY);

    expect(pathSet(reparsed)).toEqual(pathSet(original));
    expect(reparsed.entityCount).toBe(original.entityCount);
  });

  it('preserves IFC class and name for every entity', async () => {
    const original = await parseFixture();
    const reparsed = await roundTrip(original, FULL_FIDELITY);

    const before = entityInfoByPath(original);
    const after = entityInfoByPath(reparsed);
    for (const [path, info] of before) {
      expect(after.get(path), `entity ${path}`).toEqual(info);
    }
  });

  it('preserves hierarchy relations', async () => {
    const original = await parseFixture();
    const reparsed = await roundTrip(original, FULL_FIDELITY);

    const before = hierarchyEdges(original);
    expect(before.size).toBeGreaterThan(0);
    expect(hierarchyEdges(reparsed)).toEqual(before);
  });

  it('preserves all property name/value pairs (re-parse may add Name)', async () => {
    const original = await parseFixture();
    const reparsed = await roundTrip(original, FULL_FIDELITY);

    const before = propsByPath(original);
    const after = propsByPath(reparsed);

    // Guard against a vacuous pass: the fixture has real properties.
    const totalProps = [...before.values()].reduce((n, s) => n + s.size, 0);
    expect(totalProps).toBeGreaterThan(0);

    // Superset assertion: every original property must survive. The exporter
    // legitimately ADDS `bsi::ifc::prop::Name` for entities whose name was
    // only encoded as an incoming-edge label in the source file, so exact
    // set equality would be wrong — but nothing may be LOST.
    for (const [path, props] of before) {
      const reparsedProps = after.get(path) ?? new Set<string>();
      for (const prop of props) {
        expect(reparsedProps.has(prop), `property "${prop}" on ${path}`).toBe(true);
      }
    }
  });

  it('preserves the set of geometry-bearing entities', async () => {
    const original = await parseFixture();
    const reparsed = await roundTrip(original, FULL_FIDELITY);

    const before = meshPathSet(original);
    expect(before.size).toBeGreaterThan(0);
    expect(meshPathSet(reparsed)).toEqual(before);
  });

  // Regression: per-entity triangle totals used to multiply across the
  // round-trip (Hello Wall: wall 54 → 216 triangles, ×4 = one copy per
  // incoming containment edge). The exporter materialises flattened
  // containment maps as children (storey→wall AND space→wall), giving
  // mesh-bearing nodes multiple incoming edges; parseIfcx's geometry
  // extractor now deduplicates emission per (node path, accumulated
  // transform), so aliased traversal paths emit once while genuine
  // instancing (different world transform) still emits.
  it('preserves per-entity triangle counts (geometry not duplicated)', async () => {
    const original = await parseFixture();
    const reparsed = await roundTrip(original, FULL_FIDELITY);

    expect(Object.fromEntries(triangleTotals(reparsed)))
      .toEqual(Object.fromEntries(triangleTotals(original)));
  });

  // ---------------------------------------------------------------------
  // Default-option contracts (documented subset behaviour, not bugs)
  // ---------------------------------------------------------------------

  it('default onlyTreeEntities drops exactly the non-spatial-tree entities', async () => {
    const original = await parseFixture();
    const reparsed = await roundTrip(original, { onlyKnownProperties: false });

    const expected = spatialTreePaths(original);
    // Hello Wall has one entity outside the spatial tree (the inherited
    // window type prototype node) — make sure the contract test is not
    // vacuously identical to the full-fidelity test.
    expect(expected.size).toBeLessThan(pathSet(original).size);
    expect(pathSet(reparsed)).toEqual(expected);
  });

  it('default onlyKnownProperties keeps schema-known props and drops unknown ones', async () => {
    const original = await parseFixture();
    const reparsed = await roundTrip(original, {});

    const before = propsByPath(original);
    const after = propsByPath(reparsed);

    // The wall carries both a known prop (IsExternal) and an unknown one
    // (the NL-SfB "class" reference, which has no official IFC5 prop schema).
    const wallPath = [...before.entries()]
      .find(([, props]) => [...props].some((p) => p.startsWith('class=')))?.[0];
    expect(wallPath).toBeDefined();

    const wallAfter = after.get(wallPath!) ?? new Set<string>();
    expect([...wallAfter].some((p) => p.startsWith('IsExternal='))).toBe(true);
    expect([...wallAfter].some((p) => p.startsWith('class='))).toBe(false);
  });
});
