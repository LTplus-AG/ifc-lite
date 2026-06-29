/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export tools (spec §7.9).
 *
 * `export_ifc` writes a STEP file (with any pending mutations applied),
 * `export_csv` and `export_json` produce tabular dumps, and `export_glb` /
 * `export_obj` export geometry via the Rust mesh pipeline (wasm, headless).
 * `export_ifcx` and `export_pdf_report` remain stubbed pending the IFC5 / PDF stack.
 */

import { writeFile, readFile } from 'node:fs/promises';
import type { EntityRef } from '@ifc-lite/sdk';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { countGlbMeshes } from '@ifc-lite/export';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { resolveSafePath } from '../safe-path.js';

/** Raw IFC bytes for the wasm exporters: prefer in-memory source, fall back to disk. */
async function resolveIfcBytes(m: ReturnType<typeof resolveModel>): Promise<Uint8Array> {
  if (m.store.source && m.store.source.byteLength > 0) return m.store.source;
  if (m.filePath) return readFile(m.filePath);
  throw new ToolExecutionError({
    code: ToolErrorCode.UNSUPPORTED_OPERATION,
    message: 'Model has no in-memory source bytes and no file path to re-read for export.',
  });
}

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
      global_ids: { type: 'array', items: { type: 'string' }, description: 'Optional GlobalId allowlist; defaults to the whole model.' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    const schema = (input.schema as 'IFC2X3' | 'IFC4' | 'IFC4X3' | undefined) ?? m.store.schemaVersion;
    let refs: EntityRef[] = [];
    if (Array.isArray(input.global_ids)) {
      const wanted = new Set(input.global_ids as string[]);
      for (const e of m.bim.query().toArray()) if (wanted.has(e.globalId)) refs.push(e.ref);
    }
    const content = m.bim.export.ifc(refs, { schema: schema as 'IFC2X3' | 'IFC4' | 'IFC4X3' });
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    await writeFile(filePath, text, 'utf-8');
    return okResult(
      `Wrote ${text.length.toLocaleString()} bytes to ${filePath}.`,
      { filePath, bytes: text.length, schema, exportedCount: refs.length || m.store.entityCount },
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
      type: { type: 'string', description: 'Filter by IFC type (default: all products).' },
      columns: { type: 'array', items: { type: 'string' }, default: ['GlobalId', 'Type', 'Name'] },
      separator: { type: 'string', default: ',' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const cols = (input.columns as string[] | undefined) ?? ['GlobalId', 'Type', 'Name'];
    const sep = (input.separator as string | undefined) ?? ',';
    const filterType = input.type as string | undefined;
    const refs = (filterType ? m.bim.query().byType(filterType).toArray() : m.bim.query().toArray()).map((e) => e.ref);
    const csv = m.bim.export.csv(refs, { columns: cols, separator: sep });
    if (typeof input.file_path === 'string') {
      const filePath = await resolveSafePath(input.file_path, ctx, 'write');
      await writeFile(filePath, csv, 'utf-8');
      return okResult(`Wrote ${csv.length.toLocaleString()} bytes to ${filePath}.`, { filePath, rows: refs.length });
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
      type: { type: 'string' },
      columns: { type: 'array', items: { type: 'string' }, default: ['GlobalId', 'Type', 'Name'] },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const cols = (input.columns as string[] | undefined) ?? ['GlobalId', 'Type', 'Name'];
    const filterType = input.type as string | undefined;
    const refs = (filterType ? m.bim.query().byType(filterType).toArray() : m.bim.query().toArray()).map((e) => e.ref);
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

const exportGlb: Tool = {
  name: 'export_glb',
  description: 'Geometry-only glTF binary (GLB) export via the Rust mesh pipeline. Optional `type` filter isolates one IFC class.',
  scope: 'export',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      file_path: { type: 'string' },
      type: { type: 'string', description: 'Optional IFC type to isolate (e.g. IfcWall).' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    const filterType = input.type as string | undefined;
    const isolated = filterType
      ? new Uint32Array(m.bim.query().byType(filterType).toArray().map((e) => e.ref.expressId))
      : new Uint32Array();
    // An empty isolation set means "export everything" to the Rust mesher, so a
    // `type` filter that matched nothing would silently export the WHOLE model
    // and report success. Fail loud instead, mirroring the CLI guard.
    if (filterType && isolated.length === 0) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `No ${filterType} entities found - nothing to export.`,
      });
    }
    const bytes = await resolveIfcBytes(m);
    const gp = new GeometryProcessor();
    await gp.init();
    try {
      const glb = gp.exportGlb(bytes, false, new Uint32Array(), isolated, '');
      if (glb == null) {
        throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: 'GLB export produced no output.' });
      }
      // A structurally valid GLB with zero meshes means nothing had render
      // geometry — fail loud instead of writing an empty file as success.
      if (countGlbMeshes(glb) === 0) {
        throw new ToolExecutionError({
          code: ToolErrorCode.INTERNAL_ERROR,
          message: filterType
            ? `GLB export produced 0 meshes — no ${filterType} elements have exportable render geometry.`
            : 'GLB export produced 0 meshes — the model has no exportable render geometry.',
        });
      }
      await writeFile(filePath, glb);
      return okResult(`Wrote ${glb.length.toLocaleString()} bytes to ${filePath}.`, { filePath, bytes: glb.length });
    } finally {
      gp.dispose();
    }
  },
};

