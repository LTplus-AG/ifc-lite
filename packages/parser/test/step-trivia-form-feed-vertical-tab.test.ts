/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Issue #3733: form feed (0x0C) and vertical tab (0x0B) were legal STEP
// token separators that TWO of the three TS entity scanners' whitespace sets
// omitted (`isSpaceByte` in step-lexing.ts and its inline twins in
// tokenizer.ts/scan-worker-source.ts), while Rust's `skip_step_trivia` used
// `u8::is_ascii_whitespace`, which follows the WhatWG set: it includes form
// feed but excludes vertical tab. So `#1=\x0cIFCWALL('a');` parsed on the
// Rust side and silently dropped the entity on all three TS scanners --
// same file, different answer depending on which engine ran.
//
// The project already resolved this exact question once, for the HEADER
// scanner: `isAsciiSpace` (step-lexing.ts's `StepTextScan`) and
// `is_step_space` (rust/export/src/source_header.rs) both spell out the full
// six-byte set (space, tab, LF, CR, form feed, vertical tab) rather than
// trust a stdlib "ASCII whitespace" helper, after a regression where doing
// exactly that mismatched the two halves on vertical tab
// (`FILE_SCHEMA\x0B(('IFC4X3'))`). This file extends that same six-byte set
// to the entity-level scanners, and fixes Rust's `skip_step_trivia` to spell
// the set out too rather than reach for `is_ascii_whitespace` again.
//
// Reuses the three-scanner harness from step-comment-trivia.test.ts, because
// the bug this issue reports is exactly that shape: a test that only
// exercises one scanner stays green through a divergence between the others.

import { describe, expect, it } from 'vitest';
import { WORKER_CODE } from '../src/scan-worker-inline.js';
import { StepTokenizer } from '../src/tokenizer.js';
import { buildEntityRefsFromIndex } from '../src/entity-refs-from-index.js';

interface ScannedRecord {
    expressId: number;
    type: string;
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
// the terminating ';' -- the same pre-existing, deliberate span difference
// step-comment-trivia.test.ts documents.
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

function spanOf(record: string, closer: string): string {
    return closer === ';' ? record : record.slice(0, record.lastIndexOf(')') + 1);
}

const FF = '\x0c';
const VT = '\x0b';

describe.each(scanners)('$name: form feed and vertical tab are trivia', ({ run, closer }) => {
    it('reads a record whose instance name is preceded by a form feed', () => {
        const record = `${FF}#1=IFCWALL('a',$);`;
        // The leading control byte sits before the record entirely, so the
        // scanned span starts at the '#', not at the control byte -- this
        // asserts the entity is FOUND at all, which is the reported defect.
        const records = run(file(record));
        expect(records.map((r) => r.expressId)).toEqual([1]);
        expect(records[0].type).toBe('IFCWALL');
    });

    it('reads a record whose type name is preceded by a form feed', () => {
        const record = `#2=${FF}IFCWALL('a',$);`;
        expect(run(file(record))).toEqual([
            { expressId: 2, type: 'IFCWALL', text: spanOf(record, closer) },
        ]);
    });

    it('reads a record whose type name is preceded by a vertical tab', () => {
        const record = `#3=${VT}IFCWALL('a',$);`;
        expect(run(file(record))).toEqual([
            { expressId: 3, type: 'IFCWALL', text: spanOf(record, closer) },
        ]);
    });

    it('reads a form feed between the instance name and the =', () => {
        const record = `#4${FF}=IFCWALL('a',$);`;
        expect(run(file(record))).toEqual([
            { expressId: 4, type: 'IFCWALL', text: spanOf(record, closer) },
        ]);
    });

    it('reads a vertical tab between the type name and the (', () => {
        const record = `#5=IFCWALL${VT}('a',$);`;
        expect(run(file(record))).toEqual([
            { expressId: 5, type: 'IFCWALL', text: spanOf(record, closer) },
        ]);
    });

    // Control: ordinary space/tab/CR/LF whitespace must keep working exactly
    // as before -- this fix must not narrow the existing set.
    it('still reads a record separated by ordinary whitespace', () => {
        const record = "#6 \t= IFCWALL ('a',$);";
        expect(run(file(record))).toEqual([
            { expressId: 6, type: 'IFCWALL', text: spanOf(record, closer) },
        ]);
    });

    // The boundary case: a form feed INSIDE a quoted string is string
    // content, not trivia. A fix that skips trivia before checking for a
    // string opener is correct; one that skips trivia unconditionally over
    // string content would corrupt the argument list.
    it('does not treat a form feed inside a string literal as trivia', () => {
        const record = `#7=IFCWALL('a${FF}b',$);`;
        const records = run(file(record));
        expect(records.map((r) => r.expressId)).toEqual([7]);
        // The scanned span still reaches the record's real terminator, i.e.
        // the control byte inside the string did not get treated as if it
        // ended anything or got skipped out of the argument list.
        expect(records[0].text).toBe(spanOf(record, closer));
    });

    it('does not treat a vertical tab inside a string literal as trivia', () => {
        const record = `#8=IFCWALL('a${VT}b',$);`;
        const records = run(file(record));
        expect(records.map((r) => r.expressId)).toEqual([8]);
        expect(records[0].text).toBe(spanOf(record, closer));
    });

    it('keeps scanning records after one carrying a form feed', () => {
        const first = `#9=${FF}IFCWALL('a',$);`;
        const second = '#10=IFCSLAB($);';
        const records = run(file(first, second));
        expect(records.map((r) => r.expressId)).toEqual([9, 10]);
    });
});

describe('buildEntityRefsFromIndex: form feed and vertical tab are trivia', () => {
    // This is the parser worker's pre-pass fast path: it re-extracts each
    // entity's type token from an already-known byte span (computed by the
    // Rust wasm pre-pass) without re-scanning the whole file. It has its own
    // hand-duplicated whitespace byte set and needs the same two bytes added,
    // or it silently corrupts the type name into e.g. "\fIFCWALL" instead of
    // dropping the entity -- the same root cause, a different-shaped defect.
    it('skips a form feed between = and the type token', () => {
        const source = `#1=${FF}IFCWALL('a',$);`;
        const src = encoder.encode(source);
        const refs = buildEntityRefsFromIndex(
            src,
            Uint32Array.from([1]),
            Uint32Array.from([0]),
            Uint32Array.from([src.length]),
        );
        expect(refs[0].type).toBe('IFCWALL');
    });

    it('stops the type token at a trailing vertical tab', () => {
        const source = `#1=IFCWALL${VT}('a',$);`;
        const src = encoder.encode(source);
        const refs = buildEntityRefsFromIndex(
            src,
            Uint32Array.from([1]),
            Uint32Array.from([0]),
            Uint32Array.from([src.length]),
        );
        expect(refs[0].type).toBe('IFCWALL');
    });
});
