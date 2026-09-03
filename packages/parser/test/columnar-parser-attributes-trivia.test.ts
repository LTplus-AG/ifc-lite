/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Issue #3733 fixed `isSpaceByte` (packages/parser/src/step-lexing.ts) and its
// hand-duplicated twins in tokenizer.ts, scan-worker-source.ts and
// entity-refs-from-index.ts so a form feed (0x0C) or vertical tab (0x0B)
// between STEP tokens is treated as trivia, matching Rust's EntityScanner.
//
// columnar-parser-attributes.ts carries a fourth, independent copy of that
// same byte set (space, tab, LF, CR) in findQuotedAttrRange, readRefId and
// readRefList -- the columnar batch-extraction path used for GlobalId/Name
// lookup and for every relationship ref in columnar-parser-relationships.ts.
// It was not part of the #3733 fix and had the identical gap: a GlobalId,
// Name, or relationship ref preceded by a form feed or vertical tab was
// silently unreadable (findQuotedAttrRange/readRefId return null/-1) even
// though the entity carrying it was already found by the (now-fixed) entity
// scanner.

import { describe, expect, it } from 'vitest';
import { findQuotedAttrRange, readRefId, readRefList } from '../src/columnar-parser-attributes.js';

function toBuf(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

const FF = '\x0c';
const VT = '\x0b';

describe('findQuotedAttrRange: form feed and vertical tab are trivia', () => {
    it('finds a GlobalId preceded by a form feed', () => {
        const src = `#1=IFCWALL(${FF}'1abc23',$,$,$,$,$,$,$);`;
        const buf = toBuf(src);
        const range = findQuotedAttrRange(buf, 0, buf.length, 0);
        expect(range).not.toBeNull();
        const [start, end] = range!;
        expect(new TextDecoder().decode(buf.subarray(start, end))).toBe('1abc23');
    });

    it('finds a Name preceded by a vertical tab, after skipping earlier attrs', () => {
        const src = `#1=IFCWALL('gid',$,${VT}'MyWall',$,$,$,$,$);`;
        const buf = toBuf(src);
        const range = findQuotedAttrRange(buf, 0, buf.length, 2);
        expect(range).not.toBeNull();
        const [start, end] = range!;
        expect(new TextDecoder().decode(buf.subarray(start, end))).toBe('MyWall');
    });

    it('still finds an attribute separated by ordinary whitespace (control)', () => {
        const src = "#1=IFCWALL(  \t\n 'gid',$,$,$,$,$,$,$);";
        const buf = toBuf(src);
        const range = findQuotedAttrRange(buf, 0, buf.length, 0);
        expect(range).not.toBeNull();
    });
});

describe('readRefId: form feed and vertical tab are trivia', () => {
    it('reads a ref preceded by a vertical tab', () => {
        const buf = toBuf(`${VT}#42`);
        const [id] = readRefId(buf, 0, buf.length);
        expect(id).toBe(42);
    });

    it('reads a ref preceded by a form feed', () => {
        const buf = toBuf(`${FF}#42`);
        const [id] = readRefId(buf, 0, buf.length);
        expect(id).toBe(42);
    });

    it('still reads a ref separated by ordinary whitespace (control)', () => {
        const buf = toBuf(' \t\r\n#42');
        const [id] = readRefId(buf, 0, buf.length);
        expect(id).toBe(42);
    });
});

describe('readRefList: form feed and vertical tab are trivia', () => {
    it('reads a parenthesised list preceded by a form feed', () => {
        const buf = toBuf(`${FF}(#1,#2)`);
        const [ids] = readRefList(buf, 0, buf.length);
        expect(ids).toEqual([1, 2]);
    });

    it('reads list members separated by a vertical tab after the comma', () => {
        const buf = toBuf(`(#1,${VT}#2)`);
        const [ids] = readRefList(buf, 0, buf.length);
        expect(ids).toEqual([1, 2]);
    });

    it('reads a bare single ref preceded by a form feed', () => {
        const buf = toBuf(`${FF}#7`);
        const [ids] = readRefList(buf, 0, buf.length);
        expect(ids).toEqual([7]);
    });
});