const exportObj: Tool = {
  name: 'export_obj',
  description: 'Geometry-only Wavefront OBJ export via the Rust mesh pipeline. Optional `type` filter isolates one IFC class.',
  scope: 'export',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      file_path: { type: 'string' },
      type: { type: 'string', description: 'Optional IFC type to isolate (e.g. IfcWall).' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    const filterType = input.type as string | undefined;
    const isolated = filterType
      ? new Uint32Array(m.bim.query().byType(filterType).toArray().map((e) => e.ref.expressId))
      : new Uint32Array();
    // An empty isolation set means "export everything" to the Rust mesher, so a
    // `type` filter that matched nothing would silently export the WHOLE model
    // and report success. Fail loud instead, mirroring the CLI guard.
    if (filterType && isolated.length === 0) {
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `No ${filterType} entities found - nothing to export.`,
      });
    }
    const bytes = await resolveIfcBytes(m);
    const gp = new GeometryProcessor();
    await gp.init();
    try {
      const obj = gp.exportObj(bytes, true, new Uint32Array(), isolated);
      if (obj == null) {
        throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: 'OBJ export produced no output.' });
      }
      await writeFile(filePath, obj, 'utf-8');
      return okResult(`Wrote ${obj.length.toLocaleString()} bytes to ${filePath}.`, { filePath, bytes: obj.length });
    } finally {
      gp.dispose();
    }
  },
};

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
    const bytes = await resolveIfcBytes(m);
    const gp = new GeometryProcessor();
    await gp.init();
    try {
      const ifcx = gp.exportIfcx(bytes, input.all_properties !== true, true);
      if (ifcx == null) {
        throw new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: 'IFCX export produced no output.' });
      }
      await writeFile(filePath, ifcx, 'utf-8');
      return okResult(`Wrote ${ifcx.length.toLocaleString()} bytes to ${filePath}.`, { filePath, bytes: ifcx.length });
    } finally {
      gp.dispose();
    }
  },
};

const exportPdfReport: Tool = {
  name: 'export_pdf_report',
  description: 'Audit/IDS report as PDF. Planned for v0.5.',
  scope: 'export',
  inputSchema: { type: 'object', properties: { model_id: { type: 'string' }, file_path: { type: 'string' } }, additionalProperties: false },
  handler() {
    throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: 'export_pdf_report is planned for v0.5.',
    });
  },
};

export const exportTools: Tool[] = [exportIfc, exportCsv, exportJson, exportGlb, exportObj, exportIfcx, exportPdfReport];
