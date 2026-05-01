/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/mcp — Model Context Protocol server for ifc-lite.
 *
 * Public surface:
 *   - createMCPServer({ ... }) — build an MCPServer with sane defaults.
 *   - StdioTransport / HttpTransport / InProcessTransport — wire I/O.
 *   - loadIfcModel(path) — parse a file into a LoadedModel for the registry.
 */

export { MCPServer, SERVER_NAME } from './server.js';
export type { MCPServerOptions, OutgoingMessageSink } from './server.js';

export type { LoadedModel, ModelRegistry, ServerConfig, ToolContext, Logger, ProgressReporter } from './context.js';
export { InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER, DEFAULT_CONFIG } from './context.js';

export { ToolErrorCode, ToolExecutionError, toolError } from './errors.js';
export type { ToolErrorCodeValue, ToolErrorOptions } from './errors.js';

export * from './protocol/index.js';
export * from './auth/index.js';

export { ToolRegistry, buildDefaultToolRegistry } from './tools/index.js';
export type { Tool } from './tools/index.js';

export { ResourceRegistry, buildDefaultResourceRegistry } from './resources/index.js';
export type { ResourceProvider } from './resources/index.js';

export { PromptRegistry, buildDefaultPromptRegistry } from './prompts/index.js';
export type { Prompt } from './prompts/index.js';

export { StdioTransport } from './transport/stdio.js';
export { InProcessTransport } from './transport/in-process.js';
export { HttpTransport, BearerTokenAuth, AllowAllAuth } from './transport/http.js';
export type { HttpTransportOptions, HttpAuthenticator, SessionFactory } from './transport/http.js';

export { loadIfcModel } from './loader.js';
export type { LoadIfcOptions } from './loader.js';
export { HeadlessLikeBackend } from './headless-backend.js';

import { MCPServer, type MCPServerOptions } from './server.js';
import { buildDefaultToolRegistry } from './tools/index.js';
import { buildDefaultResourceRegistry } from './resources/index.js';
import { buildDefaultPromptRegistry } from './prompts/index.js';

export const VERSION = '0.1.0';

/**
 * Build an MCPServer pre-loaded with every tool/resource/prompt category.
 * The caller can still pass a custom `ToolRegistry`, etc., to override.
 */
export function createMCPServer(opts: Partial<MCPServerOptions> = {}): MCPServer {
  return new MCPServer({
    name: opts.name ?? 'ifc-lite',
    version: opts.version ?? VERSION,
    registry: opts.registry,
    scope: opts.scope,
    config: opts.config,
    logger: opts.logger,
    capabilities: opts.capabilities,
    tools: opts.tools ?? buildDefaultToolRegistry(),
    resources: opts.resources ?? buildDefaultResourceRegistry(),
    prompts: opts.prompts ?? buildDefaultPromptRegistry(),
  });
}
