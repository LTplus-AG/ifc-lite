/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `WORKER_CODE` is a template-literal STRING (a Blob worker cannot import at
 * runtime), so `tokenizer.test.ts` and `entity-scanner.malformed-record.test.ts`
 * exercising `StepTokenizer`/`scanIfcEntities` never touch this copy of the
 * scan loop at all — the browser's actual Web Worker load path. This test
 * evaluates the template directly (mocking `self`) so the unterminated-string
 * fix (tokenizer.ts's `scanEntitiesFast`) has a counterpart proving the third
 * copy of the same loop was not missed, the way it was easy to miss during
 * the #3675 rebase.
 */

import { describe, expect, it } from 'vitest';
import { WORKER_CODE } from './scan-worker-source.js';
import { MAX_EXPRESS_ID } from './express-id.js';

interface WorkerScanMessage {
  ids: ArrayBuffer;
  count: number;
  oversizedIds: number;
  malformedRecords: number;
}

/** Runs `WORKER_CODE` against a mock `self`, the same way the Blob worker
 *  runtime would, and returns what it posted back. */
function runWorkerCode(text: string): WorkerScanMessage {
  // Built from concatenated pieces, not a literal '${MAX_EXPRESS_ID}' string:
  // that literal trips eslint(no-template-curly-in-string), which assumes a
  // string containing "${...}" is a forgotten template literal. Here it is
  // deliberately a plain-string needle for the unsubstituted placeholder that
  // would remain in WORKER_CODE if scan-worker-source.ts's own template
  // interpolation of MAX_EXPRESS_ID ever regressed into emitting the raw
  // placeholder text instead of the numeric value.
  const placeholder = '$' + '{MAX_EXPRESS_ID}';
  const source = WORKER_CODE.replace(placeholder, String(MAX_EXPRESS_ID));
  let result: WorkerScanMessage | undefined;
  const self = {
    onmessage: null as ((e: { data: ArrayBuffer }) => void) | null,
    postMessage(data: WorkerScanMessage) {
      result = data;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- this
  // template IS a worker script, evaluating it is the only way to exercise it.
  new Function('self', `${source}\nreturn self;`)(self);
  const buffer = new TextEncoder().encode(text);
  self.onmessage!({ data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) });
  if (!result) throw new Error('WORKER_CODE never posted a result');
  return result;
}

describe('scan-worker-source WORKER_CODE: unterminated string literal', () => {
  it('stops at the broken record and reports malformedRecords, like tokenizer.ts', () => {
    const text = [
      "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);",
      // Opens a quote in the Name argument and never closes it.
      "#2=IFCWALL('0000000000000000000002',$,'Wall2 unterminated,$,$,$,$,$,$);",
      "#3=IFCWALL('0000000000000000000003',$,'Wall3',$,$,$,$,$,$);",
    ].join('\n');

    const result = runWorkerCode(text);
    expect(result.count).toBe(1);
    expect(result.malformedRecords).toBe(1);
    expect(Array.from(new Uint32Array(result.ids))).toEqual([1]);
  });

  it('reports malformedRecords 0 for a well-formed file', () => {
    const text = [
      "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);",
      "#2=IFCWALL('0000000000000000000002',$,'Wall2',$,$,$,$,$,$);",
      "#3=IFCWALL('0000000000000000000003',$,'Wall3',$,$,$,$,$,$);",
    ].join('\n');

    const result = runWorkerCode(text);
    expect(result.count).toBe(3);
    expect(result.malformedRecords).toBe(0);
  });

  it('reports malformedRecords for an unterminated comment inside a record (already correct here; tokenizer.ts was not)', () => {
    // WORKER_CODE's copy of this branch does `pos = len; break;`, which falls
    // through to the count below the loop -- unlike tokenizer.ts's matching
    // branch, which used to `return` early and skip it. This fixture already
    // passed before the tokenizer.ts fix; kept as the cross-copy control that
    // proves the two scan loops now agree, not just on the unterminated-
    // string shape both had a test for already, but on this one too.
    const text = [
      "#1=IFCWALL('0000000000000000000001', /* never closes $,$,$,$,$,$,$);",
      "#2=IFCWALL('0000000000000000000002',$,'Wall2',$,$,$,$,$,$);",
    ].join('\n');

    const result = runWorkerCode(text);
    expect(result.count).toBe(0);
    expect(result.malformedRecords).toBe(1);
  });

  it('reports malformedRecords for an unterminated comment before the record body opens', () => {
    // The three `opensCommentAt` checks before '=', the type name, and '('
    // each `break` out of the top-level scan loop directly on an
    // unterminated comment -- not the record-body loop the previous test
    // covers, so they never reached that loop's own `malformedRecords++`.
    // Same fix as tokenizer.ts's matching skipTrivia branches.
    const text = "#1 /* never closes\n#2=IFCWALL('0000000000000000000002',$,'Wall2',$,$,$,$,$,$);";

    const result = runWorkerCode(text);
    expect(result.count).toBe(0);
    expect(result.malformedRecords).toBe(1);
  });
});
