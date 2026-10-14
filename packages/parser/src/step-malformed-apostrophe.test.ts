/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { StepTokenizer } from './tokenizer.js';
import { WORKER_CODE } from './scan-worker-source.js';
import { scanIfcEntities } from './entity-scanner.js';
import { QUADRATIC_RECORDS, QUADRATIC_WELL_FORMED, quadraticBudgetMs } from './step-record-boundary.vectors.js';

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


const records = [
  "#20=IFCWALL('id20',$,'it's',$,$,$,$,$,$);",
  "#21=IFCWALL('id21',$,'W2',$,$,$,$,$,$);",
  "#22=IFCWALL('id22',$,$,$,$,$,$,$,$);",
  "#30=IFCDOOR('id30',$,'Bob's',$,$,$,$,$,$);",
  "#31=IFCWALL('id31',$,'W4',$,$,$,$,$,$);",
];

describe('malformed apostrophes cannot silently swallow intervening STEP records (#7541)', () => {
  for (const paired of [false, true]) {
    it(`fast tokenizer and actual assembled worker report dropped malformed records (${paired ? 'pair' : 'single'})`, async () => {
      const input = records.map((r, i) => i === 3 && !paired ? r.replace("Bob's", "Bob''s") : r).join('\n');
      const bytes = new TextEncoder().encode(input);
      const expected = paired ? [21, 22, 31] : [21, 22, 30, 31];
      const tokenizer = new StepTokenizer(bytes);
      const refs = [...tokenizer.scanEntitiesFast()];
      expect(refs.map(r => r.expressId)).toEqual(expected);
      expect(tokenizer.malformedRecordCount).toBe(1);
      for (const ref of refs) {
        expect(input.slice(ref.offset, ref.offset + ref.length)).toBe(
          records.find(r => r.startsWith(`#${ref.expressId}=`))?.replace("Bob's", "Bob''s"),
        );
      }
      const result = worker(bytes);
      expect([...new Uint32Array(result.ids)].slice(0, result.count)).toEqual(expected);
      expect(result.malformedRecords).toBe(1);
      const diagnostics: string[] = [];
      const scanned = await scanIfcEntities(Uint8Array.from(bytes).buffer, {
        disableWorkerScan: true, onDiagnostic: value => diagnostics.push(value),
      });
      expect(scanned.entityRefs.map(r => r.expressId)).toEqual(expected);
      expect(scanned.malformedRecordCount).toBe(1);
      expect(diagnostics.some(value => value.includes('incomplete view'))).toBe(true);
    });
  }

  it('balanced scan refuses corrupt parity rather than presenting a merged record', () => {
    const tokenizer = new StepTokenizer(new TextEncoder().encode(records.join('\n')));
    expect([...tokenizer.scanEntities()]).toEqual([]);
    expect(tokenizer.malformedRecordCount).toBe(1);
  });

  for (const literal of ["'it''s'", "'it'\n's'", "'literal;\n#999=IFCWALL(''still text'');'"]) {
    it(`valid literal retains exact record bytes: ${JSON.stringify(literal)}`, () => {
      const input = `#20=IFCWALL('id20',$,${literal},$);\n#21=IFCWALL($);`;
      const bytes = new TextEncoder().encode(input);
      const tokenizer = new StepTokenizer(bytes);
      const refs = [...tokenizer.scanEntitiesFast()];
      expect(refs.map(r => r.expressId)).toEqual([20, 21]);
      expect(input.slice(refs[0].offset, refs[0].offset + refs[0].length)).toBe(input.slice(0, input.lastIndexOf('\n#21')));
      expect(tokenizer.malformedRecordCount).toBe(0);
      const result = worker(bytes);
      expect([...new Uint32Array(result.ids)].slice(0, result.count)).toEqual([20, 21]);
      expect(result.malformedRecords).toBe(0);
    });
  }
});

for (const mode of ['fast', 'worker'] as const) {
  for (const tail of ['', "#20001=B('q';\nENDSEC;\n"]) {
    it(`forward quote recovery bounds all work without losing its diagnostic (${mode}, ${Boolean(tail)}) #7541`, () => {
      const drain = (text: string) => {
        const bytes = new TextEncoder().encode(text);
        const start = performance.now();
        if (mode === 'worker') {
          const result = worker(bytes);
          return { found: result.count, malformed: result.malformedRecords, ms: performance.now() - start };
        }
        const tokenizer = new StepTokenizer(bytes);
        const found = [...tokenizer.scanEntitiesFast()].length;
        return { found, malformed: tokenizer.malformedRecordCount, ms: performance.now() - start };
      };
      const baseline = drain(QUADRATIC_WELL_FORMED.repeat(QUADRATIC_RECORDS));
      expect(baseline.found).toBe(QUADRATIC_RECORDS);
      expect(baseline.malformed).toBe(0);
      const actual = drain("#1=A('x'y);\n".repeat(QUADRATIC_RECORDS) + tail);
      expect(actual.found).toBe(0);
      expect(actual.malformed).toBe(1);
      expect(actual.ms).toBeLessThan(quadraticBudgetMs(baseline.ms));
    }, 120_000);
  }
}

for (const [name, text, expected] of [
  ['quoted apparent declaration', "#1=A('it's','valid;\n#999=B($);');\n#2=B($);", [2]],
  ['doubled quote and quoted apparent declaration', "#1=A('it's','valid ''quote'';\n#999=B($);');\n#2=B($);", [2]],
  ['ambiguous subsequent quote', "#1=A('it's','also bad'quote;\n#999=B($);');\n#2=B($);", []],
  ['unclosed subsequent quote', "#1=A('it's','unclosed;\n#999=B($);\n#2=B($);", []],
] as const) {
  it(`conservative recovery never invents records from later literal text: ${name} (#7541)`, () => {
    const bytes = new TextEncoder().encode(text);
    const tokenizer = new StepTokenizer(bytes);
    expect([...tokenizer.scanEntitiesFast()].map(ref => ref.expressId)).toEqual(expected);
    expect(tokenizer.malformedRecordCount).toBe(1);
    const result = worker(bytes);
    expect([...new Uint32Array(result.ids)].slice(0, result.count)).toEqual(expected);
    expect(result.malformedRecords).toBe(1);
  });
}

for (const [name, text, expected, flag] of [
  ['unclosed comment after a closing quote', "#1=A('a' /* 'ghost',\n#999=B($);\n#2=B($);", [], 1],
  ['closed comment after a closing quote', "#1=A('a' /* 'ghost',\n#999=B($); */,$);\n#2=B($);", [1, 2], 0],
] as const) {
  it(`quoted-value trivia preserves the comment refusal contract: ${name} (#7541)`, () => {
    const bytes = new TextEncoder().encode(text);
    const tokenizer = new StepTokenizer(bytes);
    expect([...tokenizer.scanEntitiesFast()].map(ref => ref.expressId)).toEqual(expected);
    expect(tokenizer.malformedRecordCount).toBe(flag);
    const result = worker(bytes);
    expect([...new Uint32Array(result.ids)].slice(0, result.count)).toEqual(expected);
    expect(result.malformedRecords).toBe(flag);
  });
}
