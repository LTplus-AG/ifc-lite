/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * MCPServer — the central JSON-RPC router.
 *
 * Responsibilities:
 *   - track initialization handshake
 *   - dispatch `tools/list`, `tools/call`, `resources/list`, `resources/read`,
 *     `prompts/list`, `prompts/get`, `ping`, `notifications/initialized`,
 *     `notifications/cancelled`
 *   - filter tool advertisement by auth scope
 *   - validate tool input against the tool's JSON schema
 *   - turn thrown ToolExecutionError into structured tool results (NOT JSON-RPC errors)
 *
 * Transport-agnostic: `connect(transport)` is the only I/O hook. The transport
 * pushes incoming JSON-RPC messages via `handleMessage` and gets back zero or
 * one outgoing messages plus any progress/log notifications routed through
 * the `OutgoingMessageSink` contract.
 */

import {
  CallToolParams,
  CallToolResult,
  GetPromptParams,
  GetPromptResult,
  InitializeParams,
  InitializeResult,
  JsonRpcErrorCode,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  ListPromptsResult,
  ListResourcesResult,
  ListToolsResult,
  PROTOCOL_VERSION,
  ProgressNotification,
  ReadResourceParams,
  ReadResourceResult,
  ServerCapabilities,
  SubscribeParams,
  ToolDefinition,
} from './protocol/index.js';
import {
  errorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  notification,
  successResponse,
} from './protocol/jsonrpc.js';
import {
  AuthScope,
  fullScope,
  modelAllowed,
  scopeAllows,
} from './auth/scope.js';
import {
  DEFAULT_CONFIG,
  InMemoryModelRegistry,
  Logger,
  ModelRegistry,
  ProgressReporter,
  SILENT_LOGGER,
  ServerConfig,
  ToolContext,
} from './context.js';
import { ToolExecutionError, ToolErrorCode, toolError } from './errors.js';
import { PromptRegistry } from './prompts/types.js';
import { ResourceRegistry } from './resources/types.js';
import { ToolRegistry } from './tools/types.js';
import { validateInput } from './validate.js';
import { ViewerManager } from './viewer-manager.js';

export const SERVER_NAME = 'ifc-lite-mcp';

export interface OutgoingMessageSink {
  send(message: JsonRpcMessage): Promise<void> | void;
}

export interface MCPServerOptions {
  name?: string;
  version: string;
  registry?: ModelRegistry;
  scope?: AuthScope;
  config?: Partial<ServerConfig>;
  tools: ToolRegistry;
  resources: ResourceRegistry;
  prompts: PromptRegistry;
  logger?: Logger;
  /** Override which capabilities are advertised. */
  capabilities?: ServerCapabilities;
  /** Optional pre-built viewer manager. Default: a fresh one bound to the registry. */
  viewer?: ViewerManager;
}

export class MCPServer {
  readonly name: string;
  readonly version: string;
  readonly registry: ModelRegistry;
  readonly tools: ToolRegistry;
  readonly resources: ResourceRegistry;
  readonly prompts: PromptRegistry;
  readonly config: ServerConfig;
  readonly viewer: ViewerManager;

  private scope: AuthScope;
  private logger: Logger;
  private capabilities: ServerCapabilities;
  private initialized = false;
  private sink: OutgoingMessageSink | null = null;
  /** Active tool calls keyed by JSON-RPC id, used for cancellation. */
  private active = new Map<string | number, AbortController>();
  /** Currently subscribed resource URIs (for `notifications/resources/updated`). */
  private subscriptions = new Set<string>();

