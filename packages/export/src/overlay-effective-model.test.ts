/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression cover for github.com/LTplus-AG/ifc-lite/issues/2012.
 *
 * `StepExporter` used to ask `this.dataStore` questions the mutation overlay is
 * the authority on. The buffer answers for the file as parsed; the overlay knows
 * what the session created, edited, retyped and deleted. Each pass that reached
 * for the buffer produced a saved file that disagreed with what the user did:
 *
 *   - `visibleOnly: true` computed its reference closure from the source index
 *     alone, so an overlay-CREATED entity was never a root and never emitted.
 *   - `isTypeEntity()` read `entityIndex.byId`, so a pset added to an
 *     overlay-created `IfcWallType` was emitted as an occurrence
 *     `IFCRELDEFINESBYPROPERTIES` instead of into the type's `HasPropertySets`.
 *   - a tombstoned entity's queued pset edits still emitted their
 *     `IFCRELDEFINESBYPROPERTIES`, dangling at the entity that was skipped.
 *   - `deleteEntity` FORGOT an overlay-created entity rather than tombstoning
 *     it, so `isDeleted()` answered false and no guard downstream could fire.
 *
 * Every assertion here re-PARSES the exported STEP. Asserting on the emitted
 * string only proves the exporter wrote what it meant to; re-parsing is what
 * proves the file means it.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IfcParser, EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { StepExporter } from './step-exporter.js';
import { collectRefsInByteRange } from './reference-collector.js';

/** 22-character STEP GlobalId built from a readable tag. */
function guid(tag: string): string {
  return (tag + '0'.repeat(22)).slice(0, 22);
}

const STOREY_ID = 7;
const EXISTING_WALL_ID = 8;
const EXISTING_PSET_ID = 11;
const EXISTING_REL_ID = 12;
const EXISTING_TYPE_ID = 13;
/** A wall no spatial-containment relation names, so the only source record
 *  pointing at it is its own IfcRelDefinesByProperties. */
const LONE_WALL_ID = 14;
const LONE_REL_ID = 15;

const BASE_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('base.ifc','2026-08-02T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid('proj')}',$,'My Project',$,$,$,$,$,$);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCSITE('${guid('site')}',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#6=IFCBUILDING('${guid('bldg')}',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#${STOREY_ID}=IFCBUILDINGSTOREY('${guid('storey')}',$,'Level 0',$,$,$,$,$,.ELEMENT.,0.);
#${EXISTING_WALL_ID}=IFCWALL('${guid('wall')}',$,'Existing Wall',$,$,$,$,$,$);
#9=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('relcont')}',$,$,$,(#${EXISTING_WALL_ID}),#${STOREY_ID});
#10=IFCPROPERTYSINGLEVALUE('Width',$,IFCLENGTHMEASURE(200.),$);
#${EXISTING_PSET_ID}=IFCPROPERTYSET('${guid('pset')}',$,'Pset_WallCommon',$,(#10));
#${EXISTING_REL_ID}=IFCRELDEFINESBYPROPERTIES('${guid('reldef')}',$,$,$,(#${EXISTING_WALL_ID}),#${EXISTING_PSET_ID});
#${EXISTING_TYPE_ID}=IFCWALLTYPE('${guid('wtype')}',$,'WT1',$,$,$,$,$,$,.STANDARD.);
#${LONE_WALL_ID}=IFCWALL('${guid('lone')}',$,'Lone Wall',$,$,$,$,$,$);
#${LONE_REL_ID}=IFCRELDEFINESBYPROPERTIES('${guid('lonerel')}',$,$,$,(#${LONE_WALL_ID}),#${EXISTING_PSET_ID});
ENDSEC;
END-ISO-10303-21;`;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function parseBase(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(toArrayBuffer(new TextEncoder().encode(BASE_IFC)));
}

function newView(store: IfcDataStore): { view: MutablePropertyView; editor: StoreEditor } {
  const view = new MutablePropertyView(null, 'test-model');
  return { view, editor: new StoreEditor(store, view) };
}

/** The re-parsed export, as the shapes every assertion below reads it through. */
interface Reparsed {
  store: IfcDataStore;
  /** Positional attributes of one entity, or null when it is absent. */
  attributes(expressId: number): unknown[] | null;
  typeOf(expressId: number): string | null;
  /** Every `#id` referenced by any record but absent from the file. */
  danglingRefs(): number[];
  /** ids of the `IFCRELDEFINESBYPROPERTIES` records whose RelatedObjects list
   *  names `expressId`. */
  relDefinesTargeting(expressId: number): number[];
}

async function reparse(content: Uint8Array): Promise<Reparsed> {
  const store = await new IfcParser().parseColumnar(toArrayBuffer(content));
  const source = store.source!;
  const extractor = new EntityExtractor(source);
  return {
    store,
    attributes(expressId) {
      const ref = store.entityIndex.byId.get(expressId);
      if (!ref) return null;
      return extractor.extractEntity(ref)?.attributes ?? null;
    },
    typeOf(expressId) {
      return store.entityIndex.byId.get(expressId)?.type ?? null;
    },
    danglingRefs() {
      const missing = new Set<number>();
      for (const [, ref] of store.entityIndex.byId) {
        for (const id of collectRefsInByteRange(source, ref.byteOffset, ref.byteLength)) {
          if (!store.entityIndex.byId.has(id)) missing.add(id);
        }
      }
      return [...missing].sort((a, b) => a - b);
    },
    relDefinesTargeting(expressId) {
      const hits: number[] = [];
      for (const relId of store.entityIndex.byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
        const ref = store.entityIndex.byId.get(relId);
        if (!ref) continue;
        const related = extractor.extractEntity(ref)?.attributes?.[4];
        if (Array.isArray(related) && related.includes(expressId)) hits.push(relId);
      }
      return hits;
    },
  };
}

