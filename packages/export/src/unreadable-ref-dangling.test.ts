/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression guard for the dangling-reference class of #2637 / #2398, reached
 * through the omission reason those fixes did not cover: an UNREADABLE SOURCE
 * REF (#2491).
 *
 * `willBeEmitted` in `step-exporter.ts` recognises seven reasons an entity's
 * line never lands in the file. The relationship-reference filter used to
 * consume a separate predicate that answered for only three of them (hidden
 * product, tombstoned, never existed). A record whose byte range this source
 * cannot address is skipped by the source-iteration pass — so no `#N=` line —
 * while an `IFCREL*` naming it was copied verbatim, on a PLAIN full export
 * with no `visibleOnly` and no deletions anywhere in the call.
 *
 * The fix makes both output-line filter sites consume the negation of
 * `willBeEmitted`. What pins that wiring here is BEHAVIOURAL and nothing else:
 * every test below feeds an input on which the output predicate and the walk
 * predicate give different answers, and checks the bytes. Substituting the
 * walk predicate at either call site, or gutting `willBeEmitted` to
 * `return true`, turns them red.
 *
 * An earlier revision of this file also carried a source-text "drift guard"
 * that `readFileSync`'d `step-exporter.ts` and asserted on its text. It was
 * removed, not merely relocated: with `willBeEmitted`'s body replaced by
 * `return true` — the whole defect, restored — all four of its assertions
 * stayed green while the three behavioural tests below went red. It is also
 * the pattern `scripts/check-source-text-assertions.mjs` exists to stop.
 */

import { describe, expect, it } from 'vitest';
import { asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

type MockEntityRef = {
  expressId: number;
  type: string;
  byteOffset: number;
  byteLength: number;
  lineNumber: number;
};

/** Same shape as `visible-only-dangling-refs.test.ts`'s file-parsed store. */
function buildParsedStore(entries: Array<[number, string, string]>): {
  store: IfcDataStore;
  byId: Map<number, MockEntityRef>;
} {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const byId = new Map<number, MockEntityRef>();
  const byType = new Map<string, number[]>();
  let offset = 0;

  for (const [id, type, text] of entries) {
    const encoded = encoder.encode(text);
    const upper = type.toUpperCase();
    byId.set(id, { expressId: id, type: upper, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 });
    if (!byType.has(upper)) byType.set(upper, []);
    byType.get(upper)!.push(id);
    parts.push(encoded);
    offset += encoded.byteLength;
  }

  const source = new Uint8Array(offset);
  let position = 0;
  for (const part of parts) {
    source.set(part, position);
    position += part.byteLength;
  }

  const store = {
    fileSize: offset,
    schemaVersion: 'IFC4',
    entityCount: entries.length,
    parseTime: 0,
    source: asSourceBytes(source),
    entityIndex: { byId, byType },
  } as unknown as IfcDataStore;

  return { store, byId };
}

/** Every `#N` referenced in the output that has no `#N=` defining line. */
function findDanglingRefs(content: string): number[] {
  const defined = new Set<number>();
  for (const m of content.matchAll(/(^|\n)#(\d+)=/g)) defined.add(+m[2]);
  const dangling = new Set<number>();
  for (const m of content.matchAll(/#(\d+)/g)) {
    const id = +m[1];
    if (!defined.has(id)) dangling.add(id);
  }
  return [...dangling].sort((a, b) => a - b);
}

const WALL_1 = "#1=IFCWALL('0walA0000000000000000',$,'KeptWall',$,$,$,$,$);\n";
const WALL_2 = "#2=IFCWALL('0walB0000000000000000',$,'TruncatedWall',$,$,$,$,$);\n";
const REL_3 = "#3=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cont0000000000000000',$,$,$,(#1,#2),#4);\n";
const STOREY_4 = "#4=IFCBUILDINGSTOREY('0stor0000000000000000',$,'S',$,$,$,$,$,$,0.);\n";

/**
 * A store whose record for `#2` claims a byte range this source cannot serve.
 * The realistic producer is a truncated or partially-attached source buffer —
 * the shape `source-ref-bounds.ts` was written for. Built by parsing normally
 * and then overrunning that one ref, so every OTHER record stays byte-exact.
 */
function buildStoreWithUnreadableRef(): IfcDataStore {
  const { store, byId } = buildParsedStore([
    [1, 'IFCWALL', WALL_1],
    [2, 'IFCWALL', WALL_2],
    [3, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', REL_3],
    [4, 'IFCBUILDINGSTOREY', STOREY_4],
  ]);
  const ref = byId.get(2)!;
  // Runs past the end of the buffer: `createSourceRefReader` rejects it, and
  // `IfcSourceBytes.decodeUtf8` would clamp it to a partial/empty line.
  ref.byteLength = store.source!.byteLength - ref.byteOffset + 64;
  return store;
}

describe('a plain full export never names an entity whose source ref is unreadable', () => {
  it('drops #2 from IfcRelContainedInSpatialStructure.RelatedElements', () => {
    const content = decode(new StepExporter(buildStoreWithUnreadableRef()).export({
      schema: 'IFC4',
    }).content);

    // No `visibleOnly`, no `hiddenEntityIds`, no mutation view, no deletions.
    // The omission is the exporter's own byte-range gate (#2491).
    expect(content).not.toContain('#2=IFCWALL');
    // Measured before the fix: the emitted line was
    // `#3=IFCRELCONTAINEDINSPATIALSTRUCTURE(...,(#1,#2),#4);` — `#2` dangled.
    expect(findDanglingRefs(content)).toEqual([]);
    // Rewritten, not withheld: the readable sibling stays contained.
    const rel = content.match(/^#3=IFCRELCONTAINEDINSPATIALSTRUCTURE\((.*)\);$/m);
    expect(rel).not.toBeNull();
    expect(rel![1]).toContain('(#1)');
    expect(rel![1]).not.toContain('#2');
  });

  it('withholds a relationship whose only scalar target is unreadable', () => {
    const { store, byId } = buildParsedStore([
      [3, 'IFCWALL', "#3=IFCWALL('0walA0000000000000000',$,'VisibleWall',$,$,$,$,$);\n"],
      [5, 'IFCOPENINGELEMENT', "#5=IFCOPENINGELEMENT('0open0000000000000000',$,'Opening',$,$,$,$,$);\n"],
      [20, 'IFCRELVOIDSELEMENT', "#20=IFCRELVOIDSELEMENT('0void0000000000000000',$,$,$,#3,#5);\n"],
    ]);
    const ref = byId.get(5)!;
    ref.byteLength = store.source!.byteLength - ref.byteOffset + 64;

    const content = decode(new StepExporter(store).export({ schema: 'IFC4' }).content);

    expect(content).not.toContain('#5=IFCOPENINGELEMENT');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  it('stays fixed when visibleOnly or includeGeometry:false is also set', () => {
    // The SAME unreadable-ref store (reason 5) under three option sets, so the
    // fix is not accidentally contingent on the other options being off. It is
    // NOT coverage of the closure or geometry omission reasons: no entity in
    // this store is hidden, and none is geometry-classified, so `visibleOnly`
    // and `includeGeometry:false` change nothing about which ids are omitted
    // here. See the file-level note on what those two reasons are and are not
    // covered by.
    //
    // `deltaOnly` is deliberately absent: that mode emits a PATCH against a
    // file that already holds the source lines, so unresolved `#N` in its
    // output is by design, not a dangling ref.
    for (const options of [
      { schema: 'IFC4' as const },
      { schema: 'IFC4' as const, visibleOnly: true, hiddenEntityIds: new Set<number>() },
      { schema: 'IFC4' as const, includeGeometry: false },
    ]) {
      const content = decode(new StepExporter(buildStoreWithUnreadableRef()).export(options).content);
      expect(findDanglingRefs(content), `options: ${JSON.stringify(options)}`).toEqual([]);
    }
  });
});

/**
 * A store where one relationship's SOLE pset subject has an unreadable source
 * ref. Reused by both describes below: it is the smallest input on which the
 * closure walk's predicate and the output filter's predicate give different
 * answers about `#2`.
 */
function buildStoreWithWithheldPsetRelationship(): IfcDataStore {
  // `#2` is deliberately the LAST record in the buffer. An overrunning ref is
  // clamped, not rejected, by the closure walk's byte scan
  // (`extractRefsFromBytes` over `src.slice(offset, offset + length)`), so a
  // `#2` placed EARLIER would have its overrun scan read `#10` and `#20`'s
  // bytes as if they were its own and pull `#10` into the closure that way —
  // measured, and it would have made the test below pass for the wrong reason.
  // Last in the buffer, the overrun reaches only past the end, which yields
  // nothing, and the only route to `#10` is the `#20` bridge this pins.
  const { store, byId } = buildParsedStore([
    [1, 'IFCWALL', "#1=IFCWALL('0walA0000000000000000',$,'VisibleWall',$,$,$,$,$);\n"],
    [10, 'IFCPROPERTYSET', "#10=IFCPROPERTYSET('0pset0000000000000000',$,'Pset_Custom',$,());\n"],
    [20, 'IFCRELDEFINESBYPROPERTIES', "#20=IFCRELDEFINESBYPROPERTIES('0def00000000000000000',$,$,$,(#2),#10);\n"],
    [2, 'IFCOPENINGELEMENT', "#2=IFCOPENINGELEMENT('0open0000000000000000',$,'Opening',$,$,$,$,$);\n"],
  ]);
  const ref = byId.get(2)!;
  ref.byteLength = store.source!.byteLength - ref.byteOffset + 64;
  return store;
}

/**
 * Withholding a relationship is the right trade against shipping a dangling
 * `#N`, but it is a real edit to the model — and one that reaches a PLAIN full
 * export, with `visibleOnly`, `includeGeometry` and the overlay all untouched.
 * Before this warning existed the caller had no way to learn of it short of
 * diffing the output, which is the "silent" half the adversarial review of
 * #2668 objected to.
 */
describe('a withheld relationship is reported in stats.warnings', () => {
  it('warns on a plain full export, naming the relationship it dropped', () => {
    const result = new StepExporter(buildStoreWithWithheldPsetRelationship())
      .export({ schema: 'IFC4' });
    const content = decode(result.content);

    // The relationship is gone, not rewritten: `RelatedObjects` named only
    // `#2`, and an empty SET is a different statement from the original.
    expect(content).not.toContain('#20=IFCRELDEFINESBYPROPERTIES');
    expect(findDanglingRefs(content)).toEqual([]);

    expect(result.stats.warnings).toHaveLength(1);
    expect(result.stats.warnings[0]).toContain('#20');
    expect(result.stats.warnings[0]).toContain('IFCRELDEFINESBYPROPERTIES');
    expect(result.stats.warnings[0]).toContain('withheld');
  });

  it('stays silent when the relationship is rewritten rather than withheld', () => {
    // `#3`'s `RelatedElements` keeps `#1`, so the line still ships — a rewrite
    // is not a lost association and must not raise the warning. Without this
    // the warning could be pushed unconditionally and the test above would
    // still pass.
    const result = new StepExporter(buildStoreWithUnreadableRef()).export({ schema: 'IFC4' });
    expect(decode(result.content)).toContain('#3=IFCRELCONTAINEDINSPATIALSTRUCTURE');
    expect(result.stats.warnings).toEqual([]);
  });
});

/**
 * The observable consequence of the walk and the output using DIFFERENT
 * predicates, pinned so it is recorded rather than rediscovered.
 *
 * `reference-collector.ts` documents the contract that the closure bridge uses
 * the caller's own OUTPUT predicate — the remedy #2637 was closed on. This
 * change cannot honour that literally: `willBeEmitted` reads `allowedEntityIds`,
 * which is what the walk is producing, so wiring it into the walk is circular
 * (measured: `ReferenceError: Cannot access 'willBeEmitted' before
 * initialization`). The walk therefore keeps the narrower
 * `isRefExcludedDuringClosureWalk`, and for an unreadable source ref the two
 * now disagree.
 *
 * The consequence is below. The walk asks "is `#2` hidden or deleted?", answers
 * no, and lets `#20` BRIDGE — pulling `#10` into the closure. The output filter
 * asks "will `#2` have a line?", answers no, and WITHHOLDS `#20`. `#10` is
 * emitted with nothing naming it: an orphan pset. Not a dangling ref and not an
 * invalid file, but not what either predicate intended on its own, and the open
 * design question on #2668.
 */
describe('walk and output predicates diverge: a bridged pset can be orphaned', () => {
  it('emits #10 that only the withheld #20 named', () => {
    const result = new StepExporter(buildStoreWithWithheldPsetRelationship())
      .export({ schema: 'IFC4', visibleOnly: true, hiddenEntityIds: new Set<number>() });
    const content = decode(result.content);

    // The bridge fired: `#10` is in the closure only because `#20` named it.
    expect(content).toContain('#10=IFCPROPERTYSET');
    // The output filter withheld the very line that bridged it.
    expect(content).not.toContain('#20=IFCRELDEFINESBYPROPERTIES');
    // So nothing left in the file references `#10`.
    expect(content.match(/#10\b/g)).toEqual(['#10']);
    // Orphaned, not dangling — the file is still valid STEP.
    expect(findDanglingRefs(content)).toEqual([]);
  });
});
