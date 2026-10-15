/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { parseModel, IfcInputError, IfcParser, scanIfcEntities } from './index.js';

const sample = new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
const bytes = () => new Uint8Array(readFileSync(sample));
const text = (value: string) => new TextEncoder().encode(value);

describe('developer loading contract (DX1)', () => {
  it('loads an exact pooled Buffer view and reports record coverage', async () => {
    const input = bytes();
    const pooled = new Uint8Array(input.length + 64).fill(65);
    pooled.set(input, 32);
    const { store, report } = await parseModel(pooled.subarray(32, 32 + input.length), { disableWorkerScan: true });
    expect(store.schemaVersion).toBe('IFC4');
    expect(store.entityIndex.byType.get('IFCWALL')?.length).toBeGreaterThan(0);
    expect(report).toMatchObject({ completeness: 'complete', oversizedIdCount: 0, malformedRecordDetected: false });
    expect(report.scannedRecords).toBe(store.entityIndex.byId.size);
    expect(report.diagnostics).toEqual([]);
  });

  it.each([
    ['', 'EMPTY_INPUT'],
    ['plain text', 'INVALID_STEP'],
    ['ISO-10303-21;\nHEADER;', 'TRUNCATED_STEP'],
    ["ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;", 'MISSING_DATA'],
  ])('rejects invalid input with a stable code (%s)', async (input, code) => {
    await expect(parseModel(text(input))).rejects.toMatchObject({ name: 'IfcInputError', code });
    await expect(parseModel(text(input))).rejects.toBeInstanceOf(IfcInputError);
  });

  it('loads shared source bytes when the runtime rejects SAB text decoding (PR #7632)', () => {
    // A fresh realm installs the browser decoder policy before the shared
    // decoder is initialized. Execute the built consumer API, not a mock parser.
    const script = `
      const NativeDecoder = globalThis.TextDecoder;
      globalThis.TextDecoder = class extends NativeDecoder {
        decode(input, options) {
          if (input instanceof SharedArrayBuffer ||
              (ArrayBuffer.isView(input) && input.buffer instanceof SharedArrayBuffer)) {
            throw new TypeError('SharedArrayBuffer decoding is forbidden');
          }
          return super.decode(input, options);
        }
      };
      const { readFileSync } = await import('node:fs');
      const { parseModel } = await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
      const input = readFileSync(new URL(${JSON.stringify(sample.href)}));
      const shared = new Uint8Array(new SharedArrayBuffer(input.length));
      shared.set(input);
      const { store, report } = await parseModel(shared, { disableWorkerScan: true });
      if (report.completeness !== 'complete' || !store.entityIndex.byType.get('IFCWALL')?.length) {
        throw new Error('Shared model did not load completely');
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(result.stderr, result.stdout).not.toContain('TypeError');
    expect(result.status, result.stderr).toBe(0);
  });

  it('unwraps a real IFCZIP archive through the validated path', async () => {
    const zipped = zipSync({ 'model.ifc': bytes() });
    const { store, report } = await parseModel(zipped, { disableWorkerScan: true });
    expect(store.entityIndex.byType.get('IFCWALL')?.length).toBeGreaterThan(0);
    expect(report.completeness).toBe('complete');
  });

  it('distinguishes an archive with no IFC member from a bad STEP envelope', async () => {
    await expect(parseModel(zipSync({ 'readme.txt': text('no model') })))
      .rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });

  it('reports malformed records without pretending to count every lost record', async () => {
    const input = new TextDecoder().decode(bytes()).replace('END-ISO-10303-21;',
      "#99999=IFCWALL('unterminated);\nEND-ISO-10303-21;");
    const { report } = await parseModel(text(input), { disableWorkerScan: true });
    expect(report.completeness).toBe('incomplete');
    expect(report.malformedRecordDetected).toBe(true);
    expect(report.diagnostics.map(d => d.code)).toContain('MALFORMED_RECORD');
  });

  it('retains tolerant low-level parsing', async () => {
    const store = await new IfcParser().parseColumnar(text('plain text').buffer);
    expect(store.entityCount).toBe(0);
  });

  it('reports a partial record scan even though the STEP envelope is complete', async () => {
    const input = new TextDecoder().decode(bytes()).replace('END-ISO-10303-21;', "#4294967296=IFCWALL('0000000000000000000002',$,'lost',$,$,$,$,$,$);\nEND-ISO-10303-21;");
    const { store, report } = await parseModel(text(input), { disableWorkerScan: true });
    expect(store.entityIndex.byType.get('IFCWALL')?.length).toBeGreaterThan(0);
    expect(report.completeness).toBe('incomplete');
    expect(report.oversizedIdCount).toBe(1);
    expect(report.diagnostics.map(d => d.code)).toContain('OVERSIZED_EXPRESS_ID');
  });

  it('does not treat an older pre-scan producer as proof of complete coverage', async () => {
    const input = bytes();
    const scanned = await scanIfcEntities(input.buffer, { disableWorkerScan: true });
    const { report } = await parseModel(input, { preScannedEntityIndex: {
      ids: Uint32Array.from(scanned.entityRefs.map(r => r.expressId)),
      starts: Uint32Array.from(scanned.entityRefs.map(r => r.byteOffset)),
      lengths: Uint32Array.from(scanned.entityRefs.map(r => r.byteLength)),
      oversizedIdCount: 0,
    } });
    expect(report.completeness).toBe('unknown');
    expect(report.malformedRecordDetected).toBeNull();
    expect(report.diagnostics.map(d => d.code)).toEqual(['UNREPORTED_SCAN_COUNTS']);
  });

  const fzk = new URL('../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  it.skipIf(!existsSync(fzk))('loads the independently authored ArchiCAD FZK fixture (pnpm fixtures)', async () => {
    const { store, report } = await parseModel(new Uint8Array(readFileSync(fzk)), { disableWorkerScan: true });
    expect(store.entityIndex.byType.get('IFCDOOR')?.length).toBeGreaterThan(0);
    expect(report.completeness).toBe('complete');
    expect(store.schemaVersion).toBe('IFC4');
  });
});
