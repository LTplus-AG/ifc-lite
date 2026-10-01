/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A self-contained mini STEP file holding just what a few elements need to
 * be meshed again (#6232 WP1): the elements, everything they reference, and
 * the inverse context from {@link remeshContextRoots}. The wasm pre-pass and
 * batch mesher read it exactly as they read a whole file.
 *
 * Why not `StepExporter.export({ subsetEntityIds })`: that is O(model) per
 * call (its subset roots, style closure and source pass each walk every
 * entity), and this runs once per authoring commit. Here the cost is
 * O(walked set) for ordinary placements; grid-relative placements also scan
 * the effective grid bucket to find inverse axis ownership. Lines are
 * written by the same helpers the exporter uses so an edited or
 * overlay-created record reads here exactly as it will be saved.
 *
 * Express ids are preserved, overlay-allocated ones included, so the mesher's
 * output keys straight back onto the model. Styles are deliberately NOT in the
 * buffer: the caller sends the load-time style wire entries instead.
 */

import { asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { createLogger, fileSchemaIdentifier } from '@ifc-lite/data';
import { getEffectiveEntityIndex, type EffectiveEntityIndex } from './effective-index.js';
import {
  collectReferencedEntityIds,
  filterHiddenRefsFromRelationshipLine,
  refGroupFromArg,
} from './reference-collector.js';
import { readStepSlots } from './step-argument-parser.js';
import { applySourceLineMutations } from './step-attribute-mutations.js';
import { effectiveCreatedRecord } from './effective-source-record.js';
import { contextRootsFor } from './remesh-context-roots.js';
import { gridReferenceContext } from './grid-reference-context.js';
import { collectGridPlacementDependents } from './grid-placement-dependents.js';
import type { IfcSchemaVersion } from './schema-converter.js';

export { remeshContextRoots } from './remesh-context-roots.js';

const log = createLogger('EntitySubgraph');

export interface EntitySubgraphRequest {
  /** Elements to mesh. Tombstoned or unknown ids are skipped. */
  targets: ReadonlySet<number>;
  /**
   * Extra roots; defaults to `remeshContextRoots(store, view, targets)`. A
   * relationship root contributes its single references to the walk, but its
   * list-valued ones are narrowed to what the subgraph already holds; the
   * relationship is dropped if that empties one of its lists.
   */
  contextRoots?: ReadonlySet<number>;
}

export interface EntitySubgraph {
  /** A complete STEP file (header + DATA section). */
  bytes: Uint8Array;
  /** Every express id with a line in `bytes`. */
  ids: ReadonlySet<number>;
  /**
   * Ids whose effective record could not be written faithfully: an edit that
   * could not be placed on an unreadable source record (the source text is
   * written instead), or an overlay-created record that could not be laid
   * out (omitted), or a grid placement whose implicit owning grid is missing
   * or ambiguous. A caller meshing one of these should refuse rather than
   * show geometry that disagrees with the model.
   */
  unreadable: number[];
}

/**
 * Serialize `targets` plus their context into a standalone STEP buffer.
 *
 * Relationships are handled apart from the forward walk: their single-valued
 * references (owner history, the host, the opening, the relating material) are
 * walked, but their list-valued ones (`RelatedObjects`) are narrowed to what
 * the subgraph already holds. Walking `IfcRelAssociatesMaterial.RelatedObjects`
 * would otherwise pull in every element sharing the material.
 */
export function serializeEntitySubgraph(
  store: IfcDataStore,
  view: MutablePropertyView | null,
  req: EntitySubgraphRequest,
): EntitySubgraph {
  const index = getEffectiveEntityIndex(store, view, true);
  const schema = (store.schemaVersion as IfcSchemaVersion | undefined) || 'IFC4';
  const writer = new LineWriter(store, view, index, schema);
  const contextRoots = req.contextRoots ?? contextRootsFor(store, index, view, req.targets);

  const walkRoots = new Set<number>();
  const relationships = new Map<number, string>();
  for (const id of [...req.targets, ...contextRoots]) {
    if (!index.has(id) || relationships.has(id)) continue;
    if (!index.typeOf(id)?.startsWith('IFCREL')) {
      walkRoots.add(id);
      continue;
    }
    const line = writer.line(id);
    if (line === null) continue;
    relationships.set(id, line);
    for (const slot of readStepSlots(line)?.slots ?? []) {
      const group = refGroupFromArg(slot);
      if (typeof group === 'number') walkRoots.add(group);
    }
  }

  // Iterative (explicit queue + visited set), so cycles and long chains end.
  const walked = collectReferencedEntityIds(walkRoots, store.source, index);
  const owningGrid = gridReferenceContext(index, (id) => writer.line(id, false), schema);
  const expandedGrids = new Set<number>();
  // Set iteration visits newly added ids too. Each owning grid expands once,
  // including nested grid-relative placements without recursive walks.
  for (const id of walked) {
    if (index.typeOf(id) !== 'IFCGRIDPLACEMENT') continue;
    const gridId = owningGrid(id);
    if (gridId === null) {
      writer.markUnreadable(id);
    } else if (!expandedGrids.has(gridId)) {
      expandedGrids.add(gridId);
      for (const contextId of collectReferencedEntityIds(new Set([gridId]), store.source, index)) walked.add(contextId);
    }
  }
  const lines = new Map<number, string>();
  for (const id of walked) {
    if (relationships.has(id)) continue;
    const line = writer.line(id);
    if (line !== null) lines.set(id, line);
  }
  const isAbsent = (ref: number): boolean => !lines.has(ref) && !relationships.has(ref);
  for (const [id, line] of relationships) {
    const narrowed = filterHiddenRefsFromRelationshipLine(line, isAbsent, schema);
    if (narrowed !== null) lines.set(id, narrowed);
  }

  const ids = [...lines.keys()].sort((a, b) => a - b);
  const body = ids.map((id) => lines.get(id)).join('\n');
  const text = `${stepHeader(schema)}${body}\nENDSEC;\nEND-ISO-10303-21;\n`;
  return { bytes: new TextEncoder().encode(text), ids: new Set(ids), unreadable: writer.unreadable };
}

/** Live model-local products whose grid-relative placement follows a moved
 * grid, including local children and nested bound grids. Reads the same
 * effective records and unambiguous axis ownership as mini STEP export.
 * Malformed/deleted bindings are excluded. With bindings present this scans
 * placement and product buckets; otherwise it stops at grid placements. */
export function gridPlacementDependents(
  store: IfcDataStore, view: MutablePropertyView | null, gridIds: ReadonlySet<number>,
): Set<number> {
  const index = getEffectiveEntityIndex(store, view, true);
  const schema = (store.schemaVersion as IfcSchemaVersion | undefined) || 'IFC4';
  const writer = new LineWriter(store, view, index, schema);
  return collectGridPlacementDependents(index, (id) => writer.line(id, false), schema, gridIds);
}

function stepHeader(schema: IfcSchemaVersion): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ifc-lite entity subgraph]'),'2;1');",
    "FILE_NAME('subgraph.ifc','',(''),(''),'ifc-lite','ifc-lite','');",
    `FILE_SCHEMA(('${fileSchemaIdentifier(schema)}'));`,
    'ENDSEC;',
    'DATA;',
    '',
  ].join('\n');
}

