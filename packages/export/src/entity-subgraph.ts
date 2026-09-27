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
 * O(walked set): one forward walk over the effective index plus one line per
 * walked id, written by the same helpers the exporter uses so an edited or
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
import type { IfcSchemaVersion } from './schema-converter.js';

export { remeshContextRoots } from './remesh-context-roots.js';

const log = createLogger('EntitySubgraph');

export interface EntitySubgraphRequest {
  /** Elements to mesh. Tombstoned or unknown ids are skipped. */
  targets: ReadonlySet<number>;
  /** Extra roots; defaults to `remeshContextRoots(store, view, targets)`. */
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
   * out (omitted). A caller meshing one of these should refuse rather than
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

  constructor(
    store: IfcDataStore,
    private readonly view: MutablePropertyView | null,
    private readonly index: EffectiveEntityIndex,
    private readonly schema: IfcSchemaVersion,
  ) {
    this.source = asSourceBytes(store.source);
  }

  line(id: number): string | null {
    if (this.view && this.index.isOverlayCreated(id)) return this.createdLine(this.view, id);
    const record = this.index.get(id);
    if (!record) return null;
    const text = this.source.decodeUtf8(record.byteOffset, record.byteOffset + record.byteLength);
    if (!this.view) return text;
    const named = new Map(this.view.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value]));
    const result = applySourceLineMutations(this.view, id, text, record.type, named, this.schema, true);
    if (result.unreadable) this.unreadable.push(id);
    return result.text;
  }

  private createdLine(view: MutablePropertyView, id: number): string | null {
    try {
      return effectiveCreatedRecord(view, id, this.schema)?.text ?? null;
    } catch (error) {
      // Reported through `unreadable`, not swallowed: the record cannot be laid
      // out for its pending retype, so it is omitted and the caller refuses.
      log.warn(`#${id} omitted from the subgraph: ${error instanceof Error ? error.message : String(error)}`);
      this.unreadable.push(id);
      return null;
    }
  }
}
