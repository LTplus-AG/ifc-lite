/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { discardRhino, dispose, loadRhino } from '../runtime.js';
import { readLook, resolveAppearance, type Look } from './appearance.js';
import { buildBlock, expandInstance, MAX_BLOCK_PLACEMENTS, type Block, type BlockWalk } from './blocks.js';
import { readDocument, type DocumentTables } from './document.js';
import { Emitter } from './emit.js';
import { extractGeometry, type Part } from './geometry.js';
import { endsWithFileLength, NOT_3DM_MESSAGE, readArchiveVersion } from './header.js';
import { loadIfcClasses, type IfcClasses } from './ifc-classes.js';
import { buildEntities, type ObjectFacts } from './identity.js';
import { plural, Report } from './report.js';
import { readApi, type ReadApi, type RFile } from './rhino-api.js';
import { RhinoReadError, type ReadRhino3dmOptions, type RhinoImport } from './types.js';
import { multiply } from './xform.js';

/**
 * Largest input the reader accepts. Measured, not guessed: in Node 22 with
 * rhino3dm 8.35.0 a 403 MB file of dense double-precision meshes read with the
 * wasm heap at 1,885 MB of its 2,048 MB limit, 429 MB reached 1,964 MB, and
 * 477 MB failed at the limit. The table is under "Size ceiling" in
 * docs/architecture/rhino-3dm-import.md. A file under the cap can still run
 * out of memory when its content expands more; that is reported the same way.
 */
export const MAX_3DM_BYTES = 400 * 1024 * 1024;
/** Below this no file can exhaust the heap, so a null read means damage. */
const OUT_OF_MEMORY_SUSPECT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TRIANGLES = 30_000_000;
const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

interface ObjectRow extends ObjectFacts { member: boolean; look: Look; part: Part }
/** The options with their defaults applied. */
type Settings = Required<Omit<ReadRhino3dmOptions, 'locateFile' | 'onProgress'>> & Pick<ReadRhino3dmOptions, 'onProgress'>;

/** Read every object once, releasing each wrapper before the next. Objects that draw nothing are dropped. */
function readObjects(api: ReadApi, file: RFile, tables: DocumentTables, opts: Settings, report: Report): Map<string, ObjectRow> {
  const rows = new Map<string, ObjectRow>(), table = file.objects();
  const context = { api, scale: tables.document.metersPerUnit, subdLevel: opts.subdLevel, report };
  try {
    const total = table.count, step = Math.max(1, Math.floor(total / 100));
    opts.onProgress?.(0, total);
    for (let i = 0; i < total; i++) {
      const object = table.get(i);
      let attributes, geometry;
      try {
        attributes = object.attributes(); geometry = object.geometry();
        const type = geometry.constructor.name;
        const part = extractGeometry(geometry, type, context);
        if (part) {
          // A file without layers, or an index outside the table, falls back to the first layer.
          const layer = Math.max(tables.layerIndex[attributes.layerIndex] ?? 0, 0);
          const look = readLook(api, attributes, layer);
          rows.set(attributes.id, {
            id: attributes.id, name: attributes.name, type, layer, layerPath: tables.layers[layer].fullPath,
            hidden: !attributes.visible || attributes.mode.value === api.ObjectMode.Hidden.value || tables.layers[layer].hidden,
            groups: attributes.getGroupList(), userStrings: attributes.getUserStrings(),
            material: tables.materialNames[resolveAppearance(look, tables, null).material] ?? '',
            member: attributes.isInstanceDefinitionObject, look, part,
          });
        }
      } finally { dispose(geometry); dispose(attributes); dispose(object); }
      if ((i + 1) % step === 0 || i + 1 === total) opts.onProgress?.(i + 1, total);
    }
  } finally { dispose(table); }
  return rows;
}

function readBlocks(api: ReadApi, file: RFile, rows: Map<string, ObjectRow>, tables: DocumentTables): Map<string, Block> {
  const blocks = new Map<string, Block>(), table = file.instanceDefinitions();
  const linkedTypes = [api.InstanceDefinitionUpdateType.Linked.value, api.InstanceDefinitionUpdateType.LinkedAndEmbedded.value];
  try {
    for (let i = 0; i < table.count; i++) {
      const definition = table.get(i);
      try {
        const members = definition.getObjectIds().flatMap(id => rows.get(id) ?? []);
        blocks.set(definition.id, buildBlock(definition.name, linkedTypes.includes(definition.updateType.value), members, tables));
      } finally { dispose(definition); }
    }
  } finally { dispose(table); }
  return blocks;
}

function refusal(report: Report): RhinoReadError {
  const counts = Object.entries(report.skipped).map(([reason, count]) => `${count} ${reason}`).join(', ');
  const unmeshed = Object.keys(report.skipped).some(reason => reason.endsWith(':no-render-mesh'));
  return new RhinoReadError('no-renderable-geometry', `Nothing in this file can be drawn${counts ? ` (skipped: ${counts})` : ''}.${
    unmeshed ? ' Surfaces need the render meshes Rhino stores with the file: open it in Rhino, switch to a shaded view and save without "Save Small".' : ''}`);
}

