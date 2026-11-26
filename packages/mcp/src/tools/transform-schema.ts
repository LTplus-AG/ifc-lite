/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared metadata and guards for the file-writing transform tools. */

import type { ConversionLossEntry, IfcSchemaVersion } from '@ifc-lite/export';
import type { JsonSchema, ToolAnnotations } from '../protocol/index.js';
import type { LoadedModel, ToolContext } from '../context.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { rm, writeFile } from 'node:fs/promises';
import { resolveSafePath } from '../safe-path.js';
import { resolveModel } from './util.js';

/**
 * Writes a new file and leaves the loaded model alone, but replaces an
 * existing file at the target path. Loaded sources are refused as targets by
 * `resolveSafePath`.
 */
export const FILE_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

export const stringList: JsonSchema = { type: 'array', items: { type: 'string' } };

/**
 * `structuredContent` of a tool that wrote one file: `filePath` and `bytes`
 * plus the tool's own fields on success. An error result carries the shared
 * `{ code, message, details, hint }` payload (`toolError`), so the schema
 * declares those too and requires nothing: a client that validates error
 * results against it still passes. (No top-level `anyOf`: see validate.ts.)
 */
export function fileOutputSchema(extra: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute path of the written file.' },
      bytes: { type: 'integer', description: 'Size of the written file in bytes.' },
      ...extra,
      code: { type: 'string', description: 'Error results only: the error code.' },
      message: { type: 'string', description: 'Error results only.' },
      details: { type: 'object', description: 'Error results only.' },
      hint: { type: 'string', description: 'Error results only.' },
    },
    additionalProperties: false,
  };
}

/**
 * Refuse two outputs of one call that may be the same file. Compared without
 * case on macOS and Windows, whose default filesystems ignore it.
 */
export function requireDistinctPaths(a: string, b: string | null | undefined, name: string): void {
  if (b == null) return;
  const fold = (p: string) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);
  if (fold(a) === fold(b)) throw invalid(`${name} must differ from file_path.`);
}

/** The default filesystems of macOS and Windows ignore case. */
export const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/** A second output path argument: absent is null; present must be a non-empty string inside the allowed paths. */
export async function optionalOutputPath(input: Record<string, unknown>, key: string, ctx: ToolContext): Promise<string | null> {
  const raw = input[key];
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length === 0) throw invalid(`${key} must be a non-empty string.`);
  return resolveSafePath(raw, ctx, 'write');
}

/** Trimmed, non-blank selector tokens. */
export const nonBlank = (list: readonly string[] | undefined): string[] => (list ?? []).map((t) => t.trim()).filter(Boolean);

/** False for an IFC5 (IFCX) model, which the STEP transforms cannot read. */
export const isStepModel = (m: LoadedModel): boolean => m.store.schemaVersion !== 'IFC5';

/** Resolve a model for a transform; all of them read and write STEP, so an IFC5 (IFCX) model is refused by name. */
export function resolveStepModel(ctx: ToolContext, modelId: string | undefined, tool: string): LoadedModel {
  const m = resolveModel(ctx, modelId);
  if (!isStepModel(m)) {
    throw new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message: `${tool} reads IFC STEP; model '${m.id}' is IFC5 (IFCX).` });
  }
  return m;
}

/** The model's schema version, IFC4 when the file did not say. */
export const schemaOf = (m: LoadedModel): IfcSchemaVersion => (m.store.schemaVersion ?? 'IFC4') as IfcSchemaVersion;

/** `Wall` means `IfcWall`, as the CLI's `--type` reads it. */
export function withIfcPrefix(type: string): string {
  return /^ifc/i.test(type) ? type : `Ifc${type}`;
}

/** A conversion loss entry as the transform tools report it, in results and error details alike. */
export function lossEntryRow(e: ConversionLossEntry) {
  return {
    type: e.sourceType, targetType: e.targetType ?? null, kind: e.kind, count: e.count, droppedAttributes: e.droppedAttributes,
    // Records of one type that convert to different targets; the outer targetType is then the source type.
    ...(e.recordGroups ? { recordGroups: e.recordGroups.map((g) => ({ targetType: g.targetType ?? null, count: g.count, droppedAttributes: g.droppedAttributes })) } : {}),
  };
}

/** Stop before replacing an output file once the client cancelled the call. */
export function throwIfCancelled(ctx: ToolContext): void {
  if (ctx.signal.aborted) throw new ToolExecutionError({ code: ToolErrorCode.CANCELLED, message: 'Cancelled before the output was written.' });
}

/**
 * Write the second file of a two-file output after the first one landed. A
 * failure says the first file was already written, so the caller knows the
 * pair is mismatched.
 */
export async function writeSidecar(primary: string, sidecar: string, data: string, mode?: number): Promise<void> {
  try {
    // `mode` applies only when the file is created, so a restricted file is
    // removed first and created fresh, never rewritten under older permissions.
    if (mode !== undefined) await rm(sidecar, { force: true });
    await writeFile(sidecar, data, { encoding: 'utf-8', ...(mode !== undefined ? { mode, flag: 'wx' } : {}) });
  } catch (err) {
    throw new ToolExecutionError({
      code: ToolErrorCode.INTERNAL_ERROR,
      message: `Wrote ${primary}, but writing ${sidecar} failed: ${err instanceof Error ? err.message : String(err)}. The two files do not match.`,
    });
  }
}

export function invalid(message: string): ToolExecutionError {
  return new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message });
}

/** Store-backed transforms read the parsed source, so pending edits would be lost. */
export function requireNoPendingEdits(m: LoadedModel, tool: string): void {
  if (!m.backend.hasPendingChanges()) return;
  throw new ToolExecutionError({
    code: ToolErrorCode.UNSUPPORTED_OPERATION,
    message: `Model '${m.id}' has unsaved edits, which ${tool} would leave out. Write them with export_ifc, model_load the result, and run ${tool} on that.`,
  });
}
