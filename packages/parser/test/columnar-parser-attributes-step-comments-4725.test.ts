/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for the #4725 review's second blocker: `hasAttrValueAt`
 * treated only six whitespace bytes as trivia, and `skipCommas` did not
 * recognize `/* ... *\/` STEP comments. ISO 10303-21 allows a comment
 * anywhere whitespace is legal in an attribute list, so a comment placed
 * right before the target value, or a comma sitting INSIDE an earlier
 * comment, could both shift which byte `hasAttrValueAt` actually reads.
 *
 * Concretely, before the fix:
 *  - `(...,#165,/* omitted *\/$,...)` — a comment directly before the `$`
 *    at the target slot — made `hasAttrValueAt` read the comment's `/` as
 *    the value byte and report the attribute PRESENT, when it is actually
 *    `$` (absent). This is the review's own example.
 *  - `(...,/* a, b *\/#165,$,...)` — a comma INSIDE an earlier comment —
 *    made `skipCommas` count it as a real delimiter and land one slot
 *    early, again misreading which attribute is at `attrIndex`.
 *
 * This is the same defect CLASS #4720 fixed on the Rust side
 * (`StepListItems` in `rust/core/src/parser/scanner_attributes.rs`): a
 * comment or a comma-inside-a-comment shifting which attribute a scanner
 * lands on. The fix here reuses the canonical byte-level comment scanner
 * already used by the STEP tokenizer (`opensComment`/`skipComment`/
 * `skipTrivia` in `step-lexing.ts`) rather than adding a second, partial
 * comment lexer.
 */

import { describe, it, expect } from 'vitest';
import { hasAttrValueAt } from '../src/columnar-parser-attributes.js';

function toBuf(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

describe('hasAttrValueAt: STEP comments are trivia, not attribute content', () => {
    it('reports absent when a comment sits directly before the $ at the target slot', () => {
        // IfcBuildingElementProxy-shaped: attrIndex 6 (Representation) is $,
        // but a comment sits right before it — the review's own example.
        const src = "#162=IFCBUILDINGELEMENTPROXY('gid',#1,'Name',$,$,#165,/* omitted */$,'tag',$);";
        const buf = toBuf(src);
        expect(hasAttrValueAt(buf, 0, buf.length, 6)).toBe(false);
    });

    it('reports present when the value after a comment is a real reference, not $', () => {
        const src = "#170=IFCBUILDINGELEMENTPROXY('gid',#1,'Name',$,$,#165,/* has geometry */#171,'tag',$);";
        const buf = toBuf(src);
        expect(hasAttrValueAt(buf, 0, buf.length, 6)).toBe(true);
    });

    it('does not count a comma INSIDE an earlier comment as an attribute delimiter', () => {
        // The comment before attrIndex 5 (ObjectPlacement) contains a comma;
        // a naive scan that treats it as a delimiter lands one slot early
        // and misreads attrIndex 6 (Representation, actually $) as whatever
        // byte follows #165 in the source instead.
        const src = "#162=IFCBUILDINGELEMENTPROXY('gid',#1,'Name',$,$,/* a, b */#165,$,'tag',$);";
        const buf = toBuf(src);
        // attrIndex 5 is ObjectPlacement (#165) — present, despite the
        // comma-bearing comment right before it.
        expect(hasAttrValueAt(buf, 0, buf.length, 5)).toBe(true);
        // attrIndex 6 (Representation) is still correctly read as $.
        expect(hasAttrValueAt(buf, 0, buf.length, 6)).toBe(false);
    });

    it('still reads a Representation value correctly when a comment sits between two earlier attributes', () => {
        // A comment between ObjectType (index 4, $) and ObjectPlacement
        // (index 5, #165) — not adjacent to the target slot itself — must
        // not shift attrIndex 6 (Representation, #171) either.
        const src = "#170=IFCBUILDINGELEMENTPROXY('gid',#1,'Name',$,$/* note */,#165,#171,'tag',$);";
        const buf = toBuf(src);
        expect(hasAttrValueAt(buf, 0, buf.length, 6)).toBe(true);
    });
});
