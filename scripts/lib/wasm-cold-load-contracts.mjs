/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Source and owned-buffer contracts registered by the real WASM harness. */
import { checkMeshGetterOwnershipContract } from './wasm-mesh-getter-ownership-contract.mjs';
import { checkSourceFingerprintContract, checkPrepassReservationContract } from './wasm-source-fingerprint-contract.mjs';
import { checkAffinityChunkContract } from './wasm-affinity-chunk-contract.mjs';
import { checkPrepassSourceContract } from './wasm-prepass-source-contract.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import assert from 'node:assert/strict';

/** Preserve the caller's test/skip accounting and optional retained-runtime checks. */
export async function runColdLoadContracts({
  IfcAPI, ownershipWasmExports, columnContent, FIXTURES_DIR, FIXTURES_HINT, SPACES_AVAILABLE, SPACES_IFC, test, skip
}) {
  test('processGeometryBatchFromSource returns empty when no source is installed (defensive)', () => {
    const freshApi = new IfcAPI();
    const bytes = new TextEncoder().encode(columnContent);
    try {
      const pre = freshApi.buildPrePassOnce(bytes);
      // No setSourceBytes: the held bytes are empty → zero meshes, and crucially
      // NO panic (the decoder validates every byte span). The JS worker gates the
      // *FromSource path on a successful setSourceBytes, so this is unreachable in
      // production, but it must degrade gracefully rather than corrupt/crash.
      const col = freshApi.processGeometryBatchFromSource(
        pre.jobs, pre.unitScale,
        pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
      );
      try {
        assert.equal(col.length, 0, 'FromSource without setSourceBytes must produce no meshes');
      } finally {
        col.free();
      }
    } finally {
      freshApi.clearPrePassCache();
      freshApi.free();
    }
  });

  test('streaming affinity chunks retain complete ordered owned payloads (cold-load audit)', () => {
    checkAffinityChunkContract(IfcAPI);
  });

  test('prepass full-source fingerprint preserves old entry points and malformed tails (#3985)', () => {
    checkSourceFingerprintContract(IfcAPI, new TextEncoder().encode(columnContent), true);
  });

  // Optional retained baseline artifacts exercise a genuinely matched historical pair.
  if (process.env.IFC_WASM_BASE_JS || process.env.IFC_WASM_BASE_BINARY) {
    assert.ok(process.env.IFC_WASM_BASE_JS && process.env.IFC_WASM_BASE_BINARY,
      'Both IFC_WASM_BASE_JS and IFC_WASM_BASE_BINARY must identify the same retained build');
    const baselineWasm = await import(pathToFileURL(process.env.IFC_WASM_BASE_JS).href);
    const baselineOwnershipExports = baselineWasm.initSync(readFileSync(process.env.IFC_WASM_BASE_BINARY));
    test('matched historical mesh getters preserve owned-buffer contract (#3989)', () => {
      checkMeshGetterOwnershipContract(baselineWasm.IfcAPI, baselineOwnershipExports.memory, new TextEncoder().encode(columnContent));
    });
    test('matched historical JS/WASM retains its advertised fingerprint capability (#3985)', () => {
      const probe = new baselineWasm.IfcAPI();
      let enhanced;
      try { enhanced = typeof probe.buildPrePassStreamingWithSourceFingerprint === 'function'; }
      finally { probe.free(); }
      checkSourceFingerprintContract(baselineWasm.IfcAPI, new TextEncoder().encode(columnContent), enhanced);
    });
    test('prebuilt and serial prepasses preserve retained-runtime jobs, styles and geometry (#3985)', () => {
      const source = new TextEncoder().encode(columnContent);
      const tail = new Uint8Array(source.length + 17);
      tail.set(source); tail.set(new TextEncoder().encode('\n/* unclosed tail'), source.length);
      const sources = [source, tail, new Uint8Array()];
      if (SPACES_AVAILABLE) sources.push(new Uint8Array(readFileSync(SPACES_IFC)));
      checkPrepassReservationContract(IfcAPI, baselineWasm.IfcAPI, sources);
    });
  } else {
    skip('matched historical fingerprint fallback', 'set IFC_WASM_BASE_JS and IFC_WASM_BASE_BINARY to one retained baseline build');
  }

  test('mesh getters own transferable backing after free and memory growth (#3989)', () => {
    checkMeshGetterOwnershipContract(IfcAPI, ownershipWasmExports.memory, new TextEncoder().encode(columnContent));
  });
  for (const [kind, name] of [['embedded', 'tessellation-with-pixel-texture.ifc'], ['external', 'tessellation-with-image-texture.ifc']]) {
    const file = join(FIXTURES_DIR, 'buildingsmart/annex_e/tessellated-shape-with-style', name);
    if (existsSync(file)) test(`${kind} texture getters own transferable backing (#3989)`, () => {
      checkMeshGetterOwnershipContract(IfcAPI, ownershipWasmExports.memory, new Uint8Array(readFileSync(file)), kind);
    });
    else skip(`${kind} texture getter ownership (#3989)`, `${name} absent; ${FIXTURES_HINT}`);
  }

  test('owned source spans scan, style assistance, replacement and cleanup (#3989)', () => {
    const sources = [new TextEncoder().encode(columnContent)];
    if (SPACES_AVAILABLE) sources.push(new Uint8Array(readFileSync(SPACES_IFC)));
    checkPrepassSourceContract(IfcAPI, sources);
  });
}
