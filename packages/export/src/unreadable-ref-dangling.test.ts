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
 * The fix makes both output-line filter sites consume `willBeEmitted` itself,
 * so "will this id be in the file?" has exactly one answer by construction.
 * `drift-guard` below is the other half: it asserts the two agree over every
 * id in the store, so an EIGHTH omission reason added to `willBeEmitted`
 * cannot reintroduce the divergence silently.
 */

import { readFileSync } from 'node:fs';
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

  it('holds under visibleOnly and includeGeometry:false as well as a plain export', () => {
    // The same store through the option combinations that switch other
    // omission reasons on. `deltaOnly` is deliberately absent: that mode emits
    // a PATCH against a file that already holds the source lines, so unresolved
    // `#N` in its output is by design, not a dangling ref.
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
 * The structural half of the fix, and the reason an EIGHTH omission reason
 * cannot quietly reintroduce this.
 *
 * The behavioural tests above pin the reasons that have a fixture. They cannot
 * pin a reason nobody has written yet. What can is the wiring itself: as long
 * as every relationship-line filter site consumes `isOmittedFromOutput`, and
 * `isOmittedFromOutput` is nothing but the negation of `willBeEmitted`, a new
 * reason added to `willBeEmitted` reaches the filter for free.
 *
 * #2637 is why this is asserted rather than trusted. That defect took seven
 * review rounds precisely because "will this entity be in the output?" was
 * recomputed per call site, so each round fixed one site and left the next.
 */
describe('drift guard: the relationship filter and the emission share one predicate', () => {
  const exporterSource = readFileSync(new URL('./step-exporter.ts', import.meta.url), 'utf8');
  /**
   * Comments stripped. The prose above explains the retired gate BY NAME, so a
   * bare `not.toContain` over the raw file would match this file's own
   * documentation rather than any live wiring — measured, it did.
   */
  const exporterCode = exporterSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  it('derives isOmittedFromOutput from willBeEmitted, with only the scope qualifier', () => {
    // The qualifier keeps a `#999` the INPUT file already dangled out of the
    // filter's reach — see the predicate's own doc, and the behavioural pin in
    // `step-exporter.test.ts`. Everything else it delegates to `willBeEmitted`,
    // which is what makes an eighth omission reason arrive here for free.
    expect(exporterCode).toContain(
      'const isOmittedFromOutput = (id: number): boolean =>\n'
      + '      (effective.has(id) || effective.isDeleted(id)) && !willBeEmitted(id);',
    );
  });

  it('passes isOmittedFromOutput to every filterHiddenRefsFromRelationshipLine call', () => {
    const calls = [...exporterCode.matchAll(
      /filterHiddenRefsFromRelationshipLine\(\s*([^)]*?)\s*\)/g,
    )].map((m) => m[1]);
    // Two emission passes write a relationship line: source-iteration and the
    // overlay new-entities pass. A third would have to appear here too.
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args.split(',').map((a) => a.trim())[1]).toBe('isOmittedFromOutput');
    }
  });

  it('leaves no second enumeration gating those call sites', () => {
    // `mayNameExcludedRefs` was that gate: a shorter, hand-kept list of the
    // reasons an exclusion might exist, which answered `false` for the
    // unreadable-ref export above and so suppressed the filter entirely.
    expect(exporterCode).not.toContain('mayNameExcludedRefs');
    // Each site is guarded by the class test alone — no extra boolean that
    // could go stale against `willBeEmitted`.
    const guards = [...exporterCode.matchAll(/if \((.*?)\.startsWith\('IFCREL'\)\) \{/g)];
    expect(guards).toHaveLength(2);
    for (const [, subject] of guards) {
      expect(subject).not.toContain('&&');
    }
  });

  it('keeps the closure walk on its own predicate — willBeEmitted there is circular', () => {
    // `willBeEmitted` reads `allowedEntityIds`, which `collectReferencedEntityIds`
    // is what produces. Measured: wiring it in throws `ReferenceError: Cannot
    // access 'willBeEmitted' before initialization`, and hoisting past that
    // would only give a predicate whose answer changes as the set fills.
    expect(exporterCode).toContain('const isRefExcludedDuringClosureWalk =');
    const walkCall = exporterCode.match(/collectReferencedEntityIds\(([\s\S]*?)\);/);
    expect(walkCall).not.toBeNull();
    expect(walkCall![1]).toContain('isRefExcludedDuringClosureWalk');
    expect(walkCall![1]).not.toContain('willBeEmitted');
  });
});
