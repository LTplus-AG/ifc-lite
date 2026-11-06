/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9011: `ifc-lite export --format glb --name-by-global-id` through the REAL
 * wasm boundary. Each element becomes one top-level node named by its
 * `GlobalId`, holding its mesh parts; without the flag the GLB keeps its one
 * unnamed root. The Rust side pins placement and payload identity across all
 * three assemblers (`rust/export/tests/issue_9011_element_nodes_by_global_id.rs`);
 * this pins that the flag reaches it from the command line.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { exportCommand } from './export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Four mapped proxies in a rotated site, GlobalIds `777777777777777777000A`..`D`. */
const MODEL = join(__dirname, '../../../../rust/geometry/tests/fixtures/mapped_instances_site_rotated.ifc');
const GUIDS = ['777777777777777777000A', '777777777777777777000B', '777777777777777777000C', '777777777777777777000D'];

interface GltfNode { name?: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[] }
interface Gltf { scenes: Array<{ nodes: number[] }>; nodes: GltfNode[] }

/** The JSON chunk of a GLB. */
function glbJson(bytes: Uint8Array): Gltf {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('glTF');
  const jsonLength = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Gltf;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function exportGlb(extra: string[]): Promise<Gltf> {
  const dir = mkdtempSync(join(tmpdir(), 'ifclite-glb-guid-'));
  dirs.push(dir);
  const out = join(dir, 'model.glb');
  // Keep the command's own logging off the test output.
  const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await exportCommand([MODEL, '--format', 'glb', ...extra, '--out', out]);
  } finally {
    writeSpy.mockRestore();
  }
  return glbJson(new Uint8Array(readFileSync(out)));
}

describe('export --format glb --name-by-global-id (#9011)', () => {
  it('names one top-level node per element by its GlobalId, parenting its parts', async () => {
    const gltf = await exportGlb(['--name-by-global-id']);
    const top = gltf.scenes[0].nodes.map((i) => gltf.nodes[i]);
    expect(top.map((n) => n.name).sort()).toEqual(GUIDS);
    const parts = new Set<number>();
    for (const node of top) {
      expect(node.mesh).toBeUndefined();
      expect(node.children?.length).toBeGreaterThan(0);
      for (const c of node.children ?? []) parts.add(c);
    }
    // Only element nodes are named; every part sits under exactly one of them.
    expect(gltf.nodes.filter((n) => n.name !== undefined)).toHaveLength(GUIDS.length);
    expect(parts.size).toBe(top.reduce((sum, n) => sum + (n.children?.length ?? 0), 0));
  }, 60_000);

  it('without the flag keeps the single unnamed root over the same parts', async () => {
    const [plain, named] = [await exportGlb([]), await exportGlb(['--name-by-global-id'])];
    expect(plain.scenes[0].nodes).toHaveLength(1);
    const root = plain.nodes[plain.scenes[0].nodes[0]];
    expect(plain.nodes.every((n) => n.name === undefined)).toBe(true);
    // Same part nodes, regrouped; each element node carries the root's transform.
    const regrouped = named.scenes[0].nodes.flatMap((i) => named.nodes[i].children ?? []);
    expect(regrouped.sort((a, b) => a - b)).toEqual([...(root.children ?? [])].sort((a, b) => a - b));
    for (const i of named.scenes[0].nodes) {
      expect(named.nodes[i].translation).toEqual(root.translation);
      expect(named.nodes[i].rotation).toEqual(root.rotation);
    }
  }, 60_000);
});
