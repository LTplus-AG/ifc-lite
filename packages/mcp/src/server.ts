/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * MCPServer — the domain module behind every MCP transport.
 *
 * It owns what the server means: the tool, resource and prompt registries,
 * auth scope and the read-only gate, input validation, the structured error
 * envelope, the model registry and the viewer. The wire protocol (JSON-RPC
 * framing, initialize and version negotiation, spec schema validation,
 * cancellation, notification encoding) is the official MCP SDK's, reached
 * through the adapter in `sdk/protocol-session.ts`.
 *
 * Transport-agnostic: a transport calls `attach(sink)`, pushes each inbound
 * message through `handleMessage`, writes the returned response, and gets
 * progress, log and list_changed notifications through the sink.
 */

import {
  CallToolParams,
  CallToolResult,
  GetPromptParams,
  GetPromptResult,
  JsonRpcErrorCode,
  JsonRpcMessage,
  JsonRpcResponse,
  ListPromptsResult,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ListToolsResult,
  LoggingLevel,
  ReadResourceParams,
  ReadResourceResult,
  ServerCapabilities,
} from './protocol/index.js';
import { errorResponse, isJsonRpcRequest, RequestError } from './protocol/jsonrpc.js';
import {
  AuthScope,
  fullScope,
  modelAllowed,
  scopeAllows,
} from './auth/scope.js';
import { ClientLogForwarder } from './client-logging.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import { toCatalogEntry, toToolDefinition, visibleTools } from './tool-catalog.js';
import {
  DEFAULT_CONFIG,
  InMemoryModelRegistry,
  Logger,
  ModelRegistry,
  SILENT_LOGGER,
  ServerConfig,
  ToolContext,
} from './context.js';
import { ToolExecutionError, ToolErrorCode, toolError } from './errors.js';
import { PromptRegistry } from './prompts/types.js';
import { ResourceRegistry } from './resources/types.js';
import { ProtocolSession, type ProtocolDomain, type ToolCallChannel } from './sdk/protocol-session.js';
import { disposeSessionResources } from './session-cleanup.js';
import { ToolRegistry } from './tools/types.js';
import { withScanHint } from './tools/util.js';
import { validateInput } from './validate.js';
import { ViewerManager } from './viewer-manager.js';
import type { ViewerState } from './viewer-manager.js';

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
  /**
   * Transport session id for multi-client transports (one MCPServer per
   * HTTP session). Keys per-session state like the layer workspace (#1030);
   * omit for stdio/in-process where the process is the session.
   */
  sessionId?: string;
  /** `initialize` instructions. Default: the model-server instructions. */
  instructions?: string;
}

export class MCPServer implements ProtocolDomain {
  readonly name: string;
  readonly version: string;
  readonly registry: ModelRegistry;
  readonly tools: ToolRegistry;
  readonly resources: ResourceRegistry;
  readonly prompts: PromptRegistry;
  readonly config: ServerConfig;
  readonly viewer: ViewerManager;
  readonly sessionId?: string;
  readonly capabilities: ServerCapabilities;
  readonly instructions: string;

  private scope: AuthScope;
  readonly logger: Logger;
  private logForwarder: ClientLogForwarder;
  private sink: OutgoingMessageSink | null = null;
  /** Set by detach until the next attach: a detached server opens no new connection. */
  private detached = false;
  /** The live MCP connection; built on first use. */
  private session: ProtocolSession | null = null;
  /** Models resources/list last showed; list_changed goes out only when they change. */
  private listedModels = '';
  private unsubscribeRegistry: (() => void) | undefined;