  constructor(opts: MCPServerOptions) {
    this.name = opts.name ?? SERVER_NAME;
    this.version = opts.version;
    this.registry = opts.registry ?? new InMemoryModelRegistry();
    this.scope = opts.scope ?? fullScope();
    this.config = { ...DEFAULT_CONFIG, ...(opts.config ?? {}) };
    this.tools = opts.tools;
    this.resources = opts.resources;
    this.prompts = opts.prompts;
    this.logger = opts.logger ?? SILENT_LOGGER;
    this.capabilities = opts.capabilities ?? {
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: false },
      logging: {},
    };
    this.viewer = opts.viewer ?? new ViewerManager((id) => (id ? this.registry.get(id) : null));
    // Selection changes ripple out as resource updates so subscribed agents
    // see live picks without polling.
    this.viewer.onSelection((_sel, model) => {
      const uri = model
        ? `ifc-lite://model/${model.id}/viewer/selection`
        : 'ifc-lite://viewer/selection';
      this.notifyResourceUpdated(uri);
      this.notifyResourceUpdated('ifc-lite://viewer/selection');
    });
  }

  /** Attach an outgoing-message sink. Required before handling messages. */
  attach(sink: OutgoingMessageSink): void {
    this.sink = sink;
  }

  detach(): void {
    this.sink = null;
    this.active.forEach((c) => c.abort());
    this.active.clear();
    // The viewer holds an HTTP server + SSE listener; closing it stops
    // dangling sockets when the transport disconnects.
    if (this.viewer.isOpen()) this.viewer.close();
  }

  /** Update the auth scope mid-session (e.g. token refresh). */
  setScope(scope: AuthScope): void {
    this.scope = scope;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Process a single inbound JSON-RPC message. Returns the response (if any)
   * or null for notifications. Side-effect notifications (progress, log) flow
   * through the attached sink, not the return value.
   */
  async handleMessage(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    if (isJsonRpcRequest(message)) {
      return this.handleRequest(message);
    }
    if (isJsonRpcNotification(message)) {
      await this.handleNotification(message);
      return null;
    }
    // Responses to server-initiated requests would land here; v0.1 has no
    // server-initiated requests so we just drop them.
    return null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Request dispatch
  // ────────────────────────────────────────────────────────────────────────

  private async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    try {
      // initialize/ping always allowed regardless of init state.
      if (req.method === 'initialize') {
        return successResponse(req.id, this.handleInitialize(req.params as InitializeParams));
      }
      if (req.method === 'ping') {
        return successResponse(req.id, {});
      }

      if (!this.initialized) {
        return errorResponse(
          req.id,
          JsonRpcErrorCode.ServerNotInitialized,
          'Server not initialized — send `initialize` first',
        );
      }

      switch (req.method) {
        case 'tools/list':
          return successResponse(req.id, this.handleListTools());
        case 'tools/call':
          return successResponse(req.id, await this.handleCallTool(req));
        case 'resources/list':
          return successResponse(req.id, await this.handleListResources());
        case 'resources/read':
          return successResponse(req.id, await this.handleReadResource(req.params as ReadResourceParams));
        case 'resources/subscribe':
          this.subscriptions.add((req.params as SubscribeParams).uri);
          return successResponse(req.id, {});
        case 'resources/unsubscribe':
          this.subscriptions.delete((req.params as SubscribeParams).uri);
          return successResponse(req.id, {});
        case 'prompts/list':
          return successResponse(req.id, this.handleListPrompts());
        case 'prompts/get':
          return successResponse(req.id, await this.handleGetPrompt(req.params as GetPromptParams));
        default:
          return errorResponse(req.id, JsonRpcErrorCode.MethodNotFound, `Unknown method: ${req.method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.log('error', `Request ${req.method} failed`, { error: message });
      return errorResponse(req.id, JsonRpcErrorCode.InternalError, message);
    }
  }

  private async handleNotification(note: { method: string; params?: unknown }): Promise<void> {
    switch (note.method) {
      case 'notifications/initialized':
        // Some clients send this AFTER `initialize`. Already initialized in the
        // success path; this notification is just a confirmation.
        this.initialized = true;
        return;
      case 'notifications/cancelled': {
        const params = note.params as { requestId?: string | number; reason?: string } | undefined;
        if (params?.requestId !== undefined) {
          const ctl = this.active.get(params.requestId);
          if (ctl) {
            ctl.abort();
            this.active.delete(params.requestId);
            this.logger.log('info', `Cancelled request ${params.requestId}`, { reason: params.reason });
          }
        }
        return;
      }
      default:
        this.logger.log('debug', `Ignored notification ${note.method}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // initialize
  // ────────────────────────────────────────────────────────────────────────

  private handleInitialize(params: InitializeParams): InitializeResult {
    this.initialized = true;
    this.logger.log('info', 'initialize', {
      client: params.clientInfo,
      protocol: params.protocolVersion,
    });
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: this.capabilities,
      serverInfo: { name: this.name, version: this.version },
      instructions: SERVER_INSTRUCTIONS,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // tools/*
  // ────────────────────────────────────────────────────────────────────────

  private handleListTools(): ListToolsResult {
    const visible = this.tools.list().filter((t) => scopeAllows(this.scope, t.scope));
    if (this.config.readOnly) {
      // belt-and-suspenders: even if a token claims `mutate`, hide mutation
      // tools when the server was started --read-only.
      const tools: ToolDefinition[] = visible
        .filter((t) => t.scope !== 'mutate')
        .map(toToolDefinition);
      return { tools };
    }
    const tools: ToolDefinition[] = visible.map(toToolDefinition);
    return { tools };
  }

  private async handleCallTool(req: JsonRpcRequest): Promise<CallToolResult> {
    const params = req.params as CallToolParams;
    const tool = this.tools.get(params.name);
    if (!tool) {
      return toolError({
        code: ToolErrorCode.UNSUPPORTED_OPERATION,
        message: `Unknown tool: ${params.name}`,
        hint: 'Use `tools/list` to discover available tools.',
      });
    }
    if (!scopeAllows(this.scope, tool.scope)) {
      return toolError({
        code: ToolErrorCode.PERMISSION_DENIED,
        message: `Tool '${params.name}' requires scope '${tool.scope}'`,
        details: { required: tool.scope, granted: this.scope.scopes },
      });
    }
    if (this.config.readOnly && tool.scope === 'mutate') {
      return toolError({
        code: ToolErrorCode.READ_ONLY,
        message: `Server started in read-only mode; '${params.name}' rejected.`,
      });
    }

    const validation = validateInput(tool.inputSchema, params.arguments ?? {});
    if (!validation.valid) {
      return toolError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `Input validation failed for ${params.name}`,
        details: { errors: validation.errors },
        hint: 'Inspect `details.errors` for the offending field paths.',
      });
    }

    const ctl = new AbortController();
    this.active.set(req.id, ctl);
    const progressToken = params._meta?.progressToken;
    const progress = this.makeProgress(progressToken);
    const ctx: ToolContext = {
      registry: this.registry,
      scope: this.scope,
      progress,
      log: this.logger,
      signal: ctl.signal,
      config: this.config,
      viewer: this.viewer,
    };

    const startedAt = Date.now();
    try {
      const result = await tool.handler(validation.value as Record<string, unknown>, ctx);
      this.logger.log('info', `tools/call ${params.name}`, {
        latencyMs: Date.now() - startedAt,
        isError: result.isError === true,
      });
      return result;
    } catch (err) {
      this.logger.log('error', `tools/call ${params.name} threw`, {
        error: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof ToolExecutionError) return err.toToolResult();
      return toolError({
        code: ToolErrorCode.INTERNAL_ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.active.delete(req.id);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // resources/*
  // ────────────────────────────────────────────────────────────────────────

  private async handleListResources(): Promise<ListResourcesResult> {
    const ctx = this.makeResourceContext();
    const resources = await this.resources.list(ctx);
    return { resources };
  }

  private async handleReadResource(params: ReadResourceParams): Promise<ReadResourceResult> {
    const provider = this.resources.matchProvider(params.uri);
    if (!provider) {
      throw new ToolExecutionError({
        code: ToolErrorCode.UNSUPPORTED_OPERATION,
        message: `No resource provider matches URI: ${params.uri}`,
      });
    }
    const ctx = this.makeResourceContext();
    const contents = await provider.read(params.uri, ctx);
    return { contents };
  }

  // ────────────────────────────────────────────────────────────────────────
  // prompts/*
  // ────────────────────────────────────────────────────────────────────────

  private handleListPrompts(): ListPromptsResult {
    return { prompts: this.prompts.list() };
  }

  private async handleGetPrompt(params: GetPromptParams): Promise<GetPromptResult> {
    const prompt = this.prompts.get(params.name);
    if (!prompt) {
      throw new ToolExecutionError({
        code: ToolErrorCode.UNSUPPORTED_OPERATION,
        message: `Unknown prompt: ${params.name}`,
      });
    }
    const ctx = this.makeResourceContext();
    return prompt.render(params.arguments ?? {}, ctx);
  }

  // ────────────────────────────────────────────────────────────────────────
  // helpers
  // ────────────────────────────────────────────────────────────────────────

  private makeResourceContext(): ToolContext {
    return {
      registry: this.registry,
      scope: this.scope,
      progress: { report() { /* no progress for resource/prompt access */ } },
      log: this.logger,
      signal: new AbortController().signal,
      config: this.config,
      viewer: this.viewer,
    };
  }

  private makeProgress(token: string | number | undefined): ProgressReporter {
    if (token === undefined || !this.sink) {
      return { report() { /* no token => silent */ } };
    }
    const sink = this.sink;
    return {
      report: (progress, message, total) => {
        const note: ProgressNotification = { progressToken: token, progress };
        if (total !== undefined) note.total = total;
        if (message !== undefined) note.message = message;
        void sink.send(notification('notifications/progress', note));
      },
    };
  }

  /** Broadcast a `notifications/resources/updated` to subscribers. */
  notifyResourceUpdated(uri: string): void {
    if (!this.sink) return;
    if (!this.subscriptions.has(uri)) return;
    void this.sink.send(notification('notifications/resources/updated', { uri }));
  }

  /** Notify clients that the tool list has changed (e.g., after model load). */
  notifyToolsChanged(): void {
    if (!this.sink) return;
    void this.sink.send(notification('notifications/tools/list_changed', {}));
  }

  /** Read-only access to the auth scope for transports that need to gate access. */
  hasModelAccess(modelId: string): boolean {
    return modelAllowed(this.scope, modelId);
  }
}

function toToolDefinition(tool: { name: string; description: string; inputSchema: unknown; scope?: string }): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as ToolDefinition['inputSchema'],
    scope: tool.scope as ToolDefinition['scope'],
  };
}

const SERVER_INSTRUCTIONS = `
ifc-lite-mcp exposes a federated set of IFC/BIM models as MCP tools.

Conventions:
  • All tools accept an optional model_id; when only one model is loaded it can be omitted.
  • Errors surface as tool results with isError=true and structuredContent.code (e.g. ENTITY_NOT_FOUND).
  • Long operations stream progress via notifications/progress when a progressToken is supplied.
  • Mutations are queued; call export_ifc or model_save to persist.

See the resource ifc-lite://server/manifest for the full tool catalog.
`.trim();
