/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { discardRhino, dispose, loadRhino, withCurrentRhino } from '../runtime.js';
import { readLook, resolveAppearance, type Appearance, type Look } from './appearance.js';
import { buildBlock, expandInstance, inheritableFade, markContents, MAX_BLOCK_PLACEMENTS, type Block, type BlockContext, type BlockWalk } from './blocks.js';
import { readDocument, rows as tableRows, type DocumentTables } from './document.js';
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

interface ObjectRow extends ObjectFacts { member: boolean; look: Look; appearance: Appearance; part: Part }
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
        attributes = object?.attributes(); geometry = object?.geometry();
        const type = geometry?.constructor.name ?? 'Object';
        // The binding answers null for an object it cannot wrap; count it rather than fail the file.
        if (!attributes || !geometry) report.skip(`${type}:unreadable`);
        const part = attributes && geometry ? extractGeometry(geometry, type, context) : null;
        if (part && attributes) {
          // A file without layers, or an index outside the table, falls back to the first layer.
          const layer = Math.max(tables.layerIndex[attributes.layerIndex] ?? 0, 0);
          const look = readLook(api, attributes, layer), appearance = resolveAppearance(look, tables, null);
          rows.set(attributes.id, {
            id: attributes.id, name: attributes.name, type, layer, layerPath: tables.layers[layer].fullPath,
            hidden: !attributes.visible || attributes.mode.value === api.ObjectMode.Hidden.value || tables.layers[layer].hidden,
            // No value here is ever empty: openNURBS removes a key whose value is set to the empty
            // string, so every reader of this user text sees a key as stated or absent, never blank.
            groups: attributes.getGroupList(), userStrings: attributes.getUserStrings(),
            material: tables.materials[appearance.material]?.name ?? '',
            member: attributes.isInstanceDefinitionObject, look, appearance, part,
          });
        }
      } finally { dispose(geometry); dispose(attributes); dispose(object); }
      if ((i + 1) % step === 0 || i + 1 === total) opts.onProgress?.(i + 1, total);
    }
  } finally { dispose(table); }
  return rows;
}

