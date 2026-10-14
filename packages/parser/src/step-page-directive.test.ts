/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { StepTokenizer } from './tokenizer.js';
import { WORKER_CODE } from './scan-worker-source.js';
import { scanIfcEntities } from './entity-scanner.js';
import { skipStringLiteral, StepTextScan } from './step-lexing.js';

const vectors: { name: string; literal: string }[] = JSON.parse(readFileSync(
  new URL('../../../rust/core/tests/fixtures/step-page-directive.json', import.meta.url), 'utf8',
));

function file(literal: string, paired: boolean, trailingComment: boolean) {
  const records = [
    `#20=IFCWALL('0000000000000000000020',$,${literal},$,$,$,$,$,$)${trailingComment ? ' /* ) ; */ ' : ''};`,
    "#21=IFCWALL('0000000000000000000021',$,'W-2',$,$,$,$,$,$);",
    "#22=IFCWALL('0000000000000000000022',$,'W-3',$,$,$,$,$,$);",
    `#30=IFCDOOR('0000000000000000000030',$,${paired ? literal : "'D-1'"},$,$,$,$,$,$,$,$,$,$);`,
    '#31=IFCCARTESIANPOINT((1.,2.,3.));',
  ];
  const text = [
    'ISO-10303-21;', 'HEADER;', `FILE_DESCRIPTION((${literal}),'2;1');`,
    "FILE_NAME('page','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;', 'DATA;', ...records, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  return { text, records, bytes: new TextEncoder().encode(text) };
}

interface WorkerResult {
  ids: ArrayBuffer;
  offsets: ArrayBuffer;
  lengths: ArrayBuffer;
  types: string[];
  count: number;
  malformedRecords: number;
}

function worker(bytes: Uint8Array): WorkerResult {
  let result: WorkerResult | undefined;
  const self = {
    onmessage: undefined as undefined | ((e: { data: ArrayBuffer }) => void),
    postMessage(value: WorkerResult) { result = value; },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- execute the actual Blob worker source.
  new Function('self', WORKER_CODE)(self);
  if (!self.onmessage) throw new Error('worker did not install its message handler');
  self.onmessage({ data: Uint8Array.from(bytes).buffer });
  if (!result) throw new Error('worker did not return its actual scan');
  return result;
}

describe('legal PAGE apostrophe operands remain inside STEP strings (#7540)', () => {
  for (const { name, literal } of vectors) {
    it(`${name}: both lexical representations consume exactly the literal`, () => {
      const bytes = new TextEncoder().encode(literal + ',NEXT');
      expect(skipStringLiteral(bytes, 0, bytes.length)).toBe(literal.length);
      expect(new StepTextScan(literal + ',NEXT').skipLexicalAt(0)).toBe(literal.length);
    });

    for (const [paired, trailingComment] of [[false, false], [true, true]] as const) {
      it(`${name}: all TS scan paths retain records and original spans (${paired ? 'pair' : 'single'})`, async () => {
        const { text, records, bytes } = file(literal, paired, trailingComment);
        for (const mode of ['fast', 'balanced'] as const) {
          const tokenizer = new StepTokenizer(bytes);
          const refs = [...(mode === 'fast' ? tokenizer.scanEntitiesFast() : tokenizer.scanEntities())];
          expect(refs.map(ref => ref.expressId)).toEqual([20, 21, 22, 30, 31]);
          expect(tokenizer.malformedRecordCount).toBe(0);
          for (const [index, ref] of refs.entries()) {
            const original = text.slice(ref.offset, ref.offset + ref.length);
            expect(mode === 'fast' ? original : original + (trailingComment && index === 0 ? ' /* ) ; */ ;' : ';'))
              .toBe(records[index]);
          }
        }
        const result = worker(bytes);
        expect([...new Uint32Array(result.ids)].slice(0, result.count)).toEqual([20, 21, 22, 30, 31]);
        expect(result.malformedRecords).toBe(0);
        const offsets = new Uint32Array(result.offsets), lengths = new Uint32Array(result.lengths);
        for (let index = 0; index < result.count; index++) {
          expect(text.slice(offsets[index], offsets[index] + lengths[index])).toBe(records[index]);
        }
        const diagnostics: string[] = [];
        const scanned = await scanIfcEntities(Uint8Array.from(bytes).buffer, {
          disableWorkerScan: true, onDiagnostic: message => diagnostics.push(message),
        });
        expect(scanned.entityRefs.map(ref => ref.expressId)).toEqual([20, 21, 22, 30, 31]);
        expect(scanned.malformedRecordCount).toBe(0);
        expect(diagnostics.some(message => message.includes('dropped a record'))).toBe(false);
      });
    }
  }

  it('still reports an unterminated string after a PAGE operand', () => {
    const bytes = new TextEncoder().encode("#20=X('Para \\S\\' no closing quote);\n#21=X($);");
    const tokenizer = new StepTokenizer(bytes);
    expect([...tokenizer.scanEntitiesFast()]).toEqual([]);
    expect(tokenizer.malformedRecordCount).toBe(1);
    const result = worker(bytes);
    expect(result.count).toBe(0);
    expect(result.malformedRecords).toBe(1);
  });
});
