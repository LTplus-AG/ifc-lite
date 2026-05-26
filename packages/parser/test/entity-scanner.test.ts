/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '../src/index.js';
import { scanIfcEntities, type WasmScanApi } from '../src/entity-scanner.js';

const IFC_SOURCE = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#1=IFCPROJECT('0Project',$,'Project',$,$,$,$,(#2),#3);",
  "#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#4,$);",
  '#3=IFCUNITASSIGNMENT((#5));',
  "#4=IFCAXIS2PLACEMENT3D(#6,$,$);",
  '#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  "#6=IFCCARTESIANPOINT((0.,0.,0.));",
  "#7=IFCWALL('0Wall',$,'Wall with ; semicolon',$,$,$,$,$,.NOTDEFINED.);",
  'ENDSEC;',
  'END-ISO-10303-21;',
].join('\n');

function encodeSource(): ArrayBuffer {
  const bytes = new TextEncoder().encode(IFC_SOURCE);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function entitySpan(expressId: number): { start: number; length: number } {
  const start = IFC_SOURCE.indexOf(`#${expressId}=`);
  if (start < 0) {
    throw new Error(`Fixture entity #${expressId} not found`);
  }
  let inString = false;
  let end = -1;
  for (let i = start; i < IFC_SOURCE.length; i++) {
    const char = IFC_SOURCE[i];
    if (char === "'") {
      if (inString && IFC_SOURCE[i + 1] === "'") {
        i++;
        continue;
      }
      inString = !inString;
    } else if (char === ';' && !inString) {
      end = i + 1;
      break;
    }
  }
  if (end <= start) {
    throw new Error(`Fixture entity #${expressId} not found`);
  }
  return { start, length: end - start };
}

describe('scanIfcEntities', () => {
  it('uses the TypeScript tokenizer fallback as the canonical in-process scan', async () => {
    const result = await scanIfcEntities(encodeSource(), { disableWorkerScan: true });

    expect(result.scanPath).toBe('tokenizer');
    expect(result.processed).toBe(7);
    expect(result.entityRefs.map((ref) => ref.expressId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.entityRefs.at(-1)?.type).toBe('IFCWALL');
  });

  it('normalizes WASM snake_case and camelCase scan records through one path', async () => {
    const wall = entitySpan(7);
    const project = entitySpan(1);
    const wasmApi: WasmScanApi = {
      scanEntitiesFastBytes: () => [
        {
          express_id: 1,
          entity_type: 'IFCPROJECT',
          byte_offset: project.start,
          byte_length: project.length,
          line_number: 6,
        },
        {
          expressId: 7,
          type: 'IFCWALL',
          byteOffset: wall.start,
          byteLength: wall.length,
          lineNumber: 12,
        },
      ],
    };

    const result = await scanIfcEntities(encodeSource(), {
      disableWorkerScan: true,
      wasmApi,
    });

    expect(result.scanPath).toBe('wasm');
    expect(result.entityRefs).toEqual([
      {
        expressId: 1,
        type: 'IFCPROJECT',
        byteOffset: project.start,
        byteLength: project.length,
        lineNumber: 6,
      },
      {
        expressId: 7,
        type: 'IFCWALL',
        byteOffset: wall.start,
        byteLength: wall.length,
        lineNumber: 12,
      },
    ]);
  });

  it('prefers a pre-scanned entity index over worker, WASM, and tokenizer scans', async () => {
    const project = entitySpan(1);
    const wall = entitySpan(7);
    const wasmApi: WasmScanApi = {
      scanEntitiesFastBytes: () => {
        throw new Error('WASM should not run when pre-scanned refs are available');
      },
    };

    const result = await scanIfcEntities(encodeSource(), {
      disableWorkerScan: true,
      wasmApi,
      preScannedEntityIndex: {
        ids: new Uint32Array([1, 7]),
        starts: new Uint32Array([project.start, wall.start]),
        lengths: new Uint32Array([project.length, wall.length]),
      },
    });

    expect(result.scanPath).toBe('pre-scanned');
    expect(result.entityRefs.map((ref) => `${ref.expressId}:${ref.type}`)).toEqual([
      '1:IFCPROJECT',
      '7:IFCWALL',
    ]);
  });
});

describe('IfcParser legacy ParseResult adapter', () => {
  it('reuses the shared scanner and still extracts eager entities', async () => {
    const parser = new IfcParser();
    const result = await parser.parse(encodeSource(), { disableWorkerScan: true });

    expect(result.entityCount).toBe(7);
    expect(result.entities.get(7)?.type).toBe('IFCWALL');
    expect(result.entities.get(7)?.attributes[2]).toBe('Wall with ; semicolon');
    expect(result.entityIndex.byType.get('IFCWALL')).toEqual([7]);
  });
});
