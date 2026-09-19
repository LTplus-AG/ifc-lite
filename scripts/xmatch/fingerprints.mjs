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
 * - the geometry half is `runGeometryPass` / `attachGeometryFingerprints` from
 *   the CLI's `--geometry` adapter (`packages/cli/dist/commands/diff-geometry.js`,
 *   issue #4956) — the wasm mesh pass with `setComputeGeometryHashes` on, the
 *   same `geometryHashValues` / `geometryAabbValues` the viewer's compare
 *   reads, in the same absolute-world Y-up frame.
 *
 * Until #4956 this module duplicated the geometry-pass assembly itself; now
 * both halves are the CLI's own code, so this file is what running
 * `ifc-lite diff --by-content --geometry` over the corpus looks like from
 * inside the harness, not a second opinion about it.
 *
 * Two more fields ride along since issue #4955, both resolved the way the
 * shipped adapters resolve them: `volume` from `geometryVolumeValues` (a
 * finite positive number, else absent — the engine's "absent means not
 * proved" contract), which is what lets a split claim reach `verified`
 * rather than `extent`; and `container`, the spatial name path from
 * `spatialContainerPath`, which the successor stage's `position` profile
 * requires equal and non-empty on both sides.
 */

import { readFileSync } from 'node:fs';
// Relative paths, not bare specifiers: the repo root has no `node_modules/
// @ifc-lite` (pnpm links workspace deps per package), and a script that
// resolved differently from the package it is measuring would be measuring
// something else.
import { IfcParser, spatialContainerPath } from '../../packages/parser/dist/index.js';
import { buildFileFingerprints } from '../../packages/cli/dist/commands/diff-engine.js';
import {
  attachGeometryFingerprints,
  GEOMETRY_HASH_TOLERANCE,
  runGeometryPass,
} from '../../packages/cli/dist/commands/diff-geometry.js';

export { GEOMETRY_HASH_TOLERANCE };

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
 * Fingerprint one file exactly as a viewer compare would see it.
 *
 * `stripKeys` replaces every fingerprint's `key` with an opaque per-file token.
 * The synthetic pairs do not need it — the head is genuinely re-GUIDed, so no
 * key survives — but any pair whose answer key lives in the GlobalId does, and
 * a fixture that leaves the answer visible in an input the matcher reads is
 * circular. The caller asserts the stripping actually happened.
 *
 * The pre-pass cache is cleared inside `runGeometryPass`'s own `finally`
 * (issue #4956), which matters here specifically: ONE `IfcAPI` is reused
 * across every base and head revision of every model in the corpus, so stale
 * wasm state carried from one file into the next would not look like a leak —
 * it would look like a matcher regression, in the one place whose whole
 * purpose is to be believed about matcher regressions.
 */
export async function fingerprintFile(path, api, { stripKeys = false } = {}) {
  const bytes = readFileSync(path);
  const store = await loadStore(bytes);
  const fingerprints = buildFileFingerprints(store);
  const geometry = runGeometryPass(api, bytes);
  attachGeometryFingerprints(fingerprints, geometry);

  for (const fingerprint of fingerprints) {
    // A NAME path (`Project/Building/Level 2/Room 204`), never GlobalIds, so
    // it survives the re-GUID; both revisions go through this one resolver.
    const container = spatialContainerPath(store, fingerprint.ref);
    if (container) fingerprint.container = container;
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
    meshedIds: new Set(geometry.hashes.keys()),
    unitScale: geometry.unitScale,
    originalKeys,
    schemaVersion: store.schemaVersion,
  };
}
