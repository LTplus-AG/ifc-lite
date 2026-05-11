/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stable error codes for tool results.
 *
 * Critical: these are surfaced as `structuredContent.code` on tool results
 * with `isError: true` — NEVER as JSON-RPC errors. That lets the LLM read
 * and react to the failure inline rather than aborting the chain.
 */

import type { CallToolResult } from './protocol/index.js';

export const ToolErrorCode = {
  ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_REQUIRED: 'MODEL_REQUIRED',
  INVALID_INPUT: 'INVALID_INPUT',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  READ_ONLY: 'READ_ONLY',
  PARSE_FAILED: 'PARSE_FAILED',
  EXTERNAL_SERVICE_FAILED: 'EXTERNAL_SERVICE_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ToolErrorCodeValue = typeof ToolErrorCode[keyof typeof ToolErrorCode];

export interface ToolErrorOptions {
  code: ToolErrorCodeValue;
  message: string;
  details?: Record<string, unknown>;
  hint?: string;
}

export function toolError(opts: ToolErrorOptions): CallToolResult {
  return {
    content: [{ type: 'text', text: opts.message }],
    structuredContent: {
      code: opts.code,
      message: opts.message,
      details: opts.details ?? {},
      hint: opts.hint,
    },
    isError: true,
  };
}

export class ToolExecutionError extends Error {
  readonly code: ToolErrorCodeValue;
  readonly details?: Record<string, unknown>;
  readonly hint?: string;

  constructor(opts: ToolErrorOptions) {
    super(opts.message);
    this.name = 'ToolExecutionError';
    this.code = opts.code;
    this.details = opts.details;
    this.hint = opts.hint;
  }

  toToolResult(): CallToolResult {
    return toolError({
      code: this.code,
      message: this.message,
      details: this.details,
      hint: this.hint,
    });
  }
}
