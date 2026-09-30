/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A profile placed or changed in the viewer, through the real pipeline
 * (#6232 D2): the store's overlay is exported as STEP, re-parsed, and meshed
 * by the wasm geometry engine. A steel I-beam comes out with the I's bounding
 * box (not the rectangle's it replaced); a hollow circular column with the
 * tube's; and the re-parsed file gives the same sections back. Skips (never
 * fails) when `packages/wasm/pkg/ifc-lite_bg.wasm` is not built on this host.
 */

import '@/test/setup-dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { setElementProfileSection } from '@/components/viewer/model-inspector/inspector-edits';
import { resolveLinearElementChain } from '@/lib/linear-element-edit';
import { profileSectionExtent, type ProfileSection } from '@ifc-lite/create';
import { DEFAULT_SECTIONS, PROFILE_KINDS } from '@/lib/profile-section/profile-kinds';
import { sectionOutline } from '@/lib/profile-section/profile-outline';

const WASM_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'packages', 'wasm', 'pkg', 'ifc-lite_bg.wasm');
let wasmReady = false;
function ensureWasm(t: TestContext): boolean {
  if (!existsSync(WASM_PATH)) {
    t.skip('wasm bundle not built: run `pnpm build:wasm:fetch`');
    return false;
  }
  if (!wasmReady) {
    initSync({ module: readFileSync(WASM_PATH) });
    wasmReady = true;
  }
  return true;
}

type Vec3 = [number, number, number];
interface Box { min: Vec3; max: Vec3; /** Every mesh vertex, IFC axes. */ points: Vec3[] }
const s = () => useViewerStore.getState();
const made = (m: { expressId: number } | { error: string }): number => { assert.ok('expressId' in m, 'error' in m ? m.error : ''); return m.expressId; };

/** Mesh a STEP file: per expressId, its bounding box in IFC axes (Z up), metres. */
function meshBoxes(content: string): Map<number, Box> {
  const api = new IfcAPI();
  const bytes = new TextEncoder().encode(content);
  const pre = api.buildPrePassOnce(bytes);
  const boxes = new Map<number, Box>();
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
        const box = boxes.get(m.expressId) ?? { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3, points: [] as Vec3[] };
        const p = m.positions;
        const o = m.origin;
        // WebGL Y-up, relative to a per-mesh origin: IFC (x, y, z) -> (x, z, -y).
        for (let k = 0; k < p.length; k += 3) {
          const ifc: Vec3 = [o[0] + p[k], -(o[2] + p[k + 2]), o[1] + p[k + 1]];
          box.points.push(ifc);
          for (let a = 0; a < 3; a++) {
            box.min[a] = Math.min(box.min[a], ifc[a]);
            box.max[a] = Math.max(box.max[a], ifc[a]);
          }
        }
        boxes.set(m.expressId, box);
        m.free();
      }
    } finally {
      collection.free();
    }
  } finally {
    api.clearPrePassCache();
  }
  return boxes;
}

const idByName = (text: string, type: string, name: string): number => {
  const match = new RegExp(`#(\\d+)=${type}\\('[^']{22}',[^,]*,'${name}'`).exec(text);
  assert.ok(match, `no ${type} named ${name}`);
  return Number(match[1]);
};

function expectBox(actual: Box, expected: { min: Vec3; max: Vec3 }): void {
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs(actual.min[k] - expected.min[k]) < 2e-3, `min[${k}] ${actual.min[k]} vs ${expected.min[k]}`);
    assert.ok(Math.abs(actual.max[k] - expected.max[k]) < 2e-3, `max[${k}] ${actual.max[k]} vs ${expected.max[k]}`);
  }
}

let restoreRemesh: () => void = () => {};
beforeEach(async () => {
  await seedModelingSession();
  restoreRemesh = setRequestRemesh(() => {});
});
afterEach(() => { restoreRemesh(); s().exitModelWorkspace(); });

/** The store's overlay exported as STEP, and the same file parsed again. */
async function exported() {
  const dataStore = s().models.get(MODEL_ID)!.ifcDataStore!;
  const view = s().mutationViews.get(MODEL_ID)!;
  const { content } = new StepExporter(dataStore, view).export({ schema: 'IFC4', applyMutations: true });
  const text = new TextDecoder().decode(content);
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
  const reopened = new MutablePropertyView(null, 'reopened');
  return { text, store, view: reopened, editor: new StoreEditor(store, reopened) };
}

