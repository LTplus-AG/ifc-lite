/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7393: the WASM scan path reported dropped and skipped records to the
 * console only, never through `onDiagnostic`.
 *
 * The recipe from the issue: a DATA section with one record missing its
 * terminating ';' (#3695, dropped since #4179) and one record whose express id
 * does not fit 32 bits (#3395). Parsed with the TypeScript tokenizer, both
 * refusals reach `onDiagnostic`; parsed with `wasmApi` from `@ifc-lite/wasm`,
 * the same records went missing and the caller heard nothing. Both paths are
 * asserted here against the same source and the same messages, and the wasm
 * half runs the real Rust scan (skipped when the runtime is not built).
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IfcParser } from '../src/index.js';
import type { WasmScanApi } from '../src/entity-scanner.js';

const WASM = fileURLToPath(new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const WASM_JS = fileURLToPath(new URL('../../wasm/pkg/ifc-lite.js', import.meta.url));
const WASM_BUILT = existsSync(WASM) && existsSync(WASM_JS);

const ABOVE_U32 = 4_294_967_297;

const SOURCE = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#1=IFCWALL('GID-one',$,'Wall one',$,$,$,$,$,.NOTDEFINED.);",
  // No terminating ';': dropped, and the scan resumes at the balancing ')'.
  "#2=IFCWALL('GID-two',$,'Wall two',$,$,$,$,$,.NOTDEFINED.)",
  `#${ABOVE_U32}=IFCWALL('GID-big',$,'Wall big',$,$,$,$,$,.NOTDEFINED.);`,
  "#3=IFCWALL('GID-three',$,'Wall three',$,$,$,$,$,.NOTDEFINED.);",
  'ENDSEC;',
  'END-ISO-10303-21;',
].join('\n');

const DROPPED = "scan: dropped a record with no terminating ';'";
const SKIPPED = 'scan: skipped 1 record(s) with an express id above 4294967295 (#3395)';

function encode(source: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(source);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function parseCollecting(wasmApi?: WasmScanApi) {
  const diagnostics: string[] = [];
  const store = await new IfcParser().parseColumnar(encode(SOURCE), {
    disableWorkerScan: true,
    wasmApi,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  return { store, diagnostics };
}

function expectRefusalsReported(diagnostics: string[]): void {
  expect(diagnostics.some((m) => m.startsWith(DROPPED))).toBe(true);
  expect(diagnostics).toContain(SKIPPED);
}

let realApi: WasmScanApi | undefined;
async function loadRealWasmScan(): Promise<WasmScanApi> {
  if (realApi) return realApi;
  const { IfcAPI, initSync } = await import('@ifc-lite/wasm');
  initSync({ module: readFileSync(WASM) });
  const api = new IfcAPI();
  realApi = { scanEntitiesFastBytes: api.scanEntitiesFastBytes.bind(api) };
  return realApi;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scan refusals reach onDiagnostic on every scan path (#7393)', () => {
  it('TypeScript tokenizer path reports the dropped and the oversized record', async () => {
    const { store, diagnostics } = await parseCollecting();

    expectRefusalsReported(diagnostics);
    expect([...store.entityIndex.byId.keys()].sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it.skipIf(!WASM_BUILT)('real WASM scan path reports the same refusals through onDiagnostic', async () => {
    const wasmApi = await loadRealWasmScan();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { store, diagnostics } = await parseCollecting(wasmApi);

    expectRefusalsReported(diagnostics);
    // Same records missing as on the tokenizer path, so the diagnostics are
    // describing a real loss, not a different scan.
    expect([...store.entityIndex.byId.keys()].sort((a, b) => a - b)).toEqual([1, 3]);
    // Rust already prints each refusal; the parser must not print it again.
    const printed = warn.mock.calls.map((args) => String(args[0]));
    expect(printed.filter((line) => line.includes(SKIPPED))).toHaveLength(1);
    expect(printed.filter((line) => line.includes(DROPPED))).toHaveLength(1);
  });

  it.skipIf(!WASM_BUILT)('real WASM scan reports nothing for a clean file', async () => {
    const wasmApi = await loadRealWasmScan();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const diagnostics: string[] = [];
    await new IfcParser().parseColumnar(
      encode(SOURCE.replace("NOTDEFINED.)\n", 'NOTDEFINED.);\n').replace(`#${ABOVE_U32}=`, '#4=')),
      { disableWorkerScan: true, wasmApi, onDiagnostic: (m) => diagnostics.push(m) },
    );

    expect(diagnostics.filter((m) => m.startsWith(DROPPED) || m.startsWith('scan: skipped'))).toEqual([]);
  });
});
