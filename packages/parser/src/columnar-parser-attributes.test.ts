/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `batchExtractGlobalIdAndName`'s fast path (`findQuotedAttrRange`) has no
 * `/* … *​/` comment-trivia skip — a comment sitting before an entity's
 * GlobalId or Name makes the byte scan miss the quoted string entirely.
 * Before #4930 that silently read back as `''` (the same answer a genuinely
 * empty string gives); after #4930's absent/empty distinction, a byte-scan
 * miss means `undefined` (absent) — a real regression for this one case,
 * caught in review. The fix re-parses just the (rare) comment-suspect
 * records with the real tokenizer (`EntityExtractor`, which already treats
 * a comment as trivia) instead of trusting the fast path's false miss.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from './index.js';

const COMMENT_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#60= IFCWALL('0WallComment0000000001',$,/* rev; see ticket */'Wall-Commented',$,$,#40,$,'tag',$);
#61= IFCWALL('0WallNoComment000000A1',$,'Wall-Plain',$,$,#40,$,'tag',$);
ENDSEC;
END-ISO-10303-21;
`;

describe('batchExtractGlobalIdAndName — comment before Name (#4930 review)', () => {
  it('recovers the real Name instead of reporting it absent', async () => {
    const bytes = new TextEncoder().encode(COMMENT_IFC);
    const store = await new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    const WALL_COMMENTED = 60;
    const WALL_PLAIN = 61;

    expect(store.entities.getName(WALL_COMMENTED)).toBe('Wall-Commented');
    expect(store.entities.getNameOrUndefined(WALL_COMMENTED)).toBe('Wall-Commented');
    expect(store.entities.getName(WALL_PLAIN)).toBe('Wall-Plain');
  });
});
