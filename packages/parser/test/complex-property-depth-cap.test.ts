/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser, extractPropertiesOnDemand } from '../src/columnar-parser.js';

/**
 * Issue #3972: `IfcComplexProperty` nesting past `MAX_COMPLEX_PROPERTY_DEPTH`
 * (8) used to stop silently, so a truncated value was indistinguishable from
 * a complete one. Five members on one wall, each probing a different shape:
 *
 * - `C0`: a 9-level chain (`C0`..`C8`) whose deepest node carries a
 *   `UsageName` and one unread `Leaf` sub-property.
 * - `D0`: the same chain with the deepest node's `UsageName` absent (`$`) —
 *   the worse pre-fix shape, where the whole `D8` member vanished and `D7`'s
 *   own `UsageName` was shown in its place.
 * - `Cyc`: a self-referencing complex property; the cap is what makes this
 *   terminate at all, which is why the fix marks the cut rather than removing
 *   the cap.
 * - `E0`: an 8-level control (deepest at depth 7) whose `Leaf` IS read.
 * - `Empty`: an empty `HasProperties` — genuinely empty, not truncated.
 *
 * The expected strings are byte-identical to the Rust assertions in
 * `apps/server/src/services/data_model/tests.rs`
 * (`complex_property_nesting_past_the_depth_cap_says_it_was_truncated`).
 */
const DEPTH_CAP_IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#200=IFCPROPERTYSINGLEVALUE('Leaf',$,IFCLABEL('LeafVal'),$);
#209=IFCCOMPLEXPROPERTY('C8',$,'U8',(#200));
#208=IFCCOMPLEXPROPERTY('C7',$,'U7',(#209));
#207=IFCCOMPLEXPROPERTY('C6',$,'U6',(#208));
#206=IFCCOMPLEXPROPERTY('C5',$,'U5',(#207));
#205=IFCCOMPLEXPROPERTY('C4',$,'U4',(#206));
#204=IFCCOMPLEXPROPERTY('C3',$,'U3',(#205));
#203=IFCCOMPLEXPROPERTY('C2',$,'U2',(#204));
#202=IFCCOMPLEXPROPERTY('C1',$,'U1',(#203));
#201=IFCCOMPLEXPROPERTY('C0',$,'U0',(#202));
#219=IFCCOMPLEXPROPERTY('D8',$,$,(#200));
#218=IFCCOMPLEXPROPERTY('D7',$,'V7',(#219));
#217=IFCCOMPLEXPROPERTY('D6',$,'V6',(#218));
#216=IFCCOMPLEXPROPERTY('D5',$,'V5',(#217));
#215=IFCCOMPLEXPROPERTY('D4',$,'V4',(#216));
#214=IFCCOMPLEXPROPERTY('D3',$,'V3',(#215));
#213=IFCCOMPLEXPROPERTY('D2',$,'V2',(#214));
#212=IFCCOMPLEXPROPERTY('D1',$,'V1',(#213));
#211=IFCCOMPLEXPROPERTY('D0',$,'V0',(#212));
#220=IFCCOMPLEXPROPERTY('Cyc',$,'CycUsage',(#220));
#228=IFCCOMPLEXPROPERTY('E7',$,'W7',(#200));
#227=IFCCOMPLEXPROPERTY('E6',$,'W6',(#228));
#226=IFCCOMPLEXPROPERTY('E5',$,'W5',(#227));
#225=IFCCOMPLEXPROPERTY('E4',$,'W4',(#226));
#224=IFCCOMPLEXPROPERTY('E3',$,'W3',(#225));
#223=IFCCOMPLEXPROPERTY('E2',$,'W2',(#224));
#222=IFCCOMPLEXPROPERTY('E1',$,'W1',(#223));
#221=IFCCOMPLEXPROPERTY('E0',$,'W0',(#222));
#229=IFCCOMPLEXPROPERTY('Empty',$,'EmptyUsage',());
#230=IFCPROPERTYSET('pset-guid',#1,'Pset_Deep',$,(#201,#211,#220,#221,#229));
#231=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#230);`;

async function depthCapValues(): Promise<Map<string, string>> {
  const source = new TextEncoder().encode(DEPTH_CAP_IFC);
  const tokenizer = new StepTokenizer(source);
  const entityRefs: Array<{
    expressId: number;
    type: string;
    byteOffset: number;
    byteLength: number;
    lineNumber: number;
  }> = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  const parser = new ColumnarParser();
  const store = await parser.parseLite(source.buffer.slice(0), entityRefs, {});
  const psets = extractPropertiesOnDemand(store, 10);
  expect(psets).toHaveLength(1);
  return new Map(psets[0].properties.map(p => [p.name, String(p.value)]));
}

describe('IfcComplexProperty depth cap (issue #3972)', () => {
  it('says the value was truncated instead of stopping silently', async () => {
    const values = await depthCapValues();

    // Pre-#3972 this was "C1: C2: C3: C4: C5: C6: C7: C8: U8" — the unread
    // "Leaf: LeafVal" gone with no trace, and "U8" reading as C8's content.
    expect(values.get('C0')).toBe(
      'C1: C2: C3: C4: C5: C6: C7: C8: U8 (truncated: nesting deeper than 8 levels)'
    );

    // Pre-#3972 this was "D1: D2: D3: D4: D5: D6: D7: V7": D8's empty display
    // made the caller skip it entirely, so D7 fell back to its OWN UsageName
    // and the reader saw a genuine value at the wrong nesting level. The
    // marker is non-empty, so D8 now survives as a member.
    expect(values.get('D0')).toBe(
      'D1: D2: D3: D4: D5: D6: D7: D8: (truncated: nesting deeper than 8 levels)'
    );

    // The cap is load-bearing: without it this self-reference never returns.
    // Keeping it and marking the cut is the fix, not raising it.
    expect(values.get('Cyc')).toBe(
      'Cyc: Cyc: Cyc: Cyc: Cyc: Cyc: Cyc: Cyc: CycUsage (truncated: nesting deeper than 8 levels)'
    );
  });

  it('does not mark nesting that stayed within the cap', async () => {
    const values = await depthCapValues();

    // E7 sits at depth 7, one below the cap, so its Leaf IS read. The marker
    // must not fire one level early.
    expect(values.get('E0')).toBe('E1: E2: E3: E4: E5: E6: E7: Leaf: LeafVal');

    // An EMPTY HasProperties is a genuinely empty complex property, not a
    // truncation — it keeps its bare UsageName at any depth.
    expect(values.get('Empty')).toBe('EmptyUsage');
  });
});