/** The blocks, and `claimed`: every member id the definitions list, so a member no definition owns can be told apart. */
function readBlocks(api: ReadApi, file: RFile, rows: Map<string, ObjectRow>, tables: DocumentTables, report: Report): { blocks: Map<string, Block>; claimed: Set<string> } {
  const linkedTypes = [api.InstanceDefinitionUpdateType.Linked.value, api.InstanceDefinitionUpdateType.LinkedAndEmbedded.value];
  const claimed = new Set<string>();
  // `fades` once for the file, not once per definition: it depends on the instances, not the members.
  const context: BlockContext = { tables, fades: inheritableFade(rows.values(), tables), report };
  const blocks = new Map(tableRows(file.instanceDefinitions(), (definition): [string, Block] => {
    const ids = definition.getObjectIds();
    for (const id of ids) claimed.add(id);
    const members = ids.flatMap(id => rows.get(id) ?? []);
    return [definition.id, buildBlock(definition.name, linkedTypes.includes(definition.updateType.value), members, context)];
  }));
  markContents(blocks);
  return { blocks, claimed };
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
  const rows = readObjects(api, file, tables, opts, report);
  const { blocks, claimed } = readBlocks(api, file, rows, tables, report);
  const emitter = new Emitter(opts.bakeInstances, opts.maxTriangles, report);
  const walk: BlockWalk = { blocks, tables, emitter, report, placementsLeft: MAX_BLOCK_PLACEMENTS };
  const { world } = tables;

  // Draw top-level objects in file order. `entity` holds the object's position in `drawn` until entities exist.
  const drawn: ObjectRow[] = [];
  let undrawn = 0;
  for (const row of rows.values()) {
    if (row.member) {
      // A member no definition lists is drawn by nothing, and would leave no trace of having been in the file.
      if (!claimed.has(row.id)) report.skip(`${row.type}:orphaned-block-member`);
      continue;
    }
    const { part, appearance } = row, index = drawn.length;
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
  // Merging can put a later object into an earlier entity, so restore entity order. Each record keeps
  // its own object's visibility, which a merged entity's flag cannot carry for every part.
  const byEntity = <T extends { entity: number; hidden: boolean }>(items: T[]): T[] => {
    for (const item of items) { item.hidden = drawn[item.entity].hidden; item.entity = entityOf[item.entity]; }
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

/**
 * Read a Rhino .3dm into plain data: Z-up, metres, typed arrays.
 * Throws `RhinoReadError`; see its `code`.
 */
export async function readRhino3dm(bytes: Uint8Array, opts: ReadRhino3dmOptions = {}): Promise<RhinoImport> {
  const { subdLevel = 2, maxTriangles = DEFAULT_MAX_TRIANGLES, bakeInstances = false, onProgress } = opts;
  if (![0, 1, 2, 3].includes(subdLevel)) throw new RangeError('subdLevel must be 0, 1, 2 or 3');
  // A budget has to be exhaustible, and Infinity passes a lower bound: a small archive whose blocks fan out could then ask for any number of triangles.
  if (!Number.isSafeInteger(maxTriangles) || maxTriangles < 0) throw new RangeError('maxTriangles must be a whole number of triangles, 0 or more');
  const archiveVersion = readArchiveVersion(bytes);
  const size = megabytes(bytes.byteLength);
  if (bytes.byteLength > MAX_3DM_BYTES) {
    throw new RhinoReadError('too-large', `This file is ${size}; the reader handles up to ${megabytes(MAX_3DM_BYTES)}. Split the model into smaller files in Rhino.`);
  }
  // rhino3dm's heap stops at 2 GB, and a read takes about five times the file size of it.
  const outOfMemory = () => new RhinoReadError('too-large', `This file (${size}) could not be read: it most likely needs more memory than the reader has. Split the model into smaller files in Rhino.`);
  // The runtime load starts here, so it runs alongside the classes. Its module is not kept: the
  // one that is parsed with is taken below, after the last await.
  const [, classes] = await Promise.all([loadRhino(opts.locateFile), loadIfcClasses()]);
  const large = bytes.byteLength >= OUT_OF_MEMORY_SUSPECT_BYTES;
  // What the caller's callback throws is the caller's: it is passed on as it is, never read as a wasm failure.
  let callerThrew = false;
  const progress = onProgress && ((done: number, total: number) => {
    try { onProgress(done, total); } catch (error) { callerThrew = true; throw error; }
  });
  // Another read can abort and discard the module this one was handed while it waited, and parsing
  // with a discarded module fails an import that is fine. `withCurrentRhino` runs the parse on a
  // module that is current, in the same step as the check, so no abort can slip in before it.
  return withCurrentRhino(opts.locateFile, rhino => {
    const api = readApi(rhino);
    let file: RFile | null = null;
    try {
      file = api.File3dm.fromByteArray(bytes);
      if (!file) {
        // At the heap limit rhino3dm returns null, as it does for a damaged file. A large
        // file that still ends in its own length was not cut short, so memory is the cause.
        if (!large || !endsWithFileLength(bytes)) throw new RhinoReadError('not-3dm', NOT_3DM_MESSAGE);
        discardRhino();
        throw outOfMemory();
      }
      return build(api, file, archiveVersion, classes, { subdLevel, maxTriangles, bakeInstances, onProgress: progress });
    } catch (error) {
      // A wasm trap or abort, or a C++ exception (which escapes embind as a bare number), leaves the
      // module unusable. A failed typed-array allocation only counts for a file large enough to cause one.
      const trapped = error instanceof WebAssembly.RuntimeError || typeof error === 'number';
      if (callerThrew || (!trapped && !(large && error instanceof RangeError))) throw error;
      discardRhino();
      file = null;
      // A small file cannot exhaust the heap, so a trap on one means its contents are damaged.
      throw large ? outOfMemory() : new RhinoReadError('not-3dm', NOT_3DM_MESSAGE);
    } finally { dispose(file); }
  });
}