/** One effective record per id, as the STEP exporter would write it. */
class LineWriter {
  readonly unreadable: number[] = [];
  private readonly source;
  private readonly records = new Map<number, { text: string | null; unreadable: boolean }>();

  constructor(
    store: IfcDataStore,
    private readonly view: MutablePropertyView | null,
    private readonly index: EffectiveEntityIndex,
    private readonly schema: IfcSchemaVersion,
  ) {
    this.source = asSourceBytes(store.source);
  }

  markUnreadable(id: number): void {
    if (!this.unreadable.includes(id)) this.unreadable.push(id);
  }

  line(id: number, report = true): string | null {
    let record = this.records.get(id);
    if (!record) {
      record = this.readLine(id);
      this.records.set(id, record);
    }
    if (record.unreadable && report) this.markUnreadable(id);
    return record.text;
  }

  private readLine(id: number): { text: string | null; unreadable: boolean } {
    if (this.view && this.index.isOverlayCreated(id)) return this.createdLine(this.view, id);
    const record = this.index.get(id);
    if (!record) return { text: null, unreadable: false };
    const text = this.source.decodeUtf8(record.byteOffset, record.byteOffset + record.byteLength);
    if (!this.view) return { text, unreadable: false };
    const named = new Map(this.view.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value]));
    const result = applySourceLineMutations(this.view, id, text, record.type, named, this.schema, true);
    return { text: result.text, unreadable: result.unreadable };
  }

  private createdLine(view: MutablePropertyView, id: number): { text: string | null; unreadable: boolean } {
    try {
      return { text: effectiveCreatedRecord(view, id, this.schema)?.text ?? null, unreadable: false };
    } catch (error) {
      // Reported through `unreadable`, not swallowed: the record cannot be laid
      // out for its pending retype, so it is omitted and the caller refuses.
      log.warn(`#${id} omitted from the subgraph: ${error instanceof Error ? error.message : String(error)}`);
      return { text: null, unreadable: true };
    }
  }
}