// ---------------------------------------------------------------------------
// Instance 4 — `visibleOnly: true` dropped every overlay-created entity
// ---------------------------------------------------------------------------

describe('visibleOnly export sees overlay-created entities (#2012 instance 4)', () => {
  it('emits a created wall, its placement chain and its containment relation', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    const point = editor.addEntity('IfcCartesianPoint', [[{ real: 1 }, { real: 2 }, { real: 3 }]]);
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point.expressId}`, null, null]);
    const placement = editor.addEntity('IfcLocalPlacement', [null, `#${axis.expressId}`]);
    const wall = editor.addEntity('IfcWall', [
      guid('newwall'), null, 'Created Wall', null, null,
      `#${placement.expressId}`, null, null, null,
    ]);
    const rel = editor.addEntity('IfcRelContainedInSpatialStructure', [
      guid('newrel'), null, null, null, [`#${wall.expressId}`], `#${STOREY_ID}`,
    ]);

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const out = await reparse(result.content);

    expect(out.typeOf(wall.expressId)).toBe('IFCWALL');
    expect(out.attributes(wall.expressId)?.[2]).toBe('Created Wall');
    // The placement chain is reachable only THROUGH the created wall, so it
    // proves the closure walks overlay records, not merely that a product
    // became a root.
    expect(out.typeOf(placement.expressId)).toBe('IFCLOCALPLACEMENT');
    expect(out.typeOf(axis.expressId)).toBe('IFCAXIS2PLACEMENT3D');
    expect(out.typeOf(point.expressId)).toBe('IFCCARTESIANPOINT');
    expect(out.typeOf(rel.expressId)).toBe('IFCRELCONTAINEDINSPATIALSTRUCTURE');
    expect(out.danglingRefs()).toEqual([]);
  });

  it('honours isolation over the created entity, the way an id allowlist does', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const kept = editor.addEntity('IfcWall', [guid('keep'), null, 'Kept', null, null, null, null, null, null]);
    const dropped = editor.addEntity('IfcWall', [guid('drop'), null, 'Dropped', null, null, null, null, null, null]);

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
      isolatedEntityIds: new Set<number>([kept.expressId]),
    });
    const out = await reparse(result.content);

    expect(out.typeOf(kept.expressId)).toBe('IFCWALL');
    expect(out.typeOf(dropped.expressId)).toBeNull();
    // The source wall is not isolated either — isolation must mean the same
    // thing on both sides of the seam.
    expect(out.typeOf(EXISTING_WALL_ID)).toBeNull();
    // No global dangling-ref assertion here: `getVisibleEntityIds` makes every
    // IfcRel* record a root by design, so an isolated export keeps #9/#12
    // pointing at the excluded source wall. That is longstanding visible-only
    // behaviour, not the overlay seam this file covers.
  });

  it('pulls a created IfcStyledItem in on the reverse style pass', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const point = editor.addEntity('IfcCartesianPoint', [[{ real: 1 }, { real: 2 }, { real: 3 }]]);
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point.expressId}`, null, null]);
    const placement = editor.addEntity('IfcLocalPlacement', [null, `#${axis.expressId}`]);
    editor.addEntity('IfcWall', [
      guid('styled'), null, 'Styled Wall', null, null, `#${placement.expressId}`, null, null, null,
    ]);
    // Nothing references a styled item, so the forward closure cannot reach it;
    // it is found by the reverse pass, which needs the created record in the
    // by-type index AND needs to read its references off the authored payload.
    const colour = editor.addEntity('IfcColourRgb', [null, { real: 1 }, { real: 0 }, { real: 0 }]);
    const rendering = editor.addEntity('IfcSurfaceStyleRendering', [
      `#${colour.expressId}`, null, null, null, null, null, null, null, '.FLAT.',
    ]);
    const surfaceStyle = editor.addEntity('IfcSurfaceStyle', [
      'Red', '.BOTH.', [`#${rendering.expressId}`],
    ]);
    const styledItem = editor.addEntity('IfcStyledItem', [
      `#${point.expressId}`, [`#${surfaceStyle.expressId}`], null,
    ]);

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const out = await reparse(result.content);

    expect(out.typeOf(styledItem.expressId)).toBe('IFCSTYLEDITEM');
    expect(out.typeOf(surfaceStyle.expressId)).toBe('IFCSURFACESTYLE');
    expect(out.typeOf(colour.expressId)).toBe('IFCCOLOURRGB');
    expect(out.danglingRefs()).toEqual([]);
  });

  it('excludes a created opening whose host is hidden', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const opening = editor.addEntity('IfcOpeningElement', [
      guid('opening'), null, 'Opening', null, null, null, null, null, null,
    ]);
    editor.addEntity('IfcRelVoidsElement', [
      guid('voids'), null, null, null, `#${EXISTING_WALL_ID}`, `#${opening.expressId}`,
    ]);

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set<number>([EXISTING_WALL_ID]),
    });
    const out = await reparse(result.content);

    // An opening whose host is not in the file is an orphan hanging in space.
    // Propagation reads IfcRelVoidsElement out of the by-type index, which had
    // to grow the session's own records for a created relation to count.
    expect(out.typeOf(EXISTING_WALL_ID)).toBeNull();
    expect(out.typeOf(opening.expressId)).toBeNull();
  });

  it('excludes a created opening after its relation is EDITED post-creation (#2347)', async () => {
    // The overlay appends positional/attribute-mutation refs AFTER the
    // creation-payload refs (`OverlayIndex.refsOf`), so a caller that reads
    // an overlay-created IfcRelVoidsElement's ends by taking the LAST TWO
    // entries of that union reads the wrong pair once the relation has been
    // edited after creation. Create voids(EXISTING_WALL_ID, opening), then
    // redirect RelatingBuildingElement at a second wall and hide THAT wall.
    // The opening must still be excluded — its host is gone either way.
    const store = await parseBase();
    const { view, editor } = newView(store);
    const opening = editor.addEntity('IfcOpeningElement', [
      guid('opening'), null, 'Opening', null, null, null, null, null, null,
    ]);
    const otherWall = editor.addEntity('IfcWall', [
      guid('otherwall'), null, 'Other Wall', null, null, null, null, null, null,
    ]);
    const rel = editor.addEntity('IfcRelVoidsElement', [
      guid('voids'), null, null, null, `#${EXISTING_WALL_ID}`, `#${opening.expressId}`,
    ]);
    // Edit APPLIED AFTER creation — the scenario the issue calls out. A
    // create-only fixture (the previous test) passes on both old and new
    // code; this is what actually exercises the bug.
    editor.setAttribute(rel.expressId, 'RelatingBuildingElement', `#${otherWall.expressId}`);

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set<number>([otherWall.expressId]),
    });
    const out = await reparse(result.content);

    expect(out.typeOf(otherWall.expressId)).toBeNull();
    // The wrong outcome this reproduces: reading the union's last two as
    // (opening, otherWall) instead of the effective
    // (RelatingBuildingElement, RelatedOpeningElement) = (otherWall, opening)
    // leaves the opening in the file because its relating-element slot
    // never resolves to a hidden id.
    expect(out.typeOf(opening.expressId)).toBeNull();
    // The relation itself must not survive dangling either.
    expect(out.typeOf(rel.expressId)).toBeNull();
    // Control: the ORIGINAL wall was never hidden, and is no longer the
    // relation's relating element after the edit, so it must still be
    // present — proves the exclusion followed the EDITED end, not a stale
    // union member.
    expect(out.typeOf(EXISTING_WALL_ID)).not.toBeNull();
  });

  it('excludes an opening whose voiding relation was RETYPED into IfcRelVoidsElement (schema lookup must use the effective type)', async () => {
    // Created under a DIFFERENT relationship type (same positional shape,
    // different attribute names: IfcRelAggregates has RelatingObject /
    // RelatedObjects at slots 4/5 where IfcRelVoidsElement has
    // RelatingBuildingElement / RelatedOpeningElement) and only retyped to
    // IfcRelVoidsElement afterward. `effectiveAttributeRef` resolves
    // 'RelatingBuildingElement' by looking up its POSITION in the entity's
    // schema — if that lookup uses the entity's authored (pre-retype) type
    // instead of its effective (post-retype) type, `findIndex` finds no
    // attribute of that name in IfcRelAggregates' schema and returns
    // undefined, so `propagateOpeningExclusions` can never learn the
    // relation's host and the opening survives a hidden host.
    const store = await parseBase();
    const { view, editor } = newView(store);
    const opening = editor.addEntity('IfcOpeningElement', [
      guid('opening'), null, 'Opening', null, null, null, null, null, null,
    ]);
    const rel = editor.addEntity('IfcRelAggregates', [
      guid('voids'), null, null, null, `#${EXISTING_WALL_ID}`, [`#${opening.expressId}`],
    ]);
    expect(editor.setEntityType(rel.expressId, 'IfcRelVoidsElement')).toBe(true);

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set<number>([EXISTING_WALL_ID]),
    });
    const out = await reparse(result.content);

    expect(out.typeOf(EXISTING_WALL_ID)).toBeNull();
    expect(out.typeOf(opening.expressId)).toBeNull();
  });

  it('withholds a SOURCE record retyped ACROSS the IFCREL boundary that now names a hidden entity (#2398)', async () => {
    // #13 is authored IFCWALLTYPE — not a relationship, so the source-iteration
    // pass's hidden-ref filter must be OFF for it. Retyped here into
    // IfcRelAggregates, it becomes one. `filterHiddenRefsFromRelationshipLine`
    // has to key off the EFFECTIVE (post-retype) class, not the authored one:
    // classifying by `entityRef.type` (frozen at parse time) would still read
    // "IFCWALLTYPE" after the retype and skip the filter entirely, shipping a
    // `#N` with no defining line — the exact dangling ref #2398 exists to close.
    const store = await parseBase();
    const { view, editor } = newView(store);
    expect(editor.setEntityType(EXISTING_TYPE_ID, 'IfcRelAggregates')).toBe(true);
    editor.setPositionalAttribute(EXISTING_TYPE_ID, 4, `#${STOREY_ID}`);
    editor.setPositionalAttribute(EXISTING_TYPE_ID, 5, [`#${EXISTING_WALL_ID}`]);

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set<number>([EXISTING_WALL_ID]),
    });
    const out = await reparse(result.content);

    expect(out.typeOf(EXISTING_WALL_ID)).toBeNull();
    // RelatedObjects names only the hidden wall, so removing it empties the
    // list and the whole retyped relation must be withheld — not shipped with
    // a dangling `#8`.
    expect(out.typeOf(EXISTING_TYPE_ID)).toBeNull();
    expect(out.danglingRefs()).toEqual([]);
  });

  it('emits no pset for a host the closure excluded', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    // Edit a pset on a wall, then hide that wall. The host is not in the file,
    // so the IfcPropertySet and its relation must not be either — the mutation
    // passes used to run before the closure existed and never consulted it.
    editor.addPropertySet(LONE_WALL_ID, 'Pset_Fresh', [
      { name: 'Foo', value: 'bar', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set<number>([LONE_WALL_ID]),
    });
    const out = await reparse(result.content);

    expect(out.typeOf(LONE_WALL_ID)).toBeNull();
    // The source relation is itself withheld now, not merely un-augmented:
    // relationships are always closure roots, so `LONE_REL_ID`'s bytes would
    // otherwise be copied verbatim into the file naming a host with no
    // defining line — a dangling reference and an invalid file (#2398). Its
    // RelatedObjects list names only the excluded host, so removing that id
    // leaves it empty and `filterHiddenRefsFromRelationshipLine` withholds
    // the whole relation rather than emit `(...)` with nothing in it.
    expect(out.relDefinesTargeting(LONE_WALL_ID)).toEqual([]);
    const psetNames = (out.store.entityIndex.byType.get('IFCPROPERTYSET') ?? []).map(
      (id) => out.attributes(id)?.[2],
    );
    expect(psetNames).not.toContain('Pset_Fresh');
    expect(out.danglingRefs()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Instance 5 — `isTypeEntity()` misclassified overlay-created types
// ---------------------------------------------------------------------------

describe('overlay-created type entities own their psets (#2012 instance 5)', () => {
  it('writes a created IfcWallType pset into HasPropertySets, not a rel', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    const wallType = editor.addEntity('IfcWallType', [
      guid('newtype'), null, 'WT2', null, null, null, null, null, null, '.STANDARD.',
    ]);
    editor.addPropertySet(wallType.expressId, 'Pset_WallCommon', [
      { name: 'IsExternal', value: true, type: 'BOOLEAN' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    // HasPropertySets is slot 5 of every IfcTypeObject subtype.
    const hasPropertySets = out.attributes(wallType.expressId)?.[5];
    expect(Array.isArray(hasPropertySets)).toBe(true);
    const psetIds = (hasPropertySets as unknown[]).filter((v): v is number => typeof v === 'number');
    expect(psetIds).toHaveLength(1);
    expect(out.typeOf(psetIds[0])).toBe('IFCPROPERTYSET');
    // A type object is defined by HasPropertySets; an occurrence rel pointing at
    // it is structurally wrong IFC.
    expect(out.relDefinesTargeting(wallType.expressId)).toEqual([]);
    expect(out.danglingRefs()).toEqual([]);
  });

  it('keeps the psets a created type already had, and appends the new one', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    // Slot 5 is HasPropertySets: this type is authored already owning the
    // file's Pset_WallCommon. Reading that list off the source index (where the
    // created type does not exist) returns nothing, so the pset it already had
    // would be dropped from the rewritten list — the same read, one attribute
    // over from the classification bug.
    const wallType = editor.addEntity('IfcWallType', [
      guid('owntype'), null, 'WT3', null, null, [`#${EXISTING_PSET_ID}`], null, null, null, '.STANDARD.',
    ]);
    editor.addPropertySet(wallType.expressId, 'Pset_Fresh', [
      { name: 'Foo', value: 'bar', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    const hasPropertySets = out.attributes(wallType.expressId)?.[5];
    expect(Array.isArray(hasPropertySets)).toBe(true);
    const psetIds = (hasPropertySets as unknown[]).filter((v): v is number => typeof v === 'number');
    expect(psetIds).toHaveLength(2);
    expect(psetIds[0]).toBe(EXISTING_PSET_ID);
    expect(out.attributes(psetIds[1])?.[2]).toBe('Pset_Fresh');
    expect(out.relDefinesTargeting(wallType.expressId)).toEqual([]);
    expect(out.danglingRefs()).toEqual([]);
  });

  it('classifies a RETYPED entity by its new class, not the record\u2019s', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    // #13 is an IfcWallType: not a product, not spatial, not a relationship, so
    // it is never a visible-only root and nothing in the file references it.
    // Retyped to IfcWall it becomes one — but only if classification asks the
    // overlay what class the entity will be SAVED as.
    expect(editor.setEntityType(EXISTING_TYPE_ID, 'IfcWall')).toBe(true);

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const out = await reparse(result.content);

    expect(out.typeOf(EXISTING_TYPE_ID)).toBe('IFCWALL');
  });

  it('routes a created entity RETYPED into a type class through HasPropertySets', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const entity = editor.addEntity('IfcWall', [
      guid('retyped'), null, 'Becomes A Type', null, null, null, null, null, null,
    ]);
    expect(editor.setEntityType(entity.expressId, 'IfcWallType')).toBe(true);
    editor.addPropertySet(entity.expressId, 'Pset_WallCommon', [
      { name: 'IsExternal', value: true, type: 'BOOLEAN' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    expect(out.typeOf(entity.expressId)).toBe('IFCWALLTYPE');
    const hasPropertySets = out.attributes(entity.expressId)?.[5];
    expect(Array.isArray(hasPropertySets)).toBe(true);
    expect(out.relDefinesTargeting(entity.expressId)).toEqual([]);
    expect(out.danglingRefs()).toEqual([]);
  });

  it('keeps the source-buffer type path working (no regression)', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    editor.addPropertySet(EXISTING_TYPE_ID, 'Pset_WallCommon', [
      { name: 'IsExternal', value: false, type: 'BOOLEAN' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    const hasPropertySets = out.attributes(EXISTING_TYPE_ID)?.[5];
    expect(Array.isArray(hasPropertySets)).toBe(true);
    expect(out.relDefinesTargeting(EXISTING_TYPE_ID)).toEqual([]);
    expect(out.danglingRefs()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The same shape, one attribute over: OwnerHistory of a created host
// ---------------------------------------------------------------------------

describe('generated psets take the created host\u2019s own OwnerHistory (#2012)', () => {
  it('gives a created host its OWN authored OwnerHistory, not the file default', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const person = editor.addEntity('IfcPerson', [null, 'Doe', 'Jane', null, null, null, null, null]);
    const org = editor.addEntity('IfcOrganization', [null, 'Acme', null, null, null]);
    const owner = editor.addEntity('IfcPersonAndOrganization', [
      `#${person.expressId}`, `#${org.expressId}`, null,
    ]);
    const history = editor.addEntity('IfcOwnerHistory', [
      `#${owner.expressId}`, null, null, '.NOCHANGE.', null, null, null, 0,
    ]);
    const wall = editor.addEntity('IfcWall', [
      guid('owned'), `#${history.expressId}`, 'Owned Wall', null, null, null, null, null, null,
    ]);
    editor.addPropertySet(wall.expressId, 'Pset_New', [{ name: 'Foo', value: 'bar', type: 'TEXT' }]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    const relIds = out.relDefinesTargeting(wall.expressId);
    expect(relIds).toHaveLength(1);
    // Slot 1 of the generated IfcRelDefinesByProperties is its OwnerHistory.
    expect(out.attributes(relIds[0])?.[1]).toBe(history.expressId);
  });
});

// ---------------------------------------------------------------------------
// An explicit null override IS the overlay's answer (`Map.has`, not `??`)
// ---------------------------------------------------------------------------

describe('a cleared positional slot is an answer, not an absence (#2012)', () => {
  it('does not resurrect an OwnerHistory the session cleared', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const history = editor.addEntity('IfcOwnerHistory', [
      null, null, null, '.NOCHANGE.', null, null, null, 0,
    ]);
    const wall = editor.addEntity('IfcWall', [
      guid('cleared'), `#${history.expressId}`, 'Cleared', null, null, null, null, null, null,
    ]);
    // Explicitly clear the slot the creation payload filled in. `??` reads the
    // null as "no override" and reinstates `#history`.
    editor.setPositionalAttribute(wall.expressId, 1, null);
    editor.addPropertySet(wall.expressId, 'Pset_New', [{ name: 'Foo', value: 'bar', type: 'TEXT' }]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    const relIds = out.relDefinesTargeting(wall.expressId);
    expect(relIds).toHaveLength(1);
    expect(out.attributes(relIds[0])?.[1]).not.toBe(history.expressId);
    expect(out.danglingRefs()).toEqual([]);
  });

  it('does not reference an OwnerHistory the session deleted', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const history = editor.addEntity('IfcOwnerHistory', [
      null, null, null, '.NOCHANGE.', null, null, null, 0,
    ]);
    const wall = editor.addEntity('IfcWall', [
      guid('orphan'), `#${history.expressId}`, 'Orphaned', null, null, null, null, null, null,
    ]);
    editor.addPropertySet(wall.expressId, 'Pset_New', [{ name: 'Foo', value: 'bar', type: 'TEXT' }]);
    // The slot still names it, but the entity is gone. A reference is a
    // reference: the records this export GENERATES may not point at one with no
    // defining line, which is why owner-history resolution goes through the
    // same `willBeEmitted` predicate the emit guards use.
    editor.removeEntity(history.expressId);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    expect(out.typeOf(history.expressId)).toBeNull();
    const relIds = out.relDefinesTargeting(wall.expressId);
    expect(relIds).toHaveLength(1);
    // Slot 1 of both generated records is OwnerHistory; null is `$`.
    expect(out.attributes(relIds[0])?.[1]).toBeNull();
    const psetId = out.attributes(relIds[0])?.[5];
    expect(typeof psetId).toBe('number');
    expect(out.attributes(psetId as number)?.[1]).toBeNull();

    // No global dangling-ref assertion: the created wall's OWN authored payload
    // still names `#history` in slot 1, because nothing rewrites an overlay
    // record's attributes when a referenced entity is deleted. That is the
    // delete-cascade gap this PR deliberately leaves open (the same one that
    // leaves a source IfcRelContainedInSpatialStructure pointing at a deleted
    // wall), not the owner-history resolution under test here.
  });

  it('falls back to an OwnerHistory that survives, not merely the first one', async () => {
    // The host carries no OwnerHistory of its own, so resolution takes the
    // fallback branch — which used to pick the file's first `IFCOWNERHISTORY`
    // whether or not this export still contains it. IFC2X3 makes OwnerHistory
    // mandatory, so the fallback exists precisely to keep the generated records
    // valid; pointing it at a deleted record defeats that.
    const owned = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('o.ifc','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid('oproj')}',$,'P',$,$,$,$,$,$);
#2=IFCWALL('${guid('owall')}',$,'W',$,$,$,$,$,$);
#3=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#4=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
ENDSEC;
END-ISO-10303-21;`;
    const store = await new IfcParser().parseColumnar(
      toArrayBuffer(new TextEncoder().encode(owned)),
    );
    const { view, editor } = newView(store);
    editor.addPropertySet(2, 'Pset_New', [{ name: 'Foo', value: 'bar', type: 'TEXT' }]);
    editor.removeEntity(3);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    const relIds = out.relDefinesTargeting(2);
    expect(relIds).toHaveLength(1);
    expect(out.attributes(relIds[0])?.[1]).toBe(4);
    expect(out.danglingRefs()).toEqual([]);
  });

  it('does not answer a second export from the first one’s owner-history cache', async () => {
    // `ownerHistoryFallbackRef` is memoised, and since it now depends on
    // `willBeEmitted` it depends on the overlay state at the time of the call.
    // Exporting, deleting, and exporting again from the SAME exporter must not
    // hand back the resolution the first call cached.
    const owned = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('o.ifc','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid('cproj')}',$,'P',$,$,$,$,$,$);
#2=IFCWALL('${guid('cwall')}',$,'W',$,$,$,$,$,$);
#3=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
#4=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);
ENDSEC;
END-ISO-10303-21;`;
    const store = await new IfcParser().parseColumnar(
      toArrayBuffer(new TextEncoder().encode(owned)),
    );
    const { view, editor } = newView(store);
    editor.addPropertySet(2, 'Pset_New', [{ name: 'Foo', value: 'bar', type: 'TEXT' }]);
    const exporter = new StepExporter(store, view);

    const first = await reparse(exporter.export({ schema: 'IFC4' }).content);
    expect(first.attributes(first.relDefinesTargeting(2)[0])?.[1]).toBe(3);

    editor.removeEntity(3);

    const second = await reparse(exporter.export({ schema: 'IFC4' }).content);
    expect(second.typeOf(3)).toBeNull();
    expect(second.attributes(second.relDefinesTargeting(2)[0])?.[1]).toBe(4);
    expect(second.danglingRefs()).toEqual([]);
  });

  it('does not resurrect a HasPropertySets list the session cleared', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const wallType = editor.addEntity('IfcWallType', [
      guid('cleartype'), null, 'WT4', null, null, [`#${EXISTING_PSET_ID}`], null, null, null, '.STANDARD.',
    ]);
    // The authored list is explicitly emptied, and only then is a pset added.
    // `??` reinstates the removed reference beside the generated replacement,
    // so the saved model disagrees with the overlay.
    editor.setPositionalAttribute(wallType.expressId, 5, null);
    editor.addPropertySet(wallType.expressId, 'Pset_Fresh', [
      { name: 'Foo', value: 'bar', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    const hasPropertySets = out.attributes(wallType.expressId)?.[5];
    expect(Array.isArray(hasPropertySets)).toBe(true);
    const psetIds = (hasPropertySets as unknown[]).filter((v): v is number => typeof v === 'number');
    expect(psetIds).toHaveLength(1);
    expect(psetIds).not.toContain(EXISTING_PSET_ID);
    expect(out.attributes(psetIds[0])?.[2]).toBe('Pset_Fresh');
    expect(out.danglingRefs()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Type-object-ness is a schema question, not a suffix (#2033's answer)
// ---------------------------------------------------------------------------

const DUPLEX = resolve(__dirname, '../../../tests/models/ara3d/duplex.ifc');

describe('IFC2X3 style classes are type objects (#2012)', () => {
  // Fetched on demand via `pnpm fixtures`; skip cleanly when absent.
  it.skipIf(!existsSync(DUPLEX))(
    'routes an IfcDoorStyle pset through HasPropertySets on a real IFC2X3 model',
    async () => {
      const bytes = new Uint8Array(readFileSync(DUPLEX));
      const store = await new IfcParser().parseColumnar(toArrayBuffer(bytes));
      const doorStyles = store.entityIndex.byType.get('IFCDOORSTYLE') ?? [];
      expect(doorStyles.length).toBeGreaterThan(0);
      const styleId = doorStyles[0];

      const { view, editor } = newView(store);
      editor.addPropertySet(styleId, 'Pset_DoorCommon', [
        { name: 'IsExternal', value: true, type: 'BOOLEAN' },
      ]);

      const result = new StepExporter(store, view).export({ schema: 'IFC2X3' });
      const out = await reparse(result.content);

      // `'IFCDOORSTYLE'.endsWith('TYPE')` is false, so a suffix test called this
      // an occurrence and wrote the pset onto a relation instead.
      expect(out.relDefinesTargeting(styleId)).toEqual([]);
      const hasPropertySets = out.attributes(styleId)?.[5];
      expect(Array.isArray(hasPropertySets)).toBe(true);
      const psetIds = (hasPropertySets as unknown[]).filter((v): v is number => typeof v === 'number');
      const names = psetIds.map((id) => out.attributes(id)?.[2]);
      expect(names).toContain('Pset_DoorCommon');
    },
    60_000,
  );

  it('treats IfcRelDefinesByType as the relationship it is, not a type object', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    // The other direction of the same defect: the class ends in `TYPE`, so the
    // suffix test would have written a pset into its slot 5.
    const rel = editor.addEntity('IfcRelDefinesByType', [
      guid('reltype'), null, null, null, [`#${EXISTING_WALL_ID}`], `#${EXISTING_TYPE_ID}`,
    ]);
    editor.addPropertySet(rel.expressId, 'Pset_Odd', [{ name: 'Foo', value: 'bar', type: 'TEXT' }]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    expect(out.relDefinesTargeting(rel.expressId)).toHaveLength(1);
    expect(out.danglingRefs()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Instance 7 — deleting an overlay-created entity left a dangling relation
// ---------------------------------------------------------------------------

describe('deleting an overlay-created entity emits nothing at all (#2012 instance 7)', () => {
  it('tombstones the created entity so isDeleted() stops lying', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const wall = editor.addEntity('IfcWall', [guid('doomed'), null, 'Doomed', null, null, null, null, null, null]);

    expect(view.isDeleted(wall.expressId)).toBe(false);
    expect(editor.removeEntity(wall.expressId)).toBe(true);
    expect(view.isDeleted(wall.expressId)).toBe(true);
    expect(view.getNewEntity(wall.expressId)).toBeNull();
  });

  it('drops the pset AND its relation when the created host is deleted', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const wall = editor.addEntity('IfcWall', [guid('doomed'), null, 'Doomed', null, null, null, null, null, null]);
    editor.addPropertySet(wall.expressId, 'Pset_New', [{ name: 'Foo', value: 'bar', type: 'TEXT' }]);
    editor.removeEntity(wall.expressId);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    expect(out.typeOf(wall.expressId)).toBeNull();
    expect(out.relDefinesTargeting(wall.expressId)).toEqual([]);
    expect(out.danglingRefs()).toEqual([]);
    // Nothing at all: the pset content the delete superseded must not survive
    // as an orphan either.
    const psetNames = (out.store.entityIndex.byType.get('IFCPROPERTYSET') ?? []).map(
      (id) => out.attributes(id)?.[2],
    );
    expect(psetNames).not.toContain('Pset_New');
  });

  it('restores the tombstone as well as the record on undo', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    const wall = editor.addEntity('IfcWall', [guid('undone'), null, 'Undone', null, null, null, null, null, null]);
    const stashed = view.getNewEntity(wall.expressId)!;
    editor.removeEntity(wall.expressId);
    view.restoreNewEntity(stashed);

    expect(view.isDeleted(wall.expressId)).toBe(false);
    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);
    expect(out.attributes(wall.expressId)?.[2]).toBe('Undone');
  });
});

// ---------------------------------------------------------------------------
// The eighth instance — the same shape on a SOURCE entity (#1978, PR #1996)
// ---------------------------------------------------------------------------

describe('deleting an EDITED source entity emits no dangling relation (#2012)', () => {
  it('drops the queued pset of a tombstoned source entity, and the original', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    editor.addPropertySet(LONE_WALL_ID, 'Pset_WallCommon', [
      { name: 'IsExternal', value: true, type: 'BOOLEAN' },
    ]);
    editor.removeEntity(LONE_WALL_ID);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    expect(out.typeOf(LONE_WALL_ID)).toBeNull();
    expect(out.relDefinesTargeting(LONE_WALL_ID)).toEqual([]);
    // The pset the delete superseded is gone AND so is the source relation that
    // named the wall — both would otherwise reference a record nothing wrote.
    expect(out.typeOf(LONE_REL_ID)).toBeNull();
    expect(out.danglingRefs()).toEqual([]);
  });

  it('drops the queued quantity set of a tombstoned source entity', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    editor.addQuantitySet(LONE_WALL_ID, 'Qto_WallBaseQuantities', [
      { name: 'NetVolume', value: 2.5, quantityType: 'VOLUME' },
    ]);
    editor.removeEntity(LONE_WALL_ID);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    expect(out.typeOf(LONE_WALL_ID)).toBeNull();
    expect(out.relDefinesTargeting(LONE_WALL_ID)).toEqual([]);
    expect(out.danglingRefs()).toEqual([]);
  });

  it('keeps a pset the deleted entity SHARED with a survivor', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    // #11 is referenced by two relations: #12 (the existing wall) and #15 (the
    // lone wall). Editing it on the lone wall queues a wholesale replacement,
    // which skips the original — and once the lone wall is deleted there is no
    // replacement to take its place, so the existing wall's #12 would point at
    // a container nobody wrote.
    //
    // Verified against main at e6516991 (#2030's own merge commit), where this
    // exact sequence exports with findDanglingRefs() === [11]: a deleted entity
    // could still cause the exporter to REMOVE something. `willBeEmitted`
    // guards what is added; only refusing to collect a deleted entity's
    // mutations guards what is taken away.
    editor.addPropertySet(LONE_WALL_ID, 'Pset_WallCommon', [
      { name: 'IsExternal', value: true, type: 'BOOLEAN' },
    ]);
    editor.removeEntity(LONE_WALL_ID);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    expect(out.typeOf(EXISTING_PSET_ID)).toBe('IFCPROPERTYSET');
    expect(out.relDefinesTargeting(EXISTING_WALL_ID)).toEqual([EXISTING_REL_ID]);
    expect(out.danglingRefs()).toEqual([]);
  });

  it('keeps a QUANTITY set the deleted entity shared with a survivor', async () => {
    // The quantity path has the same removal hazard as the property path, on
    // its own bookkeeping (`getElementQuantityName`). Its own fixture, because
    // sharing one IfcElementQuantity between two walls is not something the
    // base model should carry for every other test.
    const shared = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('q.ifc','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${guid('qproj')}',$,'P',$,$,$,$,$,$);
#2=IFCWALL('${guid('qkeep')}',$,'Survivor',$,$,$,$,$,$);
#3=IFCWALL('${guid('qgone')}',$,'Doomed',$,$,$,$,$,$);
#4=IFCQUANTITYLENGTH('Length',$,$,3.,$);
#5=IFCELEMENTQUANTITY('${guid('qset')}',$,'Qto_WallBaseQuantities',$,$,(#4));
#6=IFCRELDEFINESBYPROPERTIES('${guid('qrel1')}',$,$,$,(#2),#5);
#7=IFCRELDEFINESBYPROPERTIES('${guid('qrel2')}',$,$,$,(#3),#5);
ENDSEC;
END-ISO-10303-21;`;
    const store = await new IfcParser().parseColumnar(
      toArrayBuffer(new TextEncoder().encode(shared)),
    );
    const { view, editor } = newView(store);
    editor.addQuantitySet(3, 'Qto_WallBaseQuantities', [
      { name: 'Length', value: 9, quantityType: 'LENGTH' },
    ]);
    editor.removeEntity(3);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    expect(out.typeOf(3)).toBeNull();
    expect(out.typeOf(5)).toBe('IFCELEMENTQUANTITY');
    expect(out.relDefinesTargeting(2)).toEqual([6]);
    expect(out.danglingRefs()).toEqual([]);
  });

  it('emits nothing for a mutation queued against an id nothing has', async () => {
    const store = await parseBase();
    const { view } = newView(store);
    // Neither the file nor the session has #9999. A relation naming it would
    // dangle exactly as a deleted host's does, so the predicate has to answer
    // "will this id have a defining line", not merely "was it deleted".
    view.setProperty(9999, 'Pset_Ghost', 'Foo', 'bar', PropertyValueType.Text);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    expect(out.relDefinesTargeting(9999)).toEqual([]);
    expect(out.danglingRefs()).toEqual([]);
  });

  it('still emits a source entity’s psets under deltaOnly, whose line is not in the delta', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    editor.addPropertySet(EXISTING_WALL_ID, 'Pset_Delta', [
      { name: 'Foo', value: 'bar', type: 'TEXT' },
    ]);

    const result = new StepExporter(store, view).export({ schema: 'IFC4', deltaOnly: true });
    const text = new TextDecoder().decode(result.content);

    // #2030's deliberate carve-out, pinned so this refactor cannot quietly
    // reverse it: `deltaOnly` skips the source-iteration pass wholesale, so the
    // wall has no line here — but a delta is a patch against a file that
    // already has one, not a standalone model, and the pset must still ship.
    expect(text).not.toContain(`#${EXISTING_WALL_ID}=IFCWALL`);
    expect(text).toContain('Pset_Delta');
    expect(text).toContain(`(#${EXISTING_WALL_ID})`);
  });

  it('keeps a shared relation whose other related object is still alive', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);
    // #12 relates only the existing wall; delete a DIFFERENT entity and the
    // relation must survive untouched. The sweep drops a relation only when
    // every object it relates is gone.
    editor.removeEntity(LONE_WALL_ID);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    expect(out.typeOf(EXISTING_REL_ID)).toBe('IFCRELDEFINESBYPROPERTIES');
    expect(out.relDefinesTargeting(EXISTING_WALL_ID)).toEqual([EXISTING_REL_ID]);
  });

  it('rewrites a SOURCE containment relation instead of shipping a tombstoned member (#2398)', async () => {
    // The deletion sweep a few lines up in `step-exporter.ts` only withholds
    // an `IfcRelDefinesByProperties` whose RelatedObjects is EMPTIED entirely,
    // and only for that one relationship class — it says so in its own
    // comment ("nothing here rewrites a RelatedObjects list"). A
    // spatial-containment relation naming two walls, one of which the session
    // deletes, is untouched by that sweep: pre-fix, #9's bytes are copied
    // verbatim and the tombstoned wall's id ships with no defining line — the
    // exact invalid-file shape `filterHiddenRefsFromRelationshipLine` exists
    // to close for `visibleOnly`, on a plain full export with no
    // `visibleOnly` involved at all.
    const store = await parseBase();
    const { view, editor } = newView(store);
    // #9 authored contains only #8 (EXISTING_WALL_ID). Widen it to also name
    // #14 (LONE_WALL_ID) — a second, otherwise-independent source wall — so
    // deleting #14 exercises a PARTIAL-list rewrite, not a whole-relation
    // withhold.
    editor.setPositionalAttribute(9, 4, [`#${EXISTING_WALL_ID}`, `#${LONE_WALL_ID}`]);
    editor.removeEntity(LONE_WALL_ID);

    const result = new StepExporter(store, view).export({ schema: 'IFC4' });
    const out = await reparse(result.content);

    expect(out.typeOf(LONE_WALL_ID)).toBeNull();
    // The relation survives — #8 is still validly contained — but must no
    // longer name #14.
    expect(out.typeOf(9)).toBe('IFCRELCONTAINEDINSPATIALSTRUCTURE');
    const containment = (out.attributes(9) ?? [])[4];
    expect(Array.isArray(containment) ? containment : []).toEqual([EXISTING_WALL_ID]);
    expect(out.danglingRefs()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The whole session, round-tripped
// ---------------------------------------------------------------------------

describe('a create/edit/retype/delete session round-trips through the file (#2012)', () => {
  it('agrees with what the session did, under visibleOnly', async () => {
    const store = await parseBase();
    const { view, editor } = newView(store);

    const created = editor.addEntity('IfcBuildingElementProxy', [
      guid('proxy'), null, 'Proxy', null, null, null, null, null, null,
    ]);
    editor.setAttribute(created.expressId, 'Name', 'Renamed Column');
    editor.setEntityType(created.expressId, 'IfcColumn');
    editor.addEntity('IfcRelContainedInSpatialStructure', [
      guid('relnew'), null, null, null, [`#${created.expressId}`], `#${STOREY_ID}`,
    ]);

    const doomed = editor.addEntity('IfcWall', [guid('gone'), null, 'Gone', null, null, null, null, null, null]);
    editor.removeEntity(doomed.expressId);

    const result = new StepExporter(store, view).export({
      schema: 'IFC4',
      visibleOnly: true,
      hiddenEntityIds: new Set<number>(),
    });
    const out = await reparse(result.content);

    expect(out.typeOf(created.expressId)).toBe('IFCCOLUMN');
    expect(out.attributes(created.expressId)?.[2]).toBe('Renamed Column');
    expect(out.typeOf(doomed.expressId)).toBeNull();
    expect(out.typeOf(EXISTING_WALL_ID)).toBe('IFCWALL');
    expect(out.danglingRefs()).toEqual([]);
  });
});
