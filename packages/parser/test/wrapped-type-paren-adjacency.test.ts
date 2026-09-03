/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for #3789 — the TS siblings of #3205's Rust fix.
 *
 * #3205 fixed the Rust tokenizer so a typed value wrapped across whitespace
 * between its type name and `(` still parses. The same adjacency assumption
 * survived in two TS regexes:
 *  1. EntityExtractor.extractEntity's entity regex allowed whitespace around
 *     `=` but not before the args `(`, so `#5=IFCSURFACESTYLERENDERING\r\n(#4,0.);`
 *     returned null — the entity vanished from every extractor keyed on it.
 *  2. EntityExtractor.parseAttributeValue's typed-value regex couldn't cross
 *     whitespace, so `IFCPOSITIVELENGTHMEASURE\r\n(1.)` fell through to the
 *     plain-string branch instead of being read as a typed value.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { EntityExtractor } from '../src/entity-extractor.js';
import type { EntityRef } from '../src/types.js';

function scan(ifc: string): { source: Uint8Array; entityRefs: EntityRef[] } {
    const source = new TextEncoder().encode(ifc);
    const tokenizer = new StepTokenizer(source);
    const entityRefs: EntityRef[] = [];
    for (const ref of tokenizer.scanEntitiesFast()) {
        entityRefs.push({
            expressId: ref.expressId,
            type: ref.type,
            byteOffset: ref.offset,
            byteLength: ref.length,
            lineNumber: ref.line,
        });
    }
    return { source, entityRefs };
}

describe('extractEntity: entity type name wrapped from its args paren (#3789)', () => {
    it('parses an entity whose type name is separated from "(" by a CRLF line wrap', () => {
        const ifc = `#5=IFCSURFACESTYLERENDERING\r\n(#4,0.);`;
        const { source, entityRefs } = scan(ifc);
        const ref = entityRefs.find(r => r.expressId === 5);
        expect(ref).toBeDefined();

        const entity = new EntityExtractor(source).extractEntity(ref!);
        expect(entity).not.toBeNull();
        expect(entity!.type.toUpperCase()).toBe('IFCSURFACESTYLERENDERING');
        expect(entity!.attributes.length).toBe(2);
    });

    it('still parses an entity whose type name is adjacent to "(" (no regression)', () => {
        const ifc = `#5=IFCSURFACESTYLERENDERING(#4,0.);`;
        const { source, entityRefs } = scan(ifc);
        const ref = entityRefs.find(r => r.expressId === 5);
        expect(ref).toBeDefined();

        const entity = new EntityExtractor(source).extractEntity(ref!);
        expect(entity).not.toBeNull();
        expect(entity!.type.toUpperCase()).toBe('IFCSURFACESTYLERENDERING');
    });

    it('rejects a malformed record with no "=" between id and type (two-way rule)', () => {
        const ifc = `#5 IFCWALL(#4,0.);`;
        const { source, entityRefs } = scan(ifc);
        // The scanner itself should not even find a valid #id= boundary here,
        // so there is nothing to extract.
        expect(entityRefs.find(r => r.expressId === 5)).toBeUndefined();
    });
});

describe('parseAttributeValue (via extractEntity): typed value wrapped across whitespace (#3789)', () => {
    it('reads a typed-value attribute whose "(" is on the next line as a TypedValue, not a raw string', () => {
        const ifc = `#42=IFCSURFACESTYLERENDERING($,IFCPOSITIVELENGTHMEASURE\r\n(1.),$,$,$,$,$,$,.NOTDEFINED.);`;
        const { source, entityRefs } = scan(ifc);
        const ref = entityRefs.find(r => r.expressId === 42);
        expect(ref).toBeDefined();

        const entity = new EntityExtractor(source).extractEntity(ref!);
        expect(entity).not.toBeNull();
        const attr = entity!.attributes[1];
        // Mirrors the Rust Token::TypedValue shape: [typeName, parsedValue].
        expect(Array.isArray(attr)).toBe(true);
        expect((attr as [string, unknown])[0]).toBe('IFCPOSITIVELENGTHMEASURE');
        expect((attr as [string, unknown])[1]).toBe(1);
    });

    it('still reads an adjacent typed value correctly (no regression)', () => {
        const ifc = `#42=IFCSURFACESTYLERENDERING($,IFCPOSITIVELENGTHMEASURE(1.),$,$,$,$,$,$,.NOTDEFINED.);`;
        const { source, entityRefs } = scan(ifc);
        const ref = entityRefs.find(r => r.expressId === 42);
        const entity = new EntityExtractor(source).extractEntity(ref!);
        const attr = entity!.attributes[1];
        expect(Array.isArray(attr)).toBe(true);
        expect((attr as [string, unknown])[0]).toBe('IFCPOSITIVELENGTHMEASURE');
    });

    it('does not mistake a plain quoted string starting with a type-like prefix for a typed value (two-way rule)', () => {
        // A quoted string is never re-interpreted as a typed value even though
        // parseAttributeValue's typed-value regex would otherwise match text
        // that looks like "IDENTIFIER(...)" inside it — the value here isn't
        // unquoted at all, so it must stay a plain string attribute.
        const ifc = `#7=IFCLABEL('IFCLABEL(not a typed value)');`;
        const { source, entityRefs } = scan(ifc);
        const ref = entityRefs.find(r => r.expressId === 7);
        const entity = new EntityExtractor(source).extractEntity(ref!);
        expect(entity!.attributes[0]).toBe('IFCLABEL(not a typed value)');
    });

    it('only tolerates whitespace, not arbitrary text, between the type name and "(" (two-way rule)', () => {
        // `\s*` was chosen deliberately over `.*` — non-whitespace junk
        // between the type name and its paren must NOT be swallowed as if
        // it were the line-wrap this fix targets.
        const ifc = `#8=IFCWALL(IFCLABEL#5(3));`;
        const { source, entityRefs } = scan(ifc);
        const ref = entityRefs.find(r => r.expressId === 8);
        const entity = new EntityExtractor(source).extractEntity(ref!);
        const attr = entity!.attributes[0];
        expect(Array.isArray(attr)).toBe(false);
    });
});
