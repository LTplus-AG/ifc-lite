/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared metadata and guards for the file-writing transform tools. */

import type { ConversionLossEntry, IfcSchemaVersion } from '@ifc-lite/export';
import type { JsonSchema, ToolAnnotations } from '../protocol/index.js';
import type { LoadedModel, ToolContext } from '../context.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { rm, stat, writeFile } from 'node:fs/promises';
import { resolveSafePath } from '../safe-path.js';
import { modelAllowed, scopeAllows } from '../auth/scope.js';
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
  if (outputPathKey(a) === outputPathKey(b)) throw invalid(`${name} must differ from file_path.`);
}

/** The default filesystems of macOS and Windows ignore case. */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

const outputPathKey = (path: string): string =>
  CASE_INSENSITIVE_FS ? path.normalize('NFC').toLowerCase() : path;

/** A second output path argument: absent is null; present must be a non-empty string inside the allowed paths. */
export async function optionalOutputPath(input: Record<string, unknown>, key: string, ctx: ToolContext): Promise<string | null> {
  const raw = input[key];
  if (raw == null) return null; // null and absent mean the same, as in validate.ts
  if (typeof raw !== 'string' || raw.length === 0) throw invalid(`${key} must be a non-empty string.`);
  return resolveSafePath(raw, ctx, 'write');
}

/** Trimmed, non-blank selector tokens. */
export const nonBlank = (list: readonly unknown[] | undefined): string[] =>
  (list ?? []).filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean);

/** False for an IFC5 (IFCX) model, which the STEP transforms cannot read. */
export const isStepModel = (m: LoadedModel): boolean => m.store.schemaVersion !== 'IFC5';

/** Resolve a model for a transform; all of them read and write STEP, so an IFC5 (IFCX) model is refused by name. */
export function resolveStepModel(ctx: ToolContext, modelId: string | undefined, tool: string): LoadedModel {
  const m = resolveModel(ctx, modelId);
  if (!isStepModel(m)) {
    throw unsupported(`${tool} reads IFC STEP; model '${m.id}' is IFC5 (IFCX).`);
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

/**
 * Last check before a transform writes its output: the call was not cancelled,
 * and the live scope still allows exporting these models. The handler may have
 * awaited source materialization since dispatch, and a scope change in that
 * window must not let the write through.
 */
function beforeWrite(ctx: ToolContext, ...models: LoadedModel[]): void {
  if (ctx.signal.aborted) throw new ToolExecutionError({ code: ToolErrorCode.CANCELLED, message: 'Cancelled before the output was written.' });
  const scope = ctx.currentScope?.() ?? ctx.scope;
  for (const m of models) {
    if (!scopeAllows(scope, 'export') || !modelAllowed(scope, m.id)) {
      throw new ToolExecutionError({ code: ToolErrorCode.PERMISSION_DENIED, message: `Access to model '${m.id}' was withdrawn before the output was written.` });
    }
  }
}

const activeOutputs = new Set<string>();

async function outputInode(path: string): Promise<string | undefined> {
  try {
    const { dev, ino } = await stat(path, { bigint: true });
    return `inode:${dev}:${ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

/** Reserve transform destinations and recheck live access before each write. */
export async function writeTransformOutput(
  ctx: ToolContext,
  models: readonly LoadedModel[],
  primary: string,
  content: Uint8Array,
  sidecar?: { path: string; argument: string; data: string; mode?: number },
  beforePrimary?: () => void,
): Promise<void> {
  const paths = sidecar ? [primary, sidecar.path] : [primary];
  const inodes = await Promise.all(paths.map(outputInode));
  if (sidecar && inodes[0] !== undefined && inodes[0] === inodes[1]) {
    throw invalid(`${sidecar.argument} must differ from file_path.`);
  }
  const keys = [...paths.map(outputPathKey), ...inodes.filter((inode) => inode !== undefined)];
  if (keys.some((key) => activeOutputs.has(key))) throw invalid('Another transform is writing to one of these paths.');
  for (const key of keys) activeOutputs.add(key);
  try {
    beforeWrite(ctx, ...models);
    beforePrimary?.();
    await writeFile(primary, content);
    if (!sidecar) return;
    try {
      beforeWrite(ctx, ...models);
      // The owner-only map needs a fresh inode. Setting the mode on an
      // existing file would preserve its old permissions.
      if (sidecar.mode !== undefined) {
        await rm(sidecar.path, { force: true });
        beforeWrite(ctx, ...models);
      }
      await writeFile(sidecar.path, sidecar.data, {
        encoding: 'utf-8',
        ...(sidecar.mode !== undefined ? { mode: sidecar.mode, flag: 'wx' } : {}),
      });
    } catch (error) {
      throw new ToolExecutionError({
        code: error instanceof ToolExecutionError ? error.code : ToolErrorCode.INTERNAL_ERROR,
        message: `Wrote ${primary}, but writing ${sidecar.path} failed: ${error instanceof Error ? error.message : String(error)}. The two files do not match.`,
      });
    }
  } finally {
    for (const key of keys) activeOutputs.delete(key);
  }
}

/** The model or its state cannot take this operation (as opposed to a bad argument). */
export function unsupported(message: string, details?: Record<string, unknown>): ToolExecutionError {
  return new ToolExecutionError({ code: ToolErrorCode.UNSUPPORTED_OPERATION, message, ...(details ? { details } : {}) });
}

export function invalid(message: string): ToolExecutionError {
  return new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, message });
}

/**
 * Express ids name records of the source file. With edits pending, the
 * byte-backed transforms read a re-serialized export whose ids need not match,
 * so a selection by express id is refused. `what` names the offending input.
 */
export function refuseSourceIdsWhilePending(
  m: LoadedModel, what: string, recovery = 'select by GlobalId or name, or write the edits with export_ifc and model_load the result first',
): void {
  if (!m.backend.hasPendingChanges()) return;
  throw invalid(`${what} names records of the source file by express id; with unsaved edits pending, ${recovery}.`);
}

/** Store-backed transforms copy records from the parsed source; a model that kept none cannot be used. */
export function requireSourceBytes(m: LoadedModel, tool: string): void {
  if (m.store.source.byteLength === 0) throw unsupported(`Model '${m.id}' kept no source bytes for ${tool}. Reload it with model_load.`);
}

/** Store-backed transforms read the parsed source, so pending edits would be lost. */
export function requireNoPendingEdits(m: LoadedModel, tool: string): void {
  if (!m.backend.hasPendingChanges()) return;
  throw unsupported(`Model '${m.id}' has unsaved edits, which ${tool} would leave out. Write them with export_ifc, model_load the result, and run ${tool} on that.`);
}
