/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ISO 10303-21 allows a comment anywhere whitespace is allowed, including
// *inside* a record. Every scanner in this package used to treat one as trivia
// only BETWEEN records, so two spec-legal shapes misparsed:
//
//   #1 /* n */ = IFCWALL(...);      the '=' check failed, no record at all
//   #2=IFCWALL('a', /* n; */ $);    the ';' in the comment ended it early, so
//                                   the span handed downstream was truncated
//
// The three TypeScript scanners (scanEntities, scanEntitiesFast, and the
// inline worker) are exercised over one fixture set each, because they are
// three loops that must agree; the Rust EntityScanner half of the same rule
// lives in rust/core/src/parser/scanner_tests.rs.
//
// Line comments, not JSDoc, so the delimiters can be spelled literally --
// the same reason step-lexing.ts gives for its byte half.

import { describe, expect, it } from 'vitest';
import { WORKER_CODE } from '../src/scan-worker-inline.js';
import { StepTokenizer } from '../src/tokenizer.js';

interface ScannedRecord {
    expressId: number;
    type: string;
    /** The exact source bytes the scanner claims the record spans. */
    text: string;
}

const encoder = new TextEncoder();

function decodeSpan(source: string, offset: number, length: number): string {
    return new TextDecoder().decode(encoder.encode(source).subarray(offset, offset + length));
}

function viaScanEntities(source: string): ScannedRecord[] {
    const tokenizer = new StepTokenizer(encoder.encode(source));
    return [...tokenizer.scanEntities()].map((r) => ({
        expressId: r.expressId,
        type: r.type,
        text: decodeSpan(source, r.offset, r.length),
    }));
}

function viaScanEntitiesFast(source: string): ScannedRecord[] {
    const tokenizer = new StepTokenizer(encoder.encode(source));
    return [...tokenizer.scanEntitiesFast()].map((r) => ({
        expressId: r.expressId,
        type: r.type,
        text: decodeSpan(source, r.offset, r.length),
    }));
}

interface WorkerScanMessage {
    ids: ArrayBuffer;
    offsets: ArrayBuffer;
    lengths: ArrayBuffer;
    types: string[];
    count: number;
}

function viaWorker(source: string): ScannedRecord[] {
    const buffer = encoder.encode(source).buffer;
    const mockSelf: Record<string, unknown> & { onmessage?: (e: { data: ArrayBuffer }) => void } = {};
    let message: WorkerScanMessage | undefined;
    mockSelf.postMessage = (msg: WorkerScanMessage) => { message = msg; };
    const install = new Function('self', WORKER_CODE) as (s: unknown) => void;
    install(mockSelf);
    mockSelf.onmessage!({ data: buffer as ArrayBuffer });
    if (!message) throw new Error('worker did not postMessage a result');
    const ids = new Uint32Array(message.ids);
    const offsets = new Uint32Array(message.offsets);
    const lengths = new Uint32Array(message.lengths);
    const out: ScannedRecord[] = [];
    for (let i = 0; i < message.count; i++) {
        out.push({
            expressId: ids[i],
            type: message.types[i],
            text: decodeSpan(source, offsets[i], lengths[i]),
        });
    }
    return out;
}

// scanEntities closes a record on the balancing ')', the two fast scanners on
// the terminating ';'. That is a pre-existing, deliberate difference in what a
// record's span means, so each scanner is asserted against its own terminator
// rather than being forced to agree on a byte count.
const scanners = [
    { name: 'scanEntities', run: viaScanEntities, closer: ')' },
    { name: 'scanEntitiesFast', run: viaScanEntitiesFast, closer: ';' },
    { name: 'inline worker', run: viaWorker, closer: ';' },
] as const;

const PREAMBLE = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n';
const EPILOGUE = 'ENDSEC;\nEND-ISO-10303-21;\n';

function file(...records: string[]): string {
    return PREAMBLE + records.join('\n') + '\n' + EPILOGUE;
}

/** The record text up to and including this scanner's terminator. */
function spanOf(record: string, closer: string): string {
    return closer === ';' ? record : record.slice(0, record.lastIndexOf(')') + 1);
}

describe.each(scanners)('$name: a comment is trivia inside a record too', ({ run, closer }) => {
    it('reads a record carrying a comment between the instance name and the =', () => {
        const record = "#1 /* was #7 */ = IFCWALL('a',$);";
        expect(run(file(record))).toEqual([
            { expressId: 1, type: 'IFCWALL', text: spanOf(record, closer) },
        ]);
    });

    it('does not end a record at a ; inside a comment', () => {
        const record = "#2=IFCWALL('a', /* pending; revise */ $);";
        expect(run(file(record))).toEqual([
            { expressId: 2, type: 'IFCWALL', text: spanOf(record, closer) },
        ]);
    });

    it('reads a comment between the = and the type name, and before the (', () => {
        const record = "#3= /* a */ IFCWALL /* b */ ('a',$);";
        expect(run(file(record))).toEqual([
            { expressId: 3, type: 'IFCWALL', text: spanOf(record, closer) },
        ]);
    });

    // Composition, direction one: a comment opener inside a string literal is
    // ordinary text. Skipping the literal first is what keeps it that way.
    it('treats a comment opener inside a string literal as literal text', () => {
        const record = "#4=IFCWALL('rev /* pending */ note',$);";
        expect(run(file(record))).toEqual([
            { expressId: 4, type: 'IFCWALL', text: spanOf(record, closer) },
        ]);
    });

    // Composition, direction two: a quote inside a comment does not open a
    // string. Skipping the comment as a region is what keeps it that way -- an
    // in-comment apostrophe used to flip the fast scanners' quote parity and
    // swallow the terminator.
    it('treats a quote inside a comment as comment text', () => {
        const record = "#5=IFCWALL(/* don't reuse */ 'a',$);";
        expect(run(file(record))).toEqual([
            { expressId: 5, type: 'IFCWALL', text: spanOf(record, closer) },
        ]);
    });

    // The paren-matching scanner counted parentheses inside a comment as depth.
    it('does not count parentheses inside a comment', () => {
        const record = "#6=IFCWALL('a', /* see IFCWALL( */ $);";
        expect(run(file(record))).toEqual([
            { expressId: 6, type: 'IFCWALL', text: spanOf(record, closer) },
        ]);
    });

    it('keeps scanning records after one carrying comments', () => {
        const first = "#7 /* x */ = IFCWALL('a', /* y; */ $);";
        const second = "#8=IFCSLAB('b',$);";
        const records = run(file(first, second));
        expect(records.map((r) => r.expressId)).toEqual([7, 8]);
        expect(records[1].text).toBe(spanOf(second, closer));
    });

    // A commented-out record must still not be scanned as a record.
    it('still ignores a record that is entirely inside a comment', () => {
        const records = run(file("/* #9=IFCWALL('x',$); */", "#10=IFCSLAB('b',$);"));
        expect(records.map((r) => r.expressId)).toEqual([10]);
    });

    it('parses a comment-free file identically', () => {
        const records = run(file("#11=IFCWALL('a',$);", '#12=IFCSLAB($,$);'));
        expect(records.map((r) => r.expressId)).toEqual([11, 12]);
        expect(records.map((r) => r.type)).toEqual(['IFCWALL', 'IFCSLAB']);
    });
});
