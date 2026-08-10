/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The inline scan worker caches decoded type names by a compound
 * `length:hash` key. A 32-bit rolling hash can collide, so a cache hit must
 * verify the actual bytes before reusing the cached name — otherwise two
 * distinct type tokens sharing a hash + length silently alias. This exercises
 * the WORKER_CODE scanner directly by running it inside a mock `self`.
 */

import { describe, it, expect } from 'vitest';
import { WORKER_CODE } from '../src/scan-worker-inline.js';

function runWorkerScanRaw(ifc: string): { types: string[]; ids: ArrayBuffer; lines: ArrayBuffer } {
    const buffer = new TextEncoder().encode(ifc).buffer;
    const mockSelf: Record<string, unknown> & {
        onmessage?: (e: { data: ArrayBuffer }) => void;
    } = {};
    let result: { types: string[]; ids: ArrayBuffer; lines: ArrayBuffer } | undefined;
    mockSelf.postMessage = (msg: { types: string[]; ids: ArrayBuffer; lines: ArrayBuffer }) => { result = msg; };
    // WORKER_CODE assigns `self.onmessage`; execute it with our mock as `self`.
    // eslint-disable-next-line no-new-func
    const install = new Function('self', WORKER_CODE) as (s: unknown) => void;
    install(mockSelf);
    mockSelf.onmessage!({ data: buffer });
    if (!result) throw new Error('worker did not postMessage a result');
    return result;
}

function runWorkerScan(ifc: string): string[] {
    return runWorkerScanRaw(ifc).types;
}

function runWorkerScanIds(ifc: string): number[] {
    return [...new Uint32Array(runWorkerScanRaw(ifc).ids)];
}

function runWorkerScanLines(ifc: string): number[] {
    return [...new Uint32Array(runWorkerScanRaw(ifc).lines)];
}

describe('scan-worker-inline type-name cache (hash-collision safety)', () => {
    it('does not alias two type names sharing a 32-bit hash + length', () => {
        // "Aa" and "BB" both have length 2 and the same rolling hash (4034), so
        // they map to the identical type-cache key. Without the byte-verify on a
        // cache hit, the second type ("BB") would be misread as the first ("Aa").
        const types = runWorkerScan('#1=Aa();\n#2=BB();\n');
        expect(types).toEqual(['Aa', 'BB']);
    });

    it('still reuses the cache for genuinely repeated type names', () => {
        const types = runWorkerScan('#1=IFCWALL();\n#2=IFCWALL();\n#3=IFCDOOR();\n');
        expect(types).toEqual(['IFCWALL', 'IFCWALL', 'IFCDOOR']);
    });
});

describe('scan-worker-inline and STEP comments', () => {
    // WORKER_CODE is a third copy of the fast scan loop, and it is the copy the
    // browser reaches first: entity-scanner.ts tries the worker before the wasm
    // scan and before StepTokenizer. A comment fix landing only on the tokenizer
    // would leave the shipping path unchanged, so the rule is pinned here too.
    it('does not yield a record that is commented out', () => {
        const src = ["#1=IFCWALL('a');", "/*#2=IFCWALL('b');*/", "#3=IFCWALL('c');"].join('\n');
        expect(runWorkerScanIds(src)).toEqual([1, 3]);
    });

    it('keeps line numbers correct when a record itself spans lines', () => {
        const src = ['#1=', "IFCWALL('a');", "#2=IFCWALL('b');"].join('\n');
        expect(runWorkerScanLines(src)).toEqual([1, 3]);
    });

    it('keeps line numbers correct across a multi-line comment', () => {
        const src = ["#1=IFCWALL('a');", '/* two', 'three', 'four */', "#2=IFCWALL('b');"].join('\n');
        expect(runWorkerScanLines(src)).toEqual([1, 5]);
    });

    it('stops at an unterminated comment rather than resuming inside it', () => {
        const src = ["#1=IFCWALL('a');", '/* never closed', "#2=IFCWALL('b');"].join('\n');
        expect(runWorkerScanIds(src)).toEqual([1]);
    });

    it('a slash-star in a HEADER string does not open a comment', () => {
        const src = [
            'ISO-10303-21;',
            'HEADER;',
            "FILE_DESCRIPTION(('rev /* pending'),'2;1');",
            'ENDSEC;',
            'DATA;',
            "#1=IFCWALL('a');",
            'ENDSEC;',
            'END-ISO-10303-21;',
        ].join('\n');
        expect(runWorkerScanIds(src)).toEqual([1]);
    });

    it('does not treat a slash-star inside a string literal as a comment', () => {
        // The outer loop only runs between records: a matched record is consumed
        // to its semicolon by the inner, string-aware loop. This pins that, so a
        // later edit cannot quietly expose the outer loop to string bytes.
        const src = ["#1=IFCWALL('a /* b');", "#2=IFCWALL('c');"].join('\n');
        expect(runWorkerScanIds(src)).toEqual([1, 2]);
    });
});
