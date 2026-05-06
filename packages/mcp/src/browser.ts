/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-safe entrypoint for `@ifc-lite/mcp`.
 *
 * The web playground imports this file directly so it never pulls in any of
 * the Node-only modules:
 *   • loader.ts                  — uses node:fs to mmap .ifc files
 *   • viewer-manager.ts          — uses node:child_process to open browsers
 *   • transport/{stdio,http}.ts  — uses node:net + node:stream
 *   • tools/{validation,mutate,
 *           export,bcf}.ts       — uses node:fs/promises + node:path
 *
 * What we DO surface in the browser is the small kernel an in-page agent
 * needs to drive the same tool surface that the stdio CLI exposes:
 *   - `HeadlessLikeBackend`            — wraps a parsed `IfcDataStore` so
 *                                        `createBimContext({ backend })` from
 *                                        `@ifc-lite/sdk` returns a fully
 *                                        functional read-side BIM context.
 *   - error codes + types              — so the playground can mirror the
 *                                        wire-format error envelopes the
 *                                        Node MCP server emits.
 *   - protocol types                   — so message shapes stay in lockstep
 *                                        when the playground later switches
 *                                        from a custom dispatcher to the
 *                                        real MCP server in-process.
 *
 * Anything mutation/export/IDS related can be re-added to this entry once
 * those tools learn to write through a Blob-friendly virtual filesystem
 * (planned for v0.3 alongside the OAuth gateway).
 */

export { HeadlessLikeBackend, expandTypes, isProductType } from './headless-backend.js';
export { InMemoryModelRegistry } from './context.js';
export type {
  LoadedModel,
  ModelRegistry,
} from './context.js';
export { ToolErrorCode, ToolExecutionError, toolError } from './errors.js';
export type { ToolErrorCodeValue, ToolErrorOptions } from './errors.js';
export {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  JSONRPC_VERSION,
} from './protocol/types.js';
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
  CallToolResult,
} from './protocol/types.js';
