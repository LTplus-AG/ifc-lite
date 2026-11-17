/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Open a GLB the way an external viewer would: the container, the scene graph
 * and the POSITION accessors. Tests read the file through this instead of
 * trusting what the exporter was handed.
 */

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extras?: { expressId?: number; ifcType?: string; GlobalId?: string };
}

interface GltfJson {
  scene?: number;
  scenes: { nodes: number[] }[];
  nodes: GltfNode[];
  meshes: { primitives: { attributes: { POSITION: number } }[] }[];
  accessors: { min?: number[]; max?: number[] }[];
}

export interface GlbMeshNode {
  expressId: number | undefined;
  ifcType: string | undefined;
  globalId: string | undefined;
  /** POSITION corners of this node's mesh in world space, glTF Y-up. */
  corners: number[][];
}

export interface OpenedGlb {
  /** Mesh count in the glTF `meshes` array: instancing shares one across nodes. */
  meshCount: number;
  nodes: GlbMeshNode[];
  expressIds: Set<number>;
}

type Mat4 = number[];
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major 4x4 product. */
function multiply(a: Mat4, b: Mat4): Mat4 {
  return Array.from({ length: 16 }, (_, i) => {
    const col = Math.floor(i / 4), row = i % 4;
    return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[col * 4 + k], 0);
  });
}

function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function transform(m: Mat4, [x, y, z]: number[]): number[] {
  return [0, 1, 2].map((row) => m[row] * x + m[4 + row] * y + m[8 + row] * z + m[12 + row]);
}

/** Every corner of an accessor's declared min/max box. */
function boxCorners(min: number[], max: number[]): number[][] {
  const corners: number[][] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);
  return corners;
}

export function readGlb(bytes: Uint8Array): OpenedGlb {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB: bad magic');
  if (data.getUint32(4, true) !== 2) throw new Error('not a glTF 2 binary');
  if (data.getUint32(8, true) !== bytes.byteLength) throw new Error('GLB header length disagrees with the file');
  const jsonLength = data.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GltfJson;

  const nodes: GlbMeshNode[] = [];
  const visit = (index: number, parent: Mat4, inherited: GltfNode['extras']) => {
    const node = gltf.nodes[index];
    const world = multiply(parent, localMatrix(node));
    const extras = node.extras ?? inherited;
    if (node.mesh !== undefined) {
      const corners = gltf.meshes[node.mesh].primitives.flatMap((primitive) => {
        const { min, max } = gltf.accessors[primitive.attributes.POSITION];
        if (!min || !max) throw new Error('POSITION accessor without min/max is invalid glTF');
        return boxCorners(min, max).map((corner) => transform(world, corner));
      });
      nodes.push({ expressId: extras?.expressId, ifcType: extras?.ifcType, globalId: extras?.GlobalId, corners });
    }
    for (const child of node.children ?? []) visit(child, world, extras);
  };
  for (const root of gltf.scenes[gltf.scene ?? 0].nodes) visit(root, IDENTITY, undefined);

  return {
    meshCount: gltf.meshes.length,
    nodes,
    expressIds: new Set(nodes.flatMap((node) => (node.expressId === undefined ? [] : [node.expressId]))),
  };
}

/** World-space bounds of one element across all its nodes. */
export function worldBounds(glb: OpenedGlb, expressId: number): { min: number[]; max: number[] } {
  const corners = glb.nodes.filter((node) => node.expressId === expressId).flatMap((node) => node.corners);
  if (corners.length === 0) throw new Error(`no node for #${expressId}`);
  return {
    min: [0, 1, 2].map((axis) => Math.min(...corners.map((corner) => corner[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...corners.map((corner) => corner[axis]))),
  };
}
