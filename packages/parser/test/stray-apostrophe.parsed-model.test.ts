/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7541 end to end: `parseColumnar` on a file holding two unescaped
 * apostrophes, on the TypeScript scan and on the real wasm scan (skipped when
 * the runtime is not built). Before the fix both read #20 as one record
 * running to #30's ';', so #21, #22 and #30 were missing and `onDiagnostic`
 * stayed silent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IfcParser } from '../src/index.js';
import type { WasmScanApi } from '../src/entity-scanner.js';

const WASM = fileURLToPath(new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
// The runtime's JS glue ships beside the binary, so the binary decides.
const WASM_BUILT = existsSync(WASM);
const SAMPLE = fileURLToPath(new URL(
  '../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url,
));

const DROPPED = "scan: dropped a record with no terminating ';' (an unterminated or unescaped";

const gid = (n: number) => String(n).padStart(22, '0');
const PAIR = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
  "FILE_NAME('apostrophe-pair.ifc','2026-10-12T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
  `#1=IFCPROJECT('${gid(1)}',$,'Project',$,$,$,$,$,#3);`,
  '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  '#3=IFCUNITASSIGNMENT((#2));',
  `#20=IFCWALL('${gid(20)}',$,'it's',$,$,$,$,$,$);`,
  `#21=IFCWALL('${gid(21)}',$,'W2',$,$,$,$,$,$);`,
  `#22=IFCWALL('${gid(22)}',$,$,$,$,$,$,$,$);`,
  `#30=IFCDOOR('${gid(30)}',$,'Bob's',$,$,$,$,$,$);`,
  `#31=IFCWALL('${gid(31)}',$,'W4',$,$,$,$,$,$);`,
  'ENDSEC;', 'END-ISO-10303-21;', '',
].join('\n');

function encode(source: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(source);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
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

async function parse(source: string, wasmApi?: WasmScanApi) {
  const diagnostics: string[] = [];
  const store = await new IfcParser().parseColumnar(encode(source), {
    disableWorkerScan: true,
    wasmApi,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  const ids = [...store.entityIndex.byId.keys()].sort((a, b) => a - b);
  return { ids, diagnostics };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const PATHS: [string, () => Promise<WasmScanApi | undefined>, boolean][] = [
  ['TypeScript scan', async () => undefined, false],
  ['real wasm scan', loadRealWasmScan, !WASM_BUILT],
];

describe.each(PATHS)('parseColumnar, %s (#7541)', (_label, api, skip) => {
  it.skipIf(skip)('reads the records between two unescaped apostrophes and reports both', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ids, diagnostics } = await parse(PAIR, await api());
    expect(ids).toEqual([1, 2, 3, 21, 22, 31]);
    expect(diagnostics.some((m) => m.startsWith(DROPPED))).toBe(true);
  });

  it.skipIf(skip)('the committed sample reads in full with nothing reported', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ids, diagnostics } = await parse(readFileSync(SAMPLE, 'utf8'), await api());
    expect(ids).toHaveLength(444);
    expect(diagnostics.filter((m) => m.startsWith('scan: dropped'))).toEqual([]);
  });

  it.skipIf(skip)("the sample with each \\X\\27 written as a bare ' loses only the four records holding one", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = readFileSync(SAMPLE, 'utf8');
    const all = (await parse(source, await api())).ids;
    const { ids, diagnostics } = await parse(source.replaceAll('\\X\\27', "'"), await api());
    // Before the fix #394, #395, #424 and #425 vanished silently instead,
    // taking both roof slabs and an IDS failure on them with them.
    expect(all.filter((id) => !ids.includes(id))).toEqual([393, 395, 423, 425]);
    expect(diagnostics.some((m) => m.startsWith(DROPPED))).toBe(true);
  });
});
