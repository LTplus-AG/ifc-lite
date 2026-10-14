/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7541: an unescaped apostrophe (`'it's'` for `'it''s'`) flipped every
 * scanner's in-string state, and a second one flipped it back, so the records
 * between them vanished with nothing reported. Each vector in
 * rust/core/tests/fixtures/step-stray-apostrophe.json is run through the TypeScript fast
 * scan and the Blob worker here, and through the Rust scanner and the real wasm
 * elsewhere, against the same expected ids.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { StepTokenizer } from './tokenizer.js';
import { WORKER_CODE } from './scan-worker-source.js';
import { MAX_EXPRESS_ID } from './express-id.js';

interface Vector {
  name: string;
  records: string[];
  ids: number[];
  malformed: number[];
  joiner?: string;
  misframed?: number[];
}

const vectors: Vector[] = JSON.parse(readFileSync(
  new URL('../../../rust/core/tests/fixtures/step-stray-apostrophe.json', import.meta.url), 'utf8',
));

const HEADER = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n" +
  "FILE_NAME('a','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";

function fileOf(v: Vector): string {
  const joiner = v.joiner ?? '\n';
  return HEADER + v.records.join(joiner) + (joiner || '\n') + 'ENDSEC;\nEND-ISO-10303-21;\n';
}

/** The record text a scan must return for `id`: from its `#id=` to its own `;`. */
function expectedSpan(v: Vector, id: number): string {
  const decl = `#${id}=`;
  const record = v.records.find((r) => r.includes(decl));
  if (!record) throw new Error(`${v.name}: no record declares ${decl}`);
  return record.slice(record.indexOf(decl));
}

interface Scanned { id: number; offset: number; length: number; line: number }

function fast(text: string): { refs: Scanned[]; malformed: number } {
  const tokenizer = new StepTokenizer(new TextEncoder().encode(text));
  const refs = [...tokenizer.scanEntitiesFast()].map((r) => (
    { id: r.expressId, offset: r.offset, length: r.length, line: r.line }
  ));
  return { refs, malformed: tokenizer.malformedRecordCount };
}

interface WorkerResult {
  ids: ArrayBuffer; offsets: ArrayBuffer; lengths: ArrayBuffer; lines: ArrayBuffer;
  count: number; malformedRecords: number;
}

function worker(text: string): { refs: Scanned[]; malformed: number } {
  const source = WORKER_CODE.replace('$' + '{MAX_EXPRESS_ID}', String(MAX_EXPRESS_ID));
  let result: WorkerResult | undefined;
  const self = {
    onmessage: null as ((e: { data: ArrayBuffer }) => void) | null,
    postMessage(data: WorkerResult) { result = data; },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the template IS the worker script.
  new Function('self', `${source}\nreturn self;`)(self);
  const bytes = new TextEncoder().encode(text);
  self.onmessage!({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  if (!result) throw new Error('WORKER_CODE never posted a result');
  const ids = new Uint32Array(result.ids), offsets = new Uint32Array(result.offsets);
  const lengths = new Uint32Array(result.lengths), lines = new Uint32Array(result.lines);
  const refs: Scanned[] = [];
  for (let i = 0; i < result.count; i++) {
    refs.push({ id: ids[i], offset: offsets[i], length: lengths[i], line: lines[i] });
  }
  return { refs, malformed: result.malformedRecords };
}

// The text is ASCII except one vector, whose UTF-8 bytes shift offsets: map
// byte offsets back through the encoded buffer rather than the JS string.
function slice(text: string, offset: number, length: number): string {
  return new TextDecoder().decode(new TextEncoder().encode(text).subarray(offset, offset + length));
}
function prefix(text: string, offset: number): string {
  return new TextDecoder().decode(new TextEncoder().encode(text).subarray(0, offset));
}

describe('an unescaped apostrophe drops only the records it can reach (#7541)', () => {
  for (const [label, scan] of [['scanEntitiesFast', fast], ['WORKER_CODE', worker]] as const) {
    describe(label, () => {
      for (const v of vectors) {
        it(v.name, () => {
          const text = fileOf(v);
          const { refs, malformed } = scan(text);
          expect(refs.map((r) => r.id)).toEqual(v.ids);
          expect(malformed, 'the refusal is reported').toBe(v.malformed.length > 0 ? 1 : 0);
          for (const ref of refs) {
            if (v.misframed?.includes(ref.id)) continue;
            expect(slice(text, ref.offset, ref.length), `#${ref.id} span`).toBe(expectedSpan(v, ref.id));
            // 1-based, so a resume that miscounts the lines it skipped shows here.
            expect(ref.line, `#${ref.id} line`).toBe(prefix(text, ref.offset).split('\n').length);
          }
        });
      }
    });
  }

  it('StepTokenizer.scanEntities stops at the first refused record and reports it', () => {
    const pair = vectors.find((v) => v.name === 'pair')!;
    const tokenizer = new StepTokenizer(new TextEncoder().encode(fileOf(pair)));
    expect([...tokenizer.scanEntities()].map((r) => r.expressId)).toEqual([1, 2, 3]);
    expect(tokenizer.malformedRecordCount).toBe(1);
  });

  it('StepTokenizer.scanEntities still reads every legal vector in full', () => {
    for (const v of vectors.filter((x) => x.name.startsWith('legal') || x.name.startsWith('control'))) {
      const tokenizer = new StepTokenizer(new TextEncoder().encode(fileOf(v)));
      expect([...tokenizer.scanEntities()].map((r) => r.expressId), v.name).toEqual(v.ids);
      expect(tokenizer.malformedRecordCount, v.name).toBe(0);
    }
  });
});