const I: ProfileSection = { Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 };
const CHS: ProfileSection = { Type: 'CircleHollow', Radius: 0.15, WallThickness: 0.01 };

describe('profiled beams and columns through export, re-parse and the wasm mesher (#6232 D2)', () => {
  it('a rectangle beam changed to an I meshes with the I bounding box, and re-parses as the I', async (t) => {
    if (!ensureWasm(t)) return;
    const rectangle = made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 0, 3], End: [6, 0, 3], Width: 0.3, Height: 0.5, Name: 'Steel' }));
    assert.equal(setElementProfileSection(MODEL_ID, rectangle, I), true);
    const { text, store, view, editor } = await exported();
    const id = idByName(text, 'IFCBEAM', 'Steel');
    // The I is 0.2 wide and 0.4 deep, centred on the axis: not the 0.3 x 0.5 rectangle it replaced.
    expectBox(meshBoxes(text).get(id)!, { min: [0, -0.1, 2.8], max: [6, 0.1, 3.2] });
    const chain = resolveLinearElementChain(store, view, editor, id, 1);
    assert.deepEqual(chain?.profile, I);
    assert.equal(chain?.depth, 6);
  });

  it('a beam placed as an I meshes with the I bounding box', async (t) => {
    if (!ensureWasm(t)) return;
    made(s().addBeam(MODEL_ID, STOREY, { Start: [0, 1, 3], End: [4, 1, 3], Profile: I, Name: 'Placed' }));
    const { text } = await exported();
    expectBox(meshBoxes(text).get(idByName(text, 'IFCBEAM', 'Placed'))!, { min: [0, 0.9, 2.8], max: [4, 1.1, 3.2] });
  });

  it('a column changed to a hollow circle meshes as the tube, and re-parses as it', async (t) => {
    if (!ensureWasm(t)) return;
    const column = made(s().addColumn(MODEL_ID, STOREY, { Position: [2, 2, 0], Width: 0.4, Depth: 0.4, Height: 3, Name: 'Tube' }));
    assert.equal(setElementProfileSection(MODEL_ID, column, CHS), true);
    const { text, store, view, editor } = await exported();
    const id = idByName(text, 'IFCCOLUMN', 'Tube');
    expectBox(meshBoxes(text).get(id)!, { min: [1.85, 1.85, 0], max: [2.15, 2.15, 3] });
    assert.deepEqual(resolveLinearElementChain(store, view, editor, id, 1)?.profile, CHS);
  });

  it('every kind of the picker meshes as its outline: across the beam is the section\'s width, up is its depth', async (t) => {
    if (!ensureWasm(t)) return;
    const shapes = PROFILE_KINDS.filter((kind) => kind !== 'Rectangle');
    shapes.forEach((kind, i) => made(s().addBeam(MODEL_ID, STOREY, { Start: [0, i * 2, 3], End: [4, i * 2, 3], Profile: DEFAULT_SECTIONS[kind as Exclude<typeof kind, 'Rectangle'>], Name: `K${kind}` })));
    const { text } = await exported();
    const boxes = meshBoxes(text);
    shapes.forEach((kind, i) => {
      const section = DEFAULT_SECTIONS[kind as Exclude<typeof kind, 'Rectangle'>];
      const [across, up] = profileSectionExtent(section);
      const box = boxes.get(idByName(text, 'IFCBEAM', `K${kind}`))!;
      // The wasm mesh spans the section's extent, centred on the axis: the outline the picker draws is the shape it meshes.
      expectBox(box, { min: [0, i * 2 - across / 2, 3 - up / 2], max: [4, i * 2 + across / 2, 3 + up / 2] });
      // And its corners are the outline's: an L's heel, a U's web side and a T's flange are where the picker draws them.
      // (A circle is tessellated by the mesher its own way; its extent is all it shares with the preview.)
      if (kind === 'Circle' || kind === 'CircleHollow') return;
      const start = box.points.filter((p) => Math.abs(p[0]) < 1e-4);
      for (const [px, py] of sectionOutline(section)!.outer) {
        assert.ok(start.some((p) => Math.abs(p[1] - (i * 2 + px)) < 2e-3 && Math.abs(p[2] - (3 + py)) < 2e-3), `${kind}: outline corner (${px}, ${py}) is a mesh vertex`);
      }
    });
  });
});
