/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parity of the in-store profiled beam, column and member builders with
 * IfcCreator (#6232 A5). The same elements are authored twice: by IfcCreator
 * into a fresh file, and through the mutation overlay into a parsed model
 * (the viewer's path), exported with `StepExporter`. Both files are re-parsed
 * and meshed with the real wasm geometry pipeline; each element must come
 * out as the same IFC class with the same key attributes, a sane bounding box
 * and a non-zero volume (integrated from the triangles), and where the geometry is the same by construction
 * the same volume.
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
import { addBeamToStore } from './beam.js';
import { addColumnToStore } from './column.js';
import { addMemberToStore } from './member.js';

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
const I = { OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 };
const L = { Depth: 0.1, Width: 0.08, Thickness: 0.01 };
const T = { FlangeWidth: 0.12, Depth: 0.12, WebThickness: 0.01, FlangeThickness: 0.012 };
const U = { Depth: 0.2, FlangeWidth: 0.075, WebThickness: 0.0085, FlangeThickness: 0.0115 };
const C = { Depth: 0.2, Width: 0.07, WallThickness: 0.003, Girth: 0.02 };
const RHS = { XDim: 0.1, YDim: 0.2, WallThickness: 0.008 };
const CIRCLE = { Radius: 0.15 };
const CHS = { Radius: 0.1, WallThickness: 0.008 };
const H = 3;

/** IfcCreator's file: every element through its own API. */
function creatorFile(): string {
  const c = new IfcCreator({ Name: 'Parity' });
  const s = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  c.addIfcBeam(s, { Start: [0, 5, 3], End: [6, 5, 3], Width: 0.3, Height: 0.5, Name: 'RectBeam' });
  c.addIfcIShapeBeam(s, { Start: [0, 6, 3], End: [6, 6, 3], ...I, Name: 'IBeam' });
  c.addIfcRectangleHollowBeam(s, { Start: [0, 7, 3], End: [6, 7, 3], ...RHS, Name: 'RHSBeam' });
  c.addIfcLShapeMember(s, { Start: [0, 8, 0], End: [3, 8, 2], ...L, Name: 'LMember' });
  c.addIfcTShapeMember(s, { Start: [0, 9, 0], End: [3, 9, 0], ...T, Name: 'TMember' });
  c.addIfcUShapeMember(s, { Start: [0, 10, 0], End: [3, 10, 0], ...U, Name: 'UMember' });
  c.addElement(s, {
    IfcType: 'IFCMEMBER', Name: 'CMember', Depth: 3,
    Placement: { Location: [0, 11, 0], Axis: [1, 0, 0], RefDirection: [0, 1, 0] },
    Profile: { ProfileType: 'AREA', ...C },
  });
  c.addIfcCircularColumn(s, { Position: [10, 0, 0], ...CIRCLE, Height: H, Name: 'CircleColumn' });
  c.addIfcHollowCircularColumn(s, { Position: [11, 0, 0], ...CHS, Height: H, Name: 'CHSColumn' });
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

  addBeamToStore(editor, anchor, { Start: [0, 5, 3], End: [6, 5, 3], Width: 0.3, Height: 0.5, Name: 'RectBeam' });
  addBeamToStore(editor, anchor, { Start: [0, 6, 3], End: [6, 6, 3], Profile: { Type: 'I', ...I }, Name: 'IBeam' });
  addBeamToStore(editor, anchor, { Start: [0, 7, 3], End: [6, 7, 3], Profile: { Type: 'RectangleHollow', ...RHS }, Name: 'RHSBeam' });
  addMemberToStore(editor, anchor, { Start: [0, 8, 0], End: [3, 8, 2], Profile: { Type: 'L', ...L }, Name: 'LMember' });
  addMemberToStore(editor, anchor, { Start: [0, 9, 0], End: [3, 9, 0], Profile: { Type: 'T', ...T }, Name: 'TMember' });
  addMemberToStore(editor, anchor, { Start: [0, 10, 0], End: [3, 10, 0], Profile: { Type: 'U', ...U }, Name: 'UMember' });
  addMemberToStore(editor, anchor, { Start: [0, 11, 0], End: [3, 11, 0], Profile: { Type: 'C', ...C }, Name: 'CMember' });
  addColumnToStore(editor, anchor, { Position: [10, 0, 0], Profile: { Type: 'Circle', ...CIRCLE }, Height: H, Name: 'CircleColumn' });
  addColumnToStore(editor, anchor, { Position: [11, 0, 0], Profile: { Type: 'CircleHollow', ...CHS }, Height: H, Name: 'CHSColumn' });

  const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
  return new TextDecoder().decode(result.content);
}

const MEMBERS: Array<[type: string, name: string, profileClass: string]> = [
  ['IFCBEAM', 'RectBeam', 'IFCRECTANGLEPROFILEDEF'],
  ['IFCBEAM', 'IBeam', 'IFCISHAPEPROFILEDEF'],
  ['IFCBEAM', 'RHSBeam', 'IFCRECTANGLEHOLLOWPROFILEDEF'],
  ['IFCMEMBER', 'LMember', 'IFCLSHAPEPROFILEDEF'],
  ['IFCMEMBER', 'TMember', 'IFCTSHAPEPROFILEDEF'],
  ['IFCMEMBER', 'UMember', 'IFCUSHAPEPROFILEDEF'],
  ['IFCMEMBER', 'CMember', 'IFCCSHAPEPROFILEDEF'],
  ['IFCCOLUMN', 'CircleColumn', 'IFCCIRCLEPROFILEDEF'],
  ['IFCCOLUMN', 'CHSColumn', 'IFCCIRCLEHOLLOWPROFILEDEF'],
];

function expectBoxClose(a: Box, b: Box, tolerance = 1e-3): void {
  for (let k = 0; k < 3; k++) {
    expect(a.min[k]).toBeCloseTo(b.min[k], -Math.log10(tolerance));
    expect(a.max[k]).toBeCloseTo(b.max[k], -Math.log10(tolerance));
  }
}

/** Follow `#ref` attribute `index` of a record. */
function attributeRef(text: string, id: number, index: number): number {
  const body = record(text, id).replace(/^[A-Z0-9]+\(/, '').replace(/\)$/, '');
  const parts = body.split(/,(?![^(]*\))/);
  return Number(parts[index].replace('#', ''));
}

/** The profile class under an element's single extruded body. */
function profileClass(text: string, elementId: number): string {
  const shape = attributeRef(text, elementId, 6);
  const rep = Number(/\(#(\d+)\)\)$/.exec(record(text, shape))![1]);
  const solid = Number(/\(#(\d+)\)\)$/.exec(record(text, rep))![1]);
  const profile = attributeRef(text, solid, 0);
  return record(text, profile).split('(')[0];
}

describe.skipIf(!WASM_AVAILABLE)('in-store profiled beams / columns / members vs IfcCreator (#6232 A5)', () => {
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

  it('re-parses the exported file with every element in its storey', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(inStore).buffer as ArrayBuffer,
      { disableWorkerScan: true },
    );
    const count = (type: string) => (store.entityIndex.byType.get(type) ?? []).length;
    expect(count('IFCBEAM')).toBe(3);
    expect(count('IFCMEMBER')).toBe(4);
    expect(count('IFCCOLUMN')).toBe(2);
  });

  it.each(MEMBERS)('%s %s: same class, profile, bounding box and volume as IfcCreator', (type, name, cls) => {
    const ourId = idByName(inStore, type, name);
    const theirId = idByName(creator, type, name);
    expect(profileClass(inStore, ourId)).toBe(cls);
    expect(profileClass(creator, theirId)).toBe(cls);
    // PredefinedType tail matches (IFC4).
    expect(record(inStore, ourId).match(/,(\.[A-Z]+\.)\)$/)?.[1]).toBe(record(creator, theirId).match(/,(\.[A-Z]+\.)\)$/)?.[1]);

    const ours = inStoreMeshes.get(ourId)!;
    const theirs = creatorMeshes.get(theirId)!;
    expect(ours, `${name} meshed`).toBeDefined();
    expect(ours.volume).toBeGreaterThan(0);
    expectBoxClose(ours.box, theirs.box);
    expect(ours.volume).toBeCloseTo(theirs.volume, 5);
  });
});
