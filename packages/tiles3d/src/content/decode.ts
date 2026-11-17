/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Tile content sniffing and decoding into feature meshes. */

import { decodeUtf8, magicAt } from '../bytes.js';
import type { ContentBudget } from '../limits.js';
import type { Mat4 } from '../matrix.js';
import type { TileProvenance } from '../traverse.js';
import { parseB3dm } from './b3dm.js';
import type { DracoLoader } from './draco.js';
import { buildFeatureMeshes, type FeatureMesh } from './features.js';
import { parseGlb, parseGltfJson } from './gltf.js';

export type ContentKind = 'b3dm' | 'glb' | 'gltf' | 'tileset' | 'i3dm' | 'pnts' | 'cmpt' | 'subtree' | 'unknown';

/** Identify tile content by its magic, or as JSON (tileset vs glTF) by its keys. */
export function detectContentKind(bytes: Uint8Array): ContentKind {
  switch (magicAt(bytes)) {
    case 'b3dm': return 'b3dm';
    case 'glTF': return 'glb';
    case 'i3dm': return 'i3dm';
    case 'pnts': return 'pnts';
    case 'cmpt': return 'cmpt';
    case 'subt': return 'subtree';
  }
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) i++;
  if (bytes[i] !== 0x7b) return 'unknown';
  // Decide on the top-level keys of the full parse: a glTF may carry "root" or
  // "geometricError" in nested extras, which a text sniff cannot tell apart.
  try {
    const json = JSON.parse(decodeUtf8(bytes)) as unknown;
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const top = json as Record<string, unknown>;
      const gltfShaped = 'meshes' in top || 'accessors' in top || 'nodes' in top || 'scenes' in top || 'buffers' in top;
      if (!gltfShaped && ('root' in top || 'geometricError' in top)) return 'tileset';
    }
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // Unparsable: fall back to a key sniff on the head so a broken tileset is reported as one.
    const head = decodeUtf8(bytes, i, Math.min(bytes.length, i + 4096));
    if (/"root"\s*:/.test(head) || /"geometricError"\s*:/.test(head)) return 'tileset';
  }
  return 'gltf';
}

export interface DecodedContent {
  kind: ContentKind;
  features: FeatureMesh[];
  batchLength?: number;
  attributeNames?: string[];
  rtcCenter?: [number, number, number];
  warnings: string[];
  /** Set when the content was recognised but not decoded. */
  unsupported?: string;
}

const UNSUPPORTED: Partial<Record<ContentKind, string>> = {
  i3dm: 'Instanced 3D Model (i3dm) content is not supported',
  pnts: 'Point Cloud (pnts) content is not supported',
  cmpt: 'Composite (cmpt) content is not supported',
  subtree: 'implicit tiling subtree content is not supported',
  unknown: 'unrecognised tile content',
};

export async function decodeTileContent(
  bytes: Uint8Array,
  tile: TileProvenance,
  tileTransform: Mat4,
  loadDraco: DracoLoader,
  budget: ContentBudget,
): Promise<DecodedContent> {
  const kind = detectContentKind(bytes);
  // External tilesets are detected by content too, but traversal follows them; reaching here is a caller bug.
  if (kind === 'tileset') throw new Error('external tileset content must be traversed, not decoded');
  const warnings: string[] = [];
  const warn = (m: string): void => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  const unsupported = UNSUPPORTED[kind];
  if (unsupported) return { kind, features: [], warnings, unsupported };

  if (kind === 'b3dm') {
    const b3dm = parseB3dm(bytes);
    warnings.push(...b3dm.warnings);
    const features = await buildFeatureMeshes(parseGlb(b3dm.glb), {
      tile, tileTransform, rtcCenter: b3dm.rtcCenter, attributes: b3dm.row, loadDraco, warn, budget,
    });
    return { kind, features, batchLength: b3dm.batchLength, attributeNames: b3dm.attributeNames, rtcCenter: b3dm.rtcCenter, warnings };
  }
  const gltf = kind === 'glb' ? parseGlb(bytes) : parseGltfJson(bytes);
  const features = await buildFeatureMeshes(gltf, { tile, tileTransform, loadDraco, warn, budget });
  return { kind, features, warnings };
}