  constructor(opts: MCPServerOptions) {
    this.name = opts.name ?? SERVER_NAME;
    this.version = opts.version;
    this.sessionId = opts.sessionId;
    this.registry = opts.registry ?? new InMemoryModelRegistry();
    this.scope = opts.scope ?? fullScope();
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.tools = opts.tools;
    this.resources = opts.resources;
    this.prompts = opts.prompts;
    this.logForwarder = new ClientLogForwarder(opts.logger ?? SILENT_LOGGER, this.name, (params) => this.notify('notifications/message', { ...params }));
    this.logger = this.logForwarder.logger;
    this.instructions = opts.instructions ?? SERVER_INSTRUCTIONS;
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

  /** Host-side logger without client forwarding (ProtocolDomain). */
  get baseLogger(): Logger {
    return this.logForwarder.base;
  }

  /** Attach an outgoing-message sink. Required before handling messages. */
  attach(sink: OutgoingMessageSink): void {
    this.sink = sink;
    this.detached = false;
    this.listedModels = this.listedModelsKey();
    this.unsubscribeRegistry ??= this.registry.onChange?.(() => this.syncListedModels());
  }

  detach(): void {
    this.sink = null;
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = undefined;
    // The connection ends here: calls in flight are aborted, and a later
    // attach starts a new one (uninitialized, no subscriptions, no log level).
    this.session?.close();
    this.session = null;
    this.detached = true;
    this.logForwarder.reset();
    // Close the viewer sockets, layer Y.Docs and native Room plates even if
    // an earlier resource fails. SSE reconnects do not call detach.
    disposeSessionResources(this.viewer, this.registry, this.sessionId, this.logger);
  }

  /** Update the auth scope mid-session (e.g. token refresh). */
  setScope(scope: AuthScope): void {
    const names = () => visibleTools(this.tools, this.scope, this.config.readOnly).map((t) => t.name).join('\n');
    const before = names();
    this.scope = scope;
    if (names() !== before) this.notifyToolsChanged();
    this.syncListedModels();
  }

  /**
   * Open the in-process viewer for the first loaded model if configured to
   * do so, otherwise a no-op. Makes `ServerConfig.autoOpenViewer` /
   * `.viewerPort` (issue #2731 finding 4) actually take effect for any
   * caller that constructs `MCPServer` with `config`, not just the CLI.
   *
   * Precedence: `overrides` (an explicit, per-call instruction — this is
   * what a CLI flag like `--viewer` represents) beats `this.config` (set at
   * construction, e.g. by an embedder) beats the built-in default of "do
   * not auto-open, port 0". A field left `undefined` at one level falls
   * through to the next.
   *
   * No-ops (returns `null`) when auto-open resolves to `false`/`undefined`,
   * or when no model is loaded yet. Errors from `ViewerManager.open()`
   * propagate — callers that already have their own logging/fallback (the
   * CLI does) can catch and report; callers that don't want that risk can
   * check `registry.count()` first.
   */
  async maybeAutoOpenViewer(overrides?: { autoOpen?: boolean; port?: number }): Promise<ViewerState | null> {
    const autoOpen = overrides?.autoOpen ?? this.config.autoOpenViewer ?? false;
    if (!autoOpen) return null;
    const model = this.registry.list()[0];
    if (!model) return null;
    const port = overrides?.port ?? this.config.viewerPort ?? 0;
    const state = await this.viewer.open(model, port);
    const adapters = this.viewer.adapters();
    if (adapters) model.backend.attachStreamingAdapters(adapters.viewer, adapters.visibility);
    return state;
  }

  isInitialized(): boolean {
    return this.session?.isInitialized() ?? false;
  }

  /**
   * Process a single inbound JSON-RPC message. Returns the response (if any)
   * or null for notifications. Side-effect notifications (progress, log) flow
   * through the attached sink, not the return value.
   */
  async handleMessage(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    // A request racing detach (an HTTP session ended mid-POST) must not reopen the connection.
    if (!this.detached) return this.protocol().deliver(message);
    return isJsonRpcRequest(message) ? errorResponse(message.id, JsonRpcErrorCode.InternalError, 'The server was detached from its connection') : null;
  }

  private protocol(): ProtocolSession {
    this.session ??= new ProtocolSession(this, () => this.sink);
    return this.session;
  }

  // ────────────────────────────────────────────────────────────────────────
  // ProtocolDomain: what each MCP request means
  // ────────────────────────────────────────────────────────────────────────

  initialized(info: { client: unknown; protocol: string; negotiated: string }): void {
    this.logger.log('info', 'initialize', info);
  }

  setLogLevel(level: LoggingLevel): void {
    this.logForwarder.setLevel(level);
  }

  listTools(): ListToolsResult {
    return { tools: visibleTools(this.tools, this.scope, this.config.readOnly).map(toToolDefinition) };
  }

  async callTool(params: CallToolParams, channel: ToolCallChannel): Promise<CallToolResult> {
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

    const ctx: ToolContext = {
      registry: this.registry,
      scope: this.scope,
      currentScope: () => this.scope,
      progress: channel.progress,
      log: this.logger,
      signal: channel.signal,
      config: this.config,
      // Read at call time — `setScope` may refresh the principal mid-session.
      session: { id: this.sessionId, principal: this.scope.user },
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
      if (err instanceof ToolExecutionError) return withScanHint(err, ctx, (validation.value as { model_id?: string }).model_id).toToolResult();
      return toolError({
        code: ToolErrorCode.INTERNAL_ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (!this.registry.onChange) this.syncListedModels();
    }
  }

  async listResources(): Promise<ListResourcesResult> {
    return { resources: await this.resources.list(this.makeResourceContext()) };
  }

  listResourceTemplates(): ListResourceTemplatesResult {
    return { resourceTemplates: this.resources.templates() };
  }

  async readResource(params: ReadResourceParams): Promise<ReadResourceResult> {
    const provider = this.resources.matchProvider(params.uri);
    // An empty read is a well-formed URI naming nothing (unknown model or entity).
    const contents = provider ? await provider.read(params.uri, this.makeResourceContext()) : [];
    if (contents.length === 0) throw new RequestError(JsonRpcErrorCode.InvalidParams, 'Resource not found', { uri: params.uri });
    return { contents };
  }

  listPrompts(): ListPromptsResult {
    return { prompts: this.prompts.list() };
  }

  async getPrompt(params: GetPromptParams): Promise<GetPromptResult> {
    const prompt = this.prompts.get(params.name);
    if (!prompt) throw new RequestError(JsonRpcErrorCode.InvalidParams, `Unknown prompt: ${params.name}`);
    return prompt.render(params.arguments ?? {}, this.makeResourceContext());
  }

  private listedModelsKey(): string {
    return this.registry.list().filter((m) => modelAllowed(this.scope, m.id)).map((m) => `${m.id}\t${m.name}`).join('\n');
  }

  /** Per-model resources follow the loaded set the scope permits. */
  private syncListedModels(): void {
    const key = this.listedModelsKey();
    if (key !== this.listedModels) { this.listedModels = key; this.notifyResourcesChanged(); }
  }

  // ────────────────────────────────────────────────────────────────────────
  // helpers
  // ────────────────────────────────────────────────────────────────────────

  private makeResourceContext(): ToolContext {
    return {
      registry: this.registry,
      scope: this.scope,
      currentScope: () => this.scope,
      progress: { report() { /* no progress for resource/prompt access */ } },
      log: this.logger,
      signal: new AbortController().signal,
      config: this.config,
      session: { id: this.sessionId, principal: this.scope.user },
      viewer: this.viewer,
      toolCatalog: () => visibleTools(this.tools, this.scope, this.config.readOnly).map(toCatalogEntry),
    };
  }

  /** Broadcast a `notifications/resources/updated` to subscribers. */
  notifyResourceUpdated(uri: string): void {
    this.session?.resourceUpdated(uri);
  }

  /** Send a server notification. Dropped until initialize; a failing sink is logged, never thrown at the caller. */
  notify(method: string, params: Record<string, unknown>): void {
    this.session?.notify(method, params);
  }

  /** Notify clients that the tool list has changed (e.g., after model load). */
  notifyToolsChanged(): void { if (this.capabilities.tools?.listChanged) this.notify('notifications/tools/list_changed', {}); }

  /** Notify clients that resources/list changed (a model was loaded, unloaded or hidden by scope). */
  notifyResourcesChanged(): void { if (this.capabilities.resources?.listChanged) this.notify('notifications/resources/list_changed', {}); }

  /** Read-only access to the auth scope for transports that need to gate access. */
  hasModelAccess(modelId: string): boolean {
    return modelAllowed(this.scope, modelId);
  }
}
