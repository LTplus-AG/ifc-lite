/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The batch GlobalId+Name extractor slices the raw quoted bytes and decodes
 * them. STEP escapes a literal apostrophe by doubling it (''), and the raw
 * slice preserves that doubling, so the batch path must collapse '' -> ' just
 * as EntityExtractor does — otherwise a name like `John''s Wall` renders with
 * the literal doubled quote.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { batchExtractGlobalIdAndName } from '../src/columnar-parser-attributes.js';
import type { EntityRef } from '../src/types.js';

function scan(ifc: string): { buffer: Uint8Array; refs: EntityRef[] } {
    const buffer = new TextEncoder().encode(ifc);
    const tokenizer = new StepTokenizer(buffer);
    const refs: EntityRef[] = [];
    for (const r of tokenizer.scanEntitiesFast()) {
        refs.push({
            expressId: r.expressId,
            type: r.type,
            byteOffset: r.offset,
            byteLength: r.length,
            lineNumber: r.line,
        });
    }
    return { buffer, refs };
}

describe('batchExtractGlobalIdAndName — STEP quote un-doubling', () => {
    it("collapses doubled single-quotes in the Name (John''s Wall -> John's Wall)", async () => {
        const { buffer, refs } = scan(
            "#1=IFCWALL('0GlobalId00000000000001',$,'John''s Wall',$,$,$,$,$,$);\n",
        );
        const result = await batchExtractGlobalIdAndName(buffer, refs);
        expect(result.get(1)?.name).toBe("John's Wall");
        expect(result.get(1)?.globalId).toBe('0GlobalId00000000000001');
    });

    it('still decodes \\X2\\ escapes and leaves un-doubled names intact', async () => {
        const { buffer, refs } = scan(
            "#1=IFCWALL('0GlobalId00000000000002',$,'Br\\X2\\00FC\\X0\\cke',$,$,$,$,$,$);\n",
        );
        const result = await batchExtractGlobalIdAndName(buffer, refs);
        expect(result.get(1)?.name).toBe('Brücke');
    });

    it('handles doubled quotes at the start and end of a name', async () => {
        const { buffer, refs } = scan(
            "#1=IFCWALL('0GlobalId00000000000003',$,'''s Wall',$,$,$,$,$,$);\n" +
            "#2=IFCWALL('0GlobalId00000000000004',$,'Wall''',$,$,$,$,$,$);\n",
        );
        const result = await batchExtractGlobalIdAndName(buffer, refs);
        expect(result.get(1)?.name).toBe("'s Wall");
        expect(result.get(2)?.name).toBe("Wall'");
    });

    it("handles a name that is a single apostrophe ('''' in STEP)", async () => {
        const { buffer, refs } = scan(
            "#1=IFCWALL('0GlobalId00000000000005',$,'''',$,$,$,$,$,$);\n",
        );
        const result = await batchExtractGlobalIdAndName(buffer, refs);
        expect(result.get(1)?.name).toBe("'");
    });

    it('does not let a quoted attribute confuse later attribute scanning', async () => {
        // The GlobalId contains characters that look like structure; the Name
        // after it must still resolve to attr index 2.
        const { buffer, refs } = scan(
            "#1=IFCWALL('0(,)''X00000000000006',$,'Plain',$,$,$,$,$,$);\n",
        );
        const result = await batchExtractGlobalIdAndName(buffer, refs);
        expect(result.get(1)?.globalId).toBe("0(,)''X00000000000006");
        expect(result.get(1)?.name).toBe('Plain');
    });
});
