/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export tools (spec §7.9).
 *
 * `export_ifc` writes a STEP file (with any pending mutations applied),
 * `export_csv` and `export_json` produce tabular dumps, and `export_glb` /
 * `export_obj` export geometry via the Rust mesh pipeline (wasm, headless).
 * `export_ifcx` and `export_usd` export the current model via Rust too.
 */

import { withIfcBytes, refusingEmpty } from './export-source.js';
import { cityAndEnergyExportTools } from './export-city-energy.js';
import { export3dmTool } from './export-3dm.js';
import { hasExportFilter, selectExportEntities, exportIsolation, exportFilterProperties } from './export-selection.js';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import type { EntityRef } from '@ifc-lite/sdk';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { countGlbMeshes, countJsonldNodes, countObjVertices, countUsdMeshes, exportRustArtifact } from '@ifc-lite/export';
import type { Tool } from './types.js';
import { fmtInt, okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { resolveSafePath } from '../safe-path.js';

const exportIfc: Tool = {
  name: 'export_ifc',
  description: 'Write the model (with pending mutations) to .ifc/.ifczip on disk.',
  scope: 'export',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      file_path: { type: 'string' },
      schema: { type: 'string', enum: ['IFC2X3', 'IFC4', 'IFC4X3'] },
      ...exportFilterProperties,
      global_ids: { type: 'array', items: { type: 'string' }, description: 'Optional GlobalId allowlist; defaults to the whole model. Ids this session created count. Fails rather than exporting the whole model if none match.' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    const schema = (input.schema as 'IFC2X3' | 'IFC4' | 'IFC4X3' | undefined) ?? m.store.schemaVersion;
    // Absent `global_ids` leaves `refs` undefined: no isolation filter, the whole
    // model. An allowlist that matched nothing is an EMPTY array, never undefined.
    let refs: EntityRef[] | undefined;
    let unmatched: string[] = [];
    if (Array.isArray(input.global_ids)) {
      refs = [];
      // `query()` folds the session's queued creates (#2014), so an id this
      // session created resolves here — and since #2012 the exporter's
      // visible-only closure can see it too, which is what makes naming one in
      // the allowlist actually export it rather than silently drop it.
      const wanted = new Set(input.global_ids as string[]);
      const matched = new Set<string>();
      for (const e of selectExportEntities(m.bim, input)) {
        if (!wanted.has(e.globalId)) continue;
        refs.push(e.ref);
        matched.add(e.globalId);
      }
      unmatched = [...wanted].filter((id) => !matched.has(id));
      // FAIL CLOSED with the allowlist's own wording and count. `export.ifc`
      // refuses an empty active list too (#4738), so this is the first of two
      // lines rather than the only one.
      if (refs.length === 0) {
        throw new ToolExecutionError({
          code: ToolErrorCode.ENTITY_NOT_FOUND,
          message: `No entity matches any of the ${wanted.size} requested global_ids, so there is nothing to export. Refusing to write the whole model instead.`,
        });
      }
    }
    if (refs === undefined && hasExportFilter(input)) {
      refs = selectExportEntities(m.bim, input).map((entity) => entity.ref);
      if (refs.length === 0) {
        throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message: 'Export filters matched no entities - nothing to export.' });
      }
    }
    const content = m.bim.export.ifc(refs, { schema: schema as 'IFC2X3' | 'IFC4' | 'IFC4X3' });
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    await writeFile(filePath, text, 'utf-8');
    return okResult(
      `Wrote ${fmtInt(text.length)} bytes to ${filePath}.`,
      {
        filePath,
        bytes: text.length,
        schema,
        exportedCount: refs?.length ?? m.store.entityCount,
        ...(unmatched.length > 0 ? { unmatchedGlobalIds: unmatched } : {}),
      },
    );
  },
};

const exportCsv: Tool = {
  name: 'export_csv',
  description: 'Tabular property/quantity export. Columns may be plain attributes (Name, Type, GlobalId) or `Pset_X.Property` / `Qto_X.Quantity` paths.',
  scope: 'export',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      file_path: { type: 'string' },
      ...exportFilterProperties,
      columns: { type: 'array', items: { type: 'string' }, default: ['GlobalId', 'Type', 'Name'] },
      separator: { type: 'string', default: ',' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const cols = (input.columns as string[] | undefined) ?? ['GlobalId', 'Type', 'Name'];
    const sep = (input.separator as string | undefined) ?? ',';
    const refs = selectExportEntities(m.bim, input).map((entity) => entity.ref);
    const csv = m.bim.export.csv(refs, { columns: cols, separator: sep });
    if (typeof input.file_path === 'string') {
      const filePath = await resolveSafePath(input.file_path, ctx, 'write');
      await writeFile(filePath, csv, 'utf-8');
      return okResult(`Wrote ${fmtInt(csv.length)} bytes to ${filePath}.`, { filePath, rows: refs.length });
    }
    return okResult(`${refs.length} rows.`, { csv, rows: refs.length });
  },
};

const exportJson: Tool = {
  name: 'export_json',
  description: 'Structured JSON dump of attributes/properties/quantities for a type set.',
  scope: 'export',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      file_path: { type: 'string' },
      ...exportFilterProperties,
      columns: { type: 'array', items: { type: 'string' }, default: ['GlobalId', 'Type', 'Name'] },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const cols = (input.columns as string[] | undefined) ?? ['GlobalId', 'Type', 'Name'];
    const refs = selectExportEntities(m.bim, input).map((entity) => entity.ref);
    const rows = m.bim.export.json(refs, cols);
    if (typeof input.file_path === 'string') {
      const filePath = await resolveSafePath(input.file_path, ctx, 'write');
      const text = JSON.stringify(rows, null, 2);
      await writeFile(filePath, text, 'utf-8');
      return okResult(`Wrote ${rows.length} rows to ${filePath}.`, { filePath, rows: rows.length });
    }
    return okResult(`${rows.length} rows.`, { rows });
  },
};

