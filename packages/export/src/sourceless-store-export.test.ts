/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `StepExporter` against a store whose `source` carries NO BYTES.
 *
 * `IfcDataStore.source` is a mandatory accessor; "this model kept no bytes" is
 * spelled `EMPTY_SOURCE_BYTES`, which is a real and supported state — server
 * parsed stores (`apps/viewer/src/utils/serverDataModel.ts`), synthetic stores,
 * GLB and point-cloud models all have one. Nothing in this package's suite
 * built such a store, so every `if (!store.source)` guard in `step-exporter.ts`
 * was untested dead code, and the shape of the "obvious" repair differs from
 * site to site. These cases pin both directions.
 */

import { describe, expect, it } from 'vitest';
import { EMPTY_SOURCE_BYTES, asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView as LiveMutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

type MockEntityRef = {
  expressId: number;
  type: string;
  byteOffset: number;
  byteLength: number;
  lineNumber: number;
};

/** A normal file-parsed store: real bytes, real byte ranges. */
function buildParsedStore(entries: Array<[number, string, string]>): IfcDataStore {
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

  return {
    fileSize: offset,
    schemaVersion: 'IFC4',
    entityCount: entries.length,
    parseTime: 0,
    source: asSourceBytes(source),
    entityIndex: { byId, byType },
  } as unknown as IfcDataStore;
}

/**
 * The server-parsed shape, verbatim: a fully populated `byId` whose every ref
 * carries `byteOffset: 0, byteLength: 0`, over `EMPTY_SOURCE_BYTES`
 * (`serverDataModel.ts` — "The server has no source buffer, so byteOffset /
 * byteLength are 0").
 */
function buildSourcelessStore(entries: Array<[number, string]>): IfcDataStore {
  const byId = new Map<number, MockEntityRef>();
  const byType = new Map<string, number[]>();
  for (const [id, type] of entries) {
    const upper = type.toUpperCase();
    byId.set(id, { expressId: id, type: upper, byteOffset: 0, byteLength: 0, lineNumber: 0 });
    if (!byType.has(upper)) byType.set(upper, []);
    byType.get(upper)!.push(id);
  }
  return {
    fileSize: 0,
    schemaVersion: 'IFC4',
    entityCount: entries.length,
    parseTime: 0,
    source: EMPTY_SOURCE_BYTES,
    entityIndex: { byId, byType },
  } as unknown as IfcDataStore;
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

const WALL_LINE = "#1=IFCWALL('1ys5Xwuxz8gPJk6N$NGhAG',$,'Wall',$,$,$,$,$);";
const PSET_LINE = "#10=IFCPROPERTYSET('2ys5Xwuxz8gPJk6N$NGhAG',$,'Pset_WallCommon',$,(#11));";
const ATOM_LINE = "#11=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.F.),$);";
const REL_LINE = "#12=IFCRELDEFINESBYPROPERTIES('3ys5Xwuxz8gPJk6N$NGhAG',$,$,$,(#1),#10);";

function parsedStoreWithPset(): IfcDataStore {
  return buildParsedStore([
    [1, 'IFCWALL', WALL_LINE],
    [10, 'IFCPROPERTYSET', PSET_LINE],
    [11, 'IFCPROPERTYSINGLEVALUE', ATOM_LINE],
    [12, 'IFCRELDEFINESBYPROPERTIES', REL_LINE],
  ]);
}

describe('StepExporter over a store with no source bytes', () => {
  /**
   * THE TRAP, pinned. `export` used to gate the visible-only closure on
   * `options.visibleOnly && this.dataStore.source` — always true, because
   * `source` is mandatory. Repairing that conjunct into a byte test
   * (`source.byteLength > 0`) is NOT a no-op: it leaves `allowedEntityIds`
   * null for an overlay-only model, which means NO filtering at all and every
   * hidden entity in the file. Measured on the unrepaired-into-a-byte-test
   * build, this export contained `#102=IFCWALL` — the wall the caller hid.
   *
   * The closure is correct without source bytes because `reference-collector`
   * serves an overlay-authored entity's refs from its creation payload and
   * scopes its own byte scan (#2339).
   */
  it('visible-only still filters hidden entities on an overlay-only model', () => {
    const store = buildSourcelessStore([]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(100);
    const visible = view.createEntity('IFCWALL', ["'guidA'", null, "'WallA'"]);
    const hidden = view.createEntity('IFCWALL', ["'guidB'", null, "'WallB'"]);

    const content = decode(
      new StepExporter(store, view).export({
        schema: 'IFC4',
        applyMutations: true,
        visibleOnly: true,
        hiddenEntityIds: new Set([hidden.expressId]),
      }).content,
    );

    expect(content).toContain(`#${visible.expressId}=IFCWALL`);
    expect(content).not.toContain(`#${hidden.expressId}=IFCWALL`);
  });

  /** Bounding control: the same filtering on the common, file-parsed path. */
  it('visible-only still filters hidden entities on a file-parsed store', () => {
    const store = buildParsedStore([
      [1, 'IFCWALL', WALL_LINE],
      [2, 'IFCWALL', "#2=IFCWALL('4ys5Xwuxz8gPJk6N$NGhAG',$,'Wall2',$,$,$,$,$);"],
    ]);

    const content = decode(
      new StepExporter(store).export({
        schema: 'IFC4',
        visibleOnly: true,
        hiddenEntityIds: new Set([2]),
      }).content,
    );

    expect(content).toContain('#1=IFCWALL');
    expect(content).not.toContain('#2=IFCWALL');
  });

  /**
   * Bounding control for the six byte readers (`getRelatedEntities`,
   * `getRelatedPropertySet`, `getPropertySetName`, `getElementQuantityName`,
   * `getPropertyIdsInSet`, `replaceEntityAttribute`), which now share
   * `entityLineText` and its byte-range check.
   *
   * Editing `Pset_WallCommon` must replace the original: exactly one
   * `IFCPROPERTYSET` line named `Pset_WallCommon` in the output, and neither
   * the original container `#10` nor its atom `#11` left behind. If the range
   * check ever answered "no bytes" for a real source record, the readers would
   * stop recognising `#10` as the pset being replaced and BOTH definitions
   * would ship.
   */
  it('a pset edit on a file-parsed store replaces the original exactly once', () => {
    const store = parsedStoreWithPset();
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setProperty(1, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);

    const content = decode(
      new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content,
    );

    expect(content.match(/IFCPROPERTYSET\([^;]*'Pset_WallCommon'/g)).toHaveLength(1);
    expect(content).not.toContain('#10=IFCPROPERTYSET');
    expect(content).not.toContain('#11=IFCPROPERTYSINGLEVALUE');
    expect(content).not.toContain('#12=IFCRELDEFINESBYPROPERTIES');
    expect(content).toContain('.T.');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  /**
   * The same edit against the server-parsed shape. Every source record has an
   * empty byte range, so none of them can be written out — and the readers
   * must therefore report nothing rather than a name parsed from whatever the
   * range happens to clamp to. The file is header-only and, critically,
   * carries no second copy of the pset and no dangling reference.
   */
  it('a pset edit on a sourceless store emits no stale pset and no dangling ref', () => {
    const store = buildSourcelessStore([
      [1, 'IFCWALL'],
      [10, 'IFCPROPERTYSET'],
      [11, 'IFCPROPERTYSINGLEVALUE'],
      [12, 'IFCRELDEFINESBYPROPERTIES'],
    ]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setProperty(1, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);

    const content = decode(
      new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content,
    );

    expect(content).not.toContain('IFCPROPERTYSET');
    expect(content).not.toContain('IFCRELDEFINESBYPROPERTIES');
    expect(content).not.toContain('#1=IFCWALL');
    expect(findDanglingRefs(content)).toEqual([]);
  });

  /**
   * The overlay-visible -> overlay-hidden REFERENCE closure. #2398 pinned
   * that the closure must not be skipped on an overlay-only model; this pins
   * what the closure does once it runs: a visible entity's own attributes can
   * point straight at a hidden PRODUCT (not just at its exclusively-owned
   * geometry), and `hiddenProductIds` is passed as `excludeIds` into
   * `collectReferencedEntityIds` (step-exporter.ts) specifically so that
   * reference is not followed. A hidden product must not leak into the
   * export just because something visible happens to point at it — e.g. a
   * `IfcRelConnectsElements` naming a hidden neighbour, or a stray positional
   * ref. Meanwhile a plain, non-product entity the visible wall legitimately
   * needs (its placement) is still pulled in by the same walk.
   */
  it('the visible-only closure excludes a hidden product referenced by a visible one, but keeps what the visible one needs', () => {
    const store = buildSourcelessStore([]);
    const view = new LiveMutablePropertyView(null, 'm1');
    view.setExpressIdWatermark(100);

    // A plain, non-product entity: always includable once referenced.
    const placement = view.createEntity('IFCCARTESIANPOINT', ['0.', '0.', '0.']);
    // A hidden PRODUCT.
    const hidden = view.createEntity('IFCWALL', ["'guidB'", null, "'WallB'"]);
    // A visible PRODUCT that references BOTH: the placement it legitimately
    // needs, and the hidden wall it happens to point at.
    const visible = view.createEntity('IFCWALL', [
      "'guidA'",
      null,
      "'WallA'",
      null,
      `#${placement.expressId}`,
      `#${hidden.expressId}`,
    ]);

    const content = decode(
      new StepExporter(store, view).export({
        schema: 'IFC4',
        applyMutations: true,
        visibleOnly: true,
        hiddenEntityIds: new Set([hidden.expressId]),
      }).content,
    );

    expect(content).toContain(`#${visible.expressId}=IFCWALL`);
    expect(content).toContain(`#${placement.expressId}=IFCCARTESIANPOINT`);
    expect(content).not.toContain(`#${hidden.expressId}=IFCWALL`);
  });

  /**
   * Bounding control for the trap in the opposite direction: an
   * overlay-created entity legitimately has `byteLength === 0`, so a byte
   * check placed on the entity rather than on the byte scan would drop it.
   * It is still emitted, over a file-parsed store and over a sourceless one.
   */
  it('an overlay-created entity is still emitted, with or without source bytes', () => {
    for (const store of [parsedStoreWithPset(), buildSourcelessStore([[1, 'IFCWALL']])]) {
      const view = new LiveMutablePropertyView(null, 'm1');
      view.setExpressIdWatermark(100);
      const created = view.createEntity('IFCWALL', ["'guidC'", null, "'Created'"]);

      const content = decode(
        new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content,
      );

      expect(content).toContain(`#${created.expressId}=IFCWALL`);
    }
  });
});
