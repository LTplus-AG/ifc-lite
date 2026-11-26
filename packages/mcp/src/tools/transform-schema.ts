/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared metadata and guards for the file-writing transform tools. */

import type { JsonSchema, ToolAnnotations } from '../protocol/index.js';
import type { LoadedModel } from '../context.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';

/**
 * Writes a new file and leaves the loaded model alone; the same input writes
 * the same file. Loaded sources are refused as targets by `resolveSafePath`.
 */
export const FILE_WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const stringList: JsonSchema = { type: 'array', items: { type: 'string' } };

/**
 * `structuredContent` of a tool that wrote one file: `filePath` and `bytes`
 * always, plus the tool's own fields.
 */
export function fileOutputSchema(extra: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute path of the written file.' },
      bytes: { type: 'integer', description: 'Size of the written file in bytes.' },
      ...extra,
    },
    required: ['filePath', 'bytes'],
  };
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
