/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Server mesh → viewer mesh conversion (extracted from useIfcServer for unit
 * testing — this is the exact seam that used to silently drop the canonical
 * per-mesh transform metadata, issue #1841).
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { MeshData as ServerMeshData } from '@ifc-lite/server-client';

/** `values` itself when it already is the wanted typed array; a copy of a plain array (the JSON transport). */
function asTyped<T extends Float32Array | Uint32Array>(values: ArrayLike<number> | T, Typed: { new (values: ArrayLike<number>): T }): T {
  return values instanceof Typed ? values as T : new Typed(values);
}

/**
 * Convert one server mesh (snake_case wire shape) to the viewer's canonical
 * camelCase `MeshData`.
 *
 * Carries the canonical `origin` / `geometryClass` fields through (issue #1841)
 * so origin-relative geometry and instanced-template occurrences render in the
 * correct place — the same contract as the WASM path — instead of collapsing
 * onto the world origin ("N slabs collapse to one"). Both are omitted when
 * absent / zero, matching the WASM output so world-baked meshes stay identical.
 */
export function convertServerMesh(m: ServerMeshData): MeshData {
  return {
    expressId: m.express_id,
    // The Parquet decoders already hand out fresh typed arrays (views into the batch's slabs): take them
    // as they are. Copying gave every mesh three more buffers, and a federation slot spent most of its
    // load in the garbage collections those allocations started (see `typed-array-slab.ts` in server-client).
    positions: asTyped(m.positions, Float32Array),
    indices: asTyped(m.indices, Uint32Array),
    normals: m.normals ? asTyped(m.normals, Float32Array) : new Float32Array(0),
    color: m.color,
    ifcType: m.ifc_type,
    // Omit a zero origin rather than stamping `[0,0,0]`: the parquet decoder and
    // the Rust serde skip it for world-baked meshes, so carrying it here would
    // make the same mesh decode to a different shape depending on transport.
    ...(m.origin?.some((v) => v !== 0) ? { origin: m.origin } : {}),
    ...(m.geometry_class ? { geometryClass: m.geometry_class } : {}),
    // The two DISJOINT source ids (#3199). Tested against `undefined`, never for
    // truthiness -- unlike the two optionals above, which are correctly
    // truthiness-gated because a zero origin and class 0 are both the default.
    //
    // The server never sends `0` for either id (`#0` is not a STEP instance
    // name; an air-gap layer is sent as absent), so this converter would be
    // gating on a value it can never see. That is exactly why it must NOT gate:
    // a converter enforcing a producer's invariant turns a future producer bug
    // into silent data loss here instead of a visible wrong id upstream, and
    // dropping an id is how the REST path keeps rendering identically while a
    // host loses the ability to drill from a picked piece to its source.
    ...(m.geometry_item_id !== undefined ? { geometryItemId: m.geometry_item_id } : {}),
    ...(m.material_id !== undefined ? { materialId: m.material_id } : {}),
    // The IFC-authored finish (#5984), into the same `material` slot the WASM
    // path fills. `undefined`-tested for the same reason as the ids: roughness
    // 0 is AC20-FZK-Haus.ifc's authored glass, and a truthiness test turns it
    // into the renderer's default.
    ...(m.metallic !== undefined || m.roughness !== undefined
      ? {
          material: {
            ...(m.metallic !== undefined ? { metallic: m.metallic } : {}),
            ...(m.roughness !== undefined ? { roughness: m.roughness } : {}),
          },
        }
      : {}),
  };
}
