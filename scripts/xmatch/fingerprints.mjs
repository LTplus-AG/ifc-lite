/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One revision → the {@link EntityFingerprint}s the matcher actually consumes.
 *
 * Both halves are the SHIPPED code, imported rather than re-implemented — a
 * fixture that scores a private copy of the fingerprint builder measures the
 * copy:
 *
 * - the data half is `buildFileFingerprints` from the CLI's own adapter
 *   (`packages/cli/dist/commands/diff-engine.js`), which walks every
 *   `IfcObjectDefinition` and hashes it with `@ifc-lite/diff`'s canonical
 *   `buildDataFingerprint` / `buildComponentFingerprints`;
 * - the geometry half is the wasm mesh pass with `setComputeGeometryHashes`
 *   on — the same `geometryHashValues` / `geometryAabbValues` the viewer's
 *   compare reads, in the same absolute-world Y-up frame.
 *
 * The CLI adapter alone is data-scope (Node has no geometry pipeline), so this
 * module is what a headless run of the VIEWER's compare looks like: real data
 * fingerprints with the real world geometry hash and world box attached.
 */

import { readFileSync } from 'node:fs';
// Relative paths, not bare specifiers: the repo root has no `node_modules/
// @ifc-lite` (pnpm links workspace deps per package), and a script that
// resolved differently from the package it is measuring would be measuring
// something else.
import { IfcParser } from '../../packages/parser/dist/index.js';
import { buildFileFingerprints } from '../../packages/cli/dist/commands/diff-engine.js';

/** Quantization grid for the geometry hash, in metres. The wasm default
 *  (`DEFAULT_GEOM_HASH_TOLERANCE`), stated here because the fixture's
 *  calibration stratum reasons about it. */
export const GEOMETRY_HASH_TOLERANCE = 1e-3;

/** Parse STEP bytes into an `IfcDataStore`, quietly. */
async function loadStore(bytes) {
  const parser = new IfcParser();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await parser.parseColumnar(buffer, { onDiagnostic: () => {} });
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/**
 * Run the wasm geometry pass and collect per-entity world hashes and boxes.
 *
 * Returns `{ hashes, aabbs, unitScale }`, both maps keyed by express id. A box
 * with a non-finite coordinate is DROPPED rather than passed on: the engine
 * treats a present box as usable, and a NaN would classify every comparison it
 * touches as garbage rather than abstaining.
 */
function geometryPass(api, bytes) {
  const pre = api.buildPrePassOnce(bytes);
  const hashes = new Map();
  const aabbs = new Map();
  const unitScale = pre?.unitScale ?? 1;
  const total = pre?.totalJobs ?? 0;

  // The pre-pass cache is cleared in an OUTER finally, exactly as
  // `scripts/lib/mesh-via-prepass.mjs` does it, and for a reason this harness
  // feels harder than a script that processes one file: ONE `IfcAPI` is reused
  // across every base and head revision of every model in the corpus. A model
  // that produces no jobs, or a `processGeometryBatch` that throws, would
  // otherwise carry a populated cache into the NEXT file — and stale wasm
  // state between two revisions does not look like a leak, it looks like a
  // matcher regression, in the one place whose whole purpose is to be believed
  // about matcher regressions.
  try {
    if (!pre || !pre.jobs || total === 0) return { hashes, aabbs, unitScale };

    const [rtcX, rtcY, rtcZ] = pre.rtcOffset ? Array.from(pre.rtcOffset) : [0, 0, 0];
    const collection = api.processGeometryBatch(
      bytes,
      pre.jobs,
      pre.unitScale,
      rtcX,
      rtcY,
      rtcZ,
      pre.needsShift,
      pre.voidKeys,
      pre.voidCounts,
      pre.voidValues,
      pre.styleIds,
      pre.styleColors,
    );
    try {
      const ids = collection.geometryHashIds;
      const values = collection.geometryHashValues;
      const boxes = collection.geometryAabbValues;
      for (let i = 0; i < ids.length; i++) {
        hashes.set(ids[i], values[i]);
        const box = Array.from(boxes.slice(6 * i, 6 * i + 6));
        if (box.length === 6 && box.every((value) => Number.isFinite(value))) {
          aabbs.set(ids[i], { min: [box[0], box[1], box[2]], max: [box[3], box[4], box[5]] });
        }
      }
    } finally {
      collection.free();
    }
  } finally {
    if (api.clearPrePassCache) api.clearPrePassCache();
  }
  return { hashes, aabbs, unitScale };
}

/**
 * Fingerprint one file exactly as a viewer compare would see it.
 *
 * `stripKeys` replaces every fingerprint's `key` with an opaque per-file token.
 * The synthetic pairs do not need it — the head is genuinely re-GUIDed, so no
 * key survives — but any pair whose answer key lives in the GlobalId does, and
 * a fixture that leaves the answer visible in an input the matcher reads is
 * circular. The caller asserts the stripping actually happened.
 */
export async function fingerprintFile(path, api, { stripKeys = false } = {}) {
  const bytes = readFileSync(path);
  const store = await loadStore(bytes);
  const fingerprints = buildFileFingerprints(store);
  const { hashes, aabbs, unitScale } = geometryPass(api, bytes);

  for (const fingerprint of fingerprints) {
    const hash = hashes.get(fingerprint.ref);
    if (hash !== undefined) fingerprint.geometryHash = hash;
    const aabb = aabbs.get(fingerprint.ref);
    if (aabb !== undefined) fingerprint.aabb = aabb;
  }

  const originalKeys = new Map();
  if (stripKeys) {
    for (const [ordinal, fingerprint] of fingerprints.entries()) {
      originalKeys.set(fingerprint.ref, fingerprint.key);
      fingerprint.key = `opaque:${path}:${ordinal}`;
    }
  }

  return {
    fingerprints,
    meshedIds: new Set(hashes.keys()),
    unitScale,
    originalKeys,
    schemaVersion: store.schemaVersion,
  };
}
