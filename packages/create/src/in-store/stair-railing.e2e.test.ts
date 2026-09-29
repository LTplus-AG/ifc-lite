/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parity of the in-store stair and railing builders with IfcCreator
 * (#6232 A5). The same elements are authored twice: by IfcCreator
 * into a fresh file, and through the mutation overlay into a parsed model
 * (the viewer's path), exported with `StepExporter`. Both files are re-parsed
 * and meshed with the real wasm geometry pipeline; each element must come
 * out as the same IFC class with the same key attributes, a sane bounding box
 * and a non-zero volume (integrated from the triangles).
 *
 * Skips (never fails) when `packages/wasm/pkg/ifc-lite_bg.wasm` is not built
 * on this host — see `pnpm build:wasm:fetch`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { IfcCreator } from '../ifc-creator.js';
import type { SpatialAnchor } from './anchor.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addStairToStore } from './stair.js';
import { addRailingToStore } from './railing.js';

const WASM_PATH = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const WASM_AVAILABLE = existsSync(WASM_PATH);

type Vec3 = [number, number, number];
interface Box { min: Vec3; max: Vec3 }
interface Meshed { ifcType: string; box: Box; volume: number }

/** Mesh a file; per expressId: IFC type, bounding box in IFC axes (Z up), volume. */
function mesh(api: IfcAPI, content: string): Map<number, Meshed> {
  const bytes = new TextEncoder().encode(content);
  const pre = api.buildPrePassOnce(bytes);
  const out = new Map<number, Meshed>();
  try {
    const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(
      bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
    );
    try {
      for (let i = 0; i < collection.length; i++) {
        const m = collection.get(i);
        if (!m) continue;
        const entry = out.get(m.expressId) ?? {
          ifcType: m.ifcType,
          box: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } as Box,
          volume: 0,
        };
        // Meshes are WebGL Y-up, relative to a per-mesh origin:
        // IFC (x, y, z) -> (x, z, -y).
        const p = m.positions;
        const o = m.origin;
        for (let k = 0; k < p.length; k += 3) {
          const ifc: Vec3 = [o[0] + p[k], -(o[2] + p[k + 2]), o[1] + p[k + 1]];
          for (let a = 0; a < 3; a++) {
            entry.box.min[a] = Math.min(entry.box.min[a], ifc[a]);
            entry.box.max[a] = Math.max(entry.box.max[a], ifc[a]);
          }
        }
        // Enclosed volume by the divergence theorem (closed, outward-wound mesh).
        const t = m.indices;
        for (let k = 0; k < t.length; k += 3) {
          const [a, b, c] = [t[k] * 3, t[k + 1] * 3, t[k + 2] * 3];
          entry.volume += (
            p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
            - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
            + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
          ) / 6;
        }
        out.set(m.expressId, entry);
        m.free();
      }
    } finally {
      collection.free();
    }
  } finally {
    api.clearPrePassCache();
  }
  return out;
}

/** expressId of the entity of `type` named `name` in a STEP file. */
function idByName(text: string, type: string, name: string): number {
  const match = new RegExp(`#(\\d+)=${type}\\('[^']{22}',[^,]*,'${name}'`).exec(text);
  if (!match) throw new Error(`no ${type} named ${name}`);
  return Number(match[1]);
}

/** The STEP record of entity #id. */
function record(text: string, id: number): string {
  const match = new RegExp(`^#${id}=([A-Z0-9]+\\(.*\\));$`, 'm').exec(text);
  if (!match) throw new Error(`no #${id}`);
  return match[1];
}

// Shared element definitions, metres.
const STAIR = { Position: [1, 2, 0] as Vec3, Direction: Math.PI / 2, NumberOfRisers: 6, RiserHeight: 0.175, TreadLength: 0.28, Width: 1.2 };
const RAIL = { Start: [0, -2, 0] as Vec3, End: [4, -2, 0] as Vec3, Height: 1.0, Width: 0.05 };

/** IfcCreator's file: every element through its own API. */
function creatorFile(): string {
  const c = new IfcCreator({ Name: 'Parity' });
  const s = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  c.addIfcStair(s, { ...STAIR, Name: 'Stair' });
  c.addIfcRailing(s, { ...RAIL, Name: 'Railing' });
  return c.toIfc().content;
}

/** Same elements through the in-store builders into a parsed (IfcCreator) model. */
async function inStoreFile(): Promise<string> {
  const base = new IfcCreator({ Name: 'Parity' });
  const storeyId = base.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  const bytes = new TextEncoder().encode(base.toIfc().content);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  const anchor: SpatialAnchor = resolveSpatialAnchor(store, storeyId, view);

  addStairToStore(editor, anchor, { ...STAIR, Name: 'Stair' });
  addRailingToStore(editor, anchor, { Path: [RAIL.Start, RAIL.End], Height: RAIL.Height, RailDiameter: RAIL.Width, Name: 'Railing' });

  const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
  return new TextDecoder().decode(result.content);
}

function expectBoxClose(a: Box, b: Box, tolerance = 1e-3): void {
  for (let k = 0; k < 3; k++) {
    expect(a.min[k]).toBeCloseTo(b.min[k], -Math.log10(tolerance));
    expect(a.max[k]).toBeCloseTo(b.max[k], -Math.log10(tolerance));
  }
}

describe.skipIf(!WASM_AVAILABLE)('in-store stair / railing vs IfcCreator (#6232 A5)', () => {
  let api: IfcAPI;
  let creator: string;
  let inStore: string;
  let creatorMeshes: Map<number, Meshed>;
  let inStoreMeshes: Map<number, Meshed>;

  beforeAll(async () => {
    initSync({ module: readFileSync(WASM_PATH) });
    api = new IfcAPI();
    creator = creatorFile();
    inStore = await inStoreFile();
    creatorMeshes = mesh(api, creator);
    inStoreMeshes = mesh(api, inStore);
  });

  it('re-parses the exported file with the stair, its flight and the railing', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(inStore).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );
    const count = (type: string) => (store.entityIndex.byType.get(type) ?? []).length;
    expect(count('IFCSTAIR')).toBe(1);
    expect(count('IFCSTAIRFLIGHT')).toBe(1);
    expect(count('IFCRAILING')).toBe(1);
  });

  it('stair: IfcStair aggregating an IfcStairFlight with the same footprint as IfcCreator', () => {
    const stair = idByName(inStore, 'IFCSTAIR', 'Stair');
    const flight = idByName(inStore, 'IFCSTAIRFLIGHT', 'Stair Flight');
    expect(record(inStore, stair)).toMatch(/,\.STRAIGHT_RUN_STAIR\.\)$/);
    expect(record(creator, idByName(creator, 'IFCSTAIR', 'Stair'))).toMatch(/,\.STRAIGHT_RUN_STAIR\.\)$/);
    // Risers, treads, riser height, tread length, flight type.
    expect(record(inStore, flight)).toMatch(/,6,6,0\.175,0\.28,\.STRAIGHT\.\)$/);
    expect(inStore).toMatch(new RegExp(`IFCRELAGGREGATES\\('.{22}',[^,]*,\\$,\\$,#${stair},\\(#${flight}\\)\\)`));
    expect(inStore).toMatch(new RegExp(`IFCRELCONTAINEDINSPATIALSTRUCTURE\\('.{22}',[^,]*,\\$,\\$,\\(#${stair}\\),#\\d+\\)`));

    const ours = inStoreMeshes.get(flight)!;
    const theirs = creatorMeshes.get(idByName(creator, 'IFCSTAIR', 'Stair'))!;
    expect(ours.ifcType).toBe('IfcStairFlight');
    // Run along +Y (Direction = 90°) from (1, 2): x in [1 - W, 1], y in [2, 2 + 6T], z in [0, 6R].
    expectBoxClose(ours.box, { min: [1 - 1.2, 2, 0], max: [1, 2 + 6 * 0.28, 6 * 0.175] });
    expectBoxClose(ours.box, theirs.box);
    // Solid stepped mass: sum over steps of (i + 1)·R·T·W.
    expect(ours.volume).toBeCloseTo(21 * 0.175 * 0.28 * 1.2, 4);
    expect(theirs.volume).toBeGreaterThan(0);
  });

  it('railing: IfcRailing HANDRAIL spanning the same run as IfcCreator, rail top at Height', () => {
    const ours = inStoreMeshes.get(idByName(inStore, 'IFCRAILING', 'Railing'))!;
    const theirs = creatorMeshes.get(idByName(creator, 'IFCRAILING', 'Railing'))!;
    expect(record(inStore, idByName(inStore, 'IFCRAILING', 'Railing'))).toMatch(/,\.HANDRAIL\.\)$/);
    expect(ours.ifcType).toBe('IfcRailing');
    expect(ours.volume).toBeGreaterThan(0);
    // Same plan extent (posts are Width wide at both ends).
    for (const k of [0, 1]) {
      expect(ours.box.min[k]).toBeCloseTo(theirs.box.min[k], 2);
      expect(ours.box.max[k]).toBeCloseTo(theirs.box.max[k], 2);
    }
    expect(ours.box.min[2]).toBeCloseTo(0, 3);
    // Ours measures Height to the top of the rail; IfcCreator centres the rail on it.
    expect(ours.box.max[2]).toBeCloseTo(RAIL.Height, 2);
    expect(theirs.box.max[2]).toBeCloseTo(RAIL.Height + RAIL.Width / 2, 2);
  });

  it('a waisted flight meshes to its outline area times the width', async () => {
    const base = new IfcCreator({ Name: 'Waist' });
    const storeyId = base.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(base.toIfc().content).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );
    const view = new MutablePropertyView(null, 'w');
    const editor = new StoreEditor(store, view);
    addStairToStore(editor, resolveSpatialAnchor(store, storeyId, view), { ...STAIR, WaistThickness: 0.15, Name: 'Waisted' });
    const text = new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content);
    const flight = mesh(api, text).get(idByName(text, 'IFCSTAIRFLIGHT', 'Waisted Flight'))!;
    // Side area, computed from the geometry rather than the builder's outline:
    // six step triangles above the pitch line, plus the strip between the
    // pitch line and the underside, which runs `waist` below it.
    const [R, T, N, w] = [0.175, 0.28, 6, 0.15];
    const drop = w * Math.hypot(R, T) / T; // vertical depth of the strip
    const foot = drop * T / R; // where the underside meets the floor
    const area = N * (T * R) / 2 + (foot * foot * R) / (2 * T) + (N * T - foot) * drop;
    expect(area).toBeCloseTo(0.419138, 5);
    expect(flight.volume).toBeCloseTo(area * 1.2, 4);
    expect(flight.volume).toBeLessThan(21 * 0.175 * 0.28 * 1.2);
  });
});