function build(api: ReadApi, file: RFile, archiveVersion: number, classes: IfcClasses, opts: Settings): RhinoImport {
  const report = new Report();
  const tables = readDocument(api, file, archiveVersion, classes, report);
  if (tables.layers.length === 0) {
    tables.layers.push({ name: 'Default', fullPath: 'Default', parent: null, color: [0, 0, 0, 255], visible: true, userStrings: [], spatial: null, material: -1, hidden: false });
  }
  const rows = readObjects(api, file, tables, opts, report);
  const blocks = readBlocks(api, file, rows, tables);
  const emitter = new Emitter(opts.bakeInstances, opts.maxTriangles);
  const walk: BlockWalk = { blocks, tables, emitter, report, placementsLeft: MAX_BLOCK_PLACEMENTS };
  const { world } = tables;

  // Draw top-level objects in file order. `entity` holds the object's position in `drawn` until entities exist.
  const drawn: ObjectRow[] = [];
  let undrawn = 0;
  for (const row of rows.values()) {
    if (row.member) continue;
    const appearance = resolveAppearance(row.look, tables, null), { part } = row, index = drawn.length;
    const before = emitter.size();
    const complete = part.kind === 'instance'
      ? expandInstance(walk, index, part.definition, world ? multiply(world, part.xform) : part.xform, appearance)
      : emitter.draw(index, part, world, appearance.color);
    if (!complete) undrawn++;
    if (emitter.size() > before) drawn.push(row);
  }
  if (undrawn > 0) {
    report.skip('budget', undrawn);
    if (emitter.exhausted) report.warn('triangles', () => `Stopped at the budget of ${opts.maxTriangles.toLocaleString('en-US')} triangles: ${plural(undrawn, 'object')} not drawn, or drawn in part.`);
  }
  if (drawn.length === 0) throw refusal(report);

  const { entities, entityOf } = buildEntities(drawn, tables.groupNames, classes, report);
  // Merging can put a later object into an earlier entity, so restore entity order.
  const byEntity = <T extends { entity: number }>(items: T[]): T[] => {
    for (const item of items) item.entity = entityOf[item.entity];
    return items.sort((a, b) => a.entity - b.entity);
  };
  return {
    format: 'ifc-lite.rhino-import', version: 1,
    document: tables.document,
    layers: tables.layers.map(({ name, fullPath, parent, color, visible, userStrings, spatial }) => ({ name, fullPath, parent, color, visible, userStrings, spatial })),
    entities,
    meshes: byEntity(emitter.meshes), definitions: emitter.definitions, instances: byEntity(emitter.instances),
    pointClouds: byEntity(emitter.pointClouds), curves: byEntity(emitter.curves), textDots: byEntity(emitter.textDots),
    skipped: report.skipped, warnings: report.warnings(),
  };
}

/** True for the ways running out of memory surfaces as a throw: an emscripten abort, a failed typed-array allocation. */
function isOutOfMemory(error: unknown): boolean {
  // A C++ exception escapes embind as its pointer, a bare number.
  return error instanceof WebAssembly.RuntimeError || error instanceof RangeError || typeof error === 'number';
}

/**
 * Read a Rhino .3dm into plain data: Z-up, metres, typed arrays.
 * Throws `RhinoReadError`; see its `code`.
 */
export async function readRhino3dm(bytes: Uint8Array, opts: ReadRhino3dmOptions = {}): Promise<RhinoImport> {
  const { subdLevel = 2, maxTriangles = DEFAULT_MAX_TRIANGLES, bakeInstances = false, onProgress } = opts;
  if (![0, 1, 2, 3].includes(subdLevel)) throw new RangeError('subdLevel must be 0, 1, 2 or 3');
  if (!(maxTriangles >= 0)) throw new RangeError('maxTriangles must be a number of triangles');
  const archiveVersion = readArchiveVersion(bytes);
  const size = megabytes(bytes.byteLength);
  if (bytes.byteLength > MAX_3DM_BYTES) {
    throw new RhinoReadError('too-large', `This file is ${size}; the reader handles up to ${megabytes(MAX_3DM_BYTES)}. Split the model into smaller files in Rhino.`);
  }
  // rhino3dm's heap stops at 2 GB, and a read takes about five times the file size of it.
  const outOfMemory = () => new RhinoReadError('too-large', `This file (${size}) needs more memory than the reader has. Split the model into smaller files in Rhino.`);
  const [rhino, classes] = await Promise.all([loadRhino(opts.locateFile), loadIfcClasses()]);
  const api = readApi(rhino);
  let file: RFile | null = null;
  try {
    file = api.File3dm.fromByteArray(bytes);
    if (!file) {
      // At the heap limit rhino3dm returns null, as it does for a damaged file. A large
      // file that still ends in its own length was not cut short, so memory is the cause.
      if (bytes.byteLength < OUT_OF_MEMORY_SUSPECT_BYTES || !endsWithFileLength(bytes)) throw new RhinoReadError('not-3dm', NOT_3DM_MESSAGE);
      discardRhino();
      throw outOfMemory();
    }
    return build(api, file, archiveVersion, classes, { subdLevel, maxTriangles, bakeInstances, onProgress });
  } catch (error) {
    if (!isOutOfMemory(error)) throw error;
    // An aborted module cannot be used again, so the next call loads a fresh one.
    discardRhino();
    file = null;
    throw outOfMemory();
  } finally { dispose(file); }
}
