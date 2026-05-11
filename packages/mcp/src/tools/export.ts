/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export tools (spec §7.9).
 *
 * `export_ifc` writes a STEP file (with any pending mutations applied),
 * `export_csv` and `export_json` produce tabular dumps, `export_glb` and
 * `export_pdf_report` are stubbed pending the WASM geometry & PDF stack.
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { EntityRef } from '@ifc-lite/sdk';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

function checkPath(filePath: string, allowed?: string[]): void {
  if (!allowed || allowed.length === 0) return;
  const ok = allowed.some((p) => filePath === p || filePath.startsWith(p + '/'));
  if (!ok) {
    throw new ToolExecutionError({
      code: ToolErrorCode.PERMISSION_DENIED,
      message: `Path '${filePath}' outside allowed roots`,
    });
  }
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
    const filePath = resolve(input.file_path as string);
    checkPath(filePath, ctx.config.allowedPaths);
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
      const filePath = resolve(input.file_path);
      checkPath(filePath, ctx.config.allowedPaths);
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
      const filePath = resolve(input.file_path);
      checkPath(filePath, ctx.config.allowedPaths);
      const text = JSON.stringify(rows, null, 2);
      await writeFile(filePath, text, 'utf-8');
      return okResult(`Wrote ${rows.length} rows to ${filePath}.`, { filePath, rows: rows.length });
    }
    return okResult(`${rows.length} rows.`, { rows });
  },
};

const exportGlb: Tool = {
  name: 'export_glb',
  description: 'Geometry-only glTF binary export. Requires the WASM geometry pipeline.',
  scope: 'export',
  inputSchema: { type: 'object', properties: { model_id: { type: 'string' }, file_path: { type: 'string' } }, additionalProperties: false },
  handler() {
    throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: 'export_glb requires the WASM geometry pipeline (planned for v0.2).',
    });
  },
};

const exportIfcx: Tool = {
  name: 'export_ifcx',
  description: 'Save to .ifcx (IFC5). Planned for v0.2.',
  scope: 'export',
  inputSchema: { type: 'object', properties: { model_id: { type: 'string' }, file_path: { type: 'string' } }, additionalProperties: false },
  handler() {
    throw new ToolExecutionError({
      code: ToolErrorCode.UNSUPPORTED_OPERATION,
      message: 'export_ifcx is planned for v0.2.',
    });
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

export const exportTools: Tool[] = [exportIfc, exportCsv, exportJson, exportGlb, exportIfcx, exportPdfReport];