const artifactFormats = {
  glb: { title: 'Export GLB', format: 'glb', label: 'GLB', mimeType: 'model/gltf-binary', counter: countGlbMeshes, unit: 'meshes' },
  gltf: { title: 'Export binary glTF', format: 'glb', label: 'GLB', mimeType: 'model/gltf-binary', counter: countGlbMeshes, unit: 'meshes' },
  obj: { title: 'Export OBJ', format: 'obj', label: 'OBJ', mimeType: 'model/obj', counter: countObjVertices, unit: 'vertices' },
  jsonld: { title: 'Export JSON-LD', format: 'jsonld', label: 'JSON-LD', mimeType: 'application/ld+json', counter: countJsonldNodes, unit: 'nodes' },
} as const;

function artifactTool(name: keyof typeof artifactFormats, description: string): Tool {
  const { title, format, label, mimeType, counter, unit } = artifactFormats[name];
  return {
    name: `export_${name}`,
    title,
    description,
    scope: 'export',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: {
      type: 'object',
      properties: { filePath: { type: 'string' }, bytes: { type: 'integer' } },
      required: ['filePath', 'bytes'],
      additionalProperties: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        model_id: { type: 'string', description: 'Loaded model ID. Defaults to the active model.' },
        file_path: { type: 'string', description: 'Output path inside the allowed paths.' },
        ...exportFilterProperties,
        ...(format === 'glb' ? {
          name_by_global_id: { type: 'boolean', description: 'Name glTF element nodes using IFC GlobalId.' },
        } : {}),
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    async handler(input, ctx) {
      const model = resolveModel(ctx, input.model_id as string | undefined);
      const filePath = await resolveSafePath(input.file_path, ctx, 'write');
      const isolated = exportIsolation(model.bim, input);
      const artifact = await withIfcBytes(model, async (bytes) => {
        const processor = new GeometryProcessor();
        try {
          await processor.init();
          const target = isolated
            ? `the matched ${typeof input.type === 'string' ? `${input.type} ` : ''}entities have`
            : 'the model has';
          const emptyMessage = `${label} export produced 0 ${unit} - ${target} no exportable content.`;
          const result = await refusingEmpty(
            () => exportRustArtifact(processor, format, bytes, isolated, input.name_by_global_id === true),
            counter,
            emptyMessage,
          );
          if (result == null) {
            throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: `${label} export produced no output.` });
          }
          return result;
        } finally {
          processor.dispose();
        }
      });
      ctx.signal.throwIfAborted();
      await writeFile(await resolveSafePath(filePath, ctx, 'write'), artifact);
      const result = okResult(`Wrote ${fmtInt(artifact.length)} bytes to ${filePath}.`, { filePath, bytes: artifact.length });
      if (name === 'gltf' || name === 'jsonld') {
        result.content.push({ type: 'resource_link', uri: pathToFileURL(filePath).href, name: basename(filePath), mimeType, size: artifact.length });
      }
      return result;
    },
  };
}

const exportGlb = artifactTool('glb', 'GLB export of model geometry as binary glTF.');
const exportGltf = artifactTool('gltf', 'glTF export of model geometry as a single binary .glb file, as in the CLI.');
const exportObj = artifactTool('obj', 'Wavefront OBJ export of model geometry with vertex normals.');
const exportJsonld = artifactTool('jsonld', 'JSON-LD export of the model graph with IFC properties.');

const exportIfcx: Tool = {
  name: 'export_ifcx',
  description: 'Save to .ifcx (IFC5 / USD-style node graph) via the Rust exporter: spatial hierarchy + classes + known IFC5 properties.',
  scope: 'export',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      file_path: { type: 'string' },
      all_properties: { type: 'boolean', description: 'Include properties without an IFC5 schema too (default: known-only).' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    return withIfcBytes(m, async (bytes) => {
      const gp = new GeometryProcessor();
      try {
        await gp.init();
        const ifcx = gp.exportIfcx(bytes, input.all_properties !== true, true);
        if (ifcx == null) {
          throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: 'IFCX export produced no output.' });
        }
        await writeFile(filePath, ifcx);
        return okResult(`Wrote ${fmtInt(ifcx.length)} bytes to ${filePath}.`, { filePath, bytes: ifcx.length });
      } finally {
        gp.dispose();
      }
    });
  },
};

const exportUsd: Tool = {
  name: 'export_usd',
  description: 'Save to .usda (OpenUSD ASCII) via the Rust exporter: a real Z-up USD stage — spatial hierarchy of Xform prims, UsdGeomMesh geometry, UsdPreviewSurface materials, and IFC metadata as custom attributes. Whole-model (geometry-backed); opens in usdview / Blender / Omniverse.',
  scope: 'export',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      file_path: { type: 'string' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    return withIfcBytes(m, async (bytes) => {
      const gp = new GeometryProcessor();
      try {
        await gp.init();
        const usd = await refusingEmpty(
          () => gp.exportUsd(bytes),
          countUsdMeshes,
          'USD export produced 0 meshes - the model has no exportable render geometry.',
        );
        if (usd == null) {
          throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: 'USD export produced no output.' });
        }
        await writeFile(filePath, usd);
        return okResult(`Wrote ${fmtInt(usd.length)} bytes to ${filePath}.`, { filePath, bytes: usd.length });
      } finally {
        gp.dispose();
      }
    });
  },
};

export const exportTools: Tool[] = [exportIfc, exportCsv, exportJson, exportGlb, exportGltf, exportObj, exportJsonld, exportIfcx, exportUsd, export3dmTool, ...cityAndEnergyExportTools];
