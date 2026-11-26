/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The protocol adapter: one MCP connection served by the official SDK's
 * low-level `Server`, dispatching into the domain module (`MCPServer`).
 *
 * The SDK owns the wire: JSON-RPC framing, the initialize handshake and
 * version negotiation, spec schema validation of every request,
 * cancellation, and notification encoding. The domain owns what the server
 * means: tool scope and read-only gates, input validation, the error
 * envelope, resources and prompts. This file is the seam between them; the
 * domain never imports the SDK.
 */

import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type JSONRPCRequest,
  type Result,
  type ServerContext,
} from '@modelcontextprotocol/server';
import {
  JsonRpcErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  type CallToolParams,
  type CallToolResult,
  type GetPromptParams,
  type GetPromptResult,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type ListPromptsResult,
  type ListResourceTemplatesResult,
  type ListResourcesResult,
  type ListToolsResult,
  type LoggingLevel,
  type ReadResourceParams,
  type ReadResourceResult,
  type ServerCapabilities,
} from '../protocol/index.js';
import { RequestError } from '../protocol/jsonrpc.js';
import type { Logger, ProgressReporter } from '../context.js';
import { describeThrown } from '../errors.js';
import { LoopbackTransport, type LoopbackSink } from './loopback-transport.js';

/** What one tool call gets from the connection that carries it. */
export interface ToolCallChannel {
  signal: AbortSignal;
  progress: ProgressReporter;
}

/** The interface the protocol adapter needs from the domain module. */
export interface ProtocolDomain {
  readonly name: string;
  readonly version: string;
  readonly capabilities: ServerCapabilities;
  readonly instructions: string;
  /** Host-side logger, never forwarded to the client: adapter faults go here. */
  readonly baseLogger: Logger;
  initialized(info: { client: unknown; protocol: string; negotiated: string }): void;
  listTools(): ListToolsResult;
  callTool(params: CallToolParams, channel: ToolCallChannel): Promise<CallToolResult>;
  listResources(): Promise<ListResourcesResult>;
  listResourceTemplates(): ListResourceTemplatesResult;
  readResource(params: ReadResourceParams): Promise<ReadResourceResult>;
  listPrompts(): ListPromptsResult;
  getPrompt(params: GetPromptParams): Promise<GetPromptResult>;
  setLogLevel(level: LoggingLevel): void;
}

/** Oldest last: the SDK offers the first entry when a client asks for a version we do not speak. */
const NEGOTIABLE_VERSIONS = [PROTOCOL_VERSION, ...[...SUPPORTED_PROTOCOL_VERSIONS].filter((v) => v !== PROTOCOL_VERSION).sort().reverse()];

/** Thrown by a domain handler: answered with its own code, never re-labelled. */
class HandlerFailure extends ProtocolError {}

/**
 * The SDK `Server` with one change: a request the SDK's spec schemas refuse
 * (missing or malformed params) answers -32602, not -32603. The SDK throws a
 * plain `Error` from its validation step; every error our own handlers raise
 * is already a `ProtocolError` (see `guard`), so an error without a code can
 * only come from that validation.
 */
class IfcProtocolServer extends Server {
  /** Runs after the SDK answered `initialize`, with the request and the negotiated result. */
  onInitialize?: (params: { protocolVersion: string; clientInfo?: unknown }, result: { protocolVersion: string }) => void;

  protected override _wrapHandler(
    method: string,
    handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>,
  ): (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result> {
    const inner = super._wrapHandler(method, handler);
    return async (request, ctx) => {
      try {
        const result = await inner(request, ctx);
        if (method === 'initialize') this.onInitialize?.(request.params as { protocolVersion: string }, result as { protocolVersion: string });
        return result;
      } catch (err) {
        if (err instanceof ProtocolError) throw err;
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
      }
    };
  }
}

/**
 * One connection. Holds the per-connection protocol state (handshake,
 * resource subscriptions) and forwards domain events to the client.
 */
export class ProtocolSession {
  private readonly server: IfcProtocolServer;
  private readonly transport: LoopbackTransport;
  private readonly subscriptions = new Set<string>();
  private initialized = false;

  constructor(private readonly domain: ProtocolDomain, sink: () => LoopbackSink | null) {
    const capabilities = domain.capabilities;
    this.server = new IfcProtocolServer(
      { name: domain.name, version: domain.version },
      {
        capabilities: capabilities as Record<string, unknown>,
        instructions: domain.instructions,
        supportedProtocolVersions: NEGOTIABLE_VERSIONS,
      },
    );
    this.server.onerror = (err) => domain.baseLogger.log('warning', 'MCP protocol error', { error: describeThrown(err) });
    this.transport = new LoopbackTransport(sink);
    this.register(capabilities);
    void this.server.connect(this.transport);
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /** One inbound message; resolves with the response, or null for notifications. */
  deliver(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    return this.transport.deliver(message);
  }

  /** Ends the connection: requests in flight are aborted and answered with nothing. */
  close(): void {
    void this.server.close();
    this.transport.settleAll();
  }

  /** Send a server notification. Dropped until initialize; a failing sink is logged, never thrown at the caller. */
  notify(method: string, params: Record<string, unknown>): void {
    if (!this.initialized) return;
    const failed = (err: unknown) => this.domain.baseLogger.log('warning', `notify ${method} failed`, { error: describeThrown(err) });
    try {
      this.server.notification({ method, params }).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  resourceUpdated(uri: string): void {
    if (this.subscriptions.has(uri)) this.notify('notifications/resources/updated', { uri });
  }

  private register(capabilities: ServerCapabilities): void {
    const s = this.server;
    // The SDK answers initialize and negotiates the version; we only record it.
    s.onInitialize = (params, result) => {
      this.initialized = true;
      this.domain.initialized({ client: params.clientInfo, protocol: params.protocolVersion, negotiated: result.protocolVersion });
    };
    if (capabilities.tools) {
      s.setRequestHandler('tools/list', this.guard('tools/list', () => this.domain.listTools()));
      s.setRequestHandler('tools/call', this.guard('tools/call', (request, ctx) =>
        this.domain.callTool(request.params as CallToolParams, {
          signal: ctx.mcpReq.signal,
          progress: this.progressFor(request.params._meta?.progressToken, ctx),
        })));
    }
    if (capabilities.resources) {
      s.setRequestHandler('resources/list', this.guard('resources/list', () => this.domain.listResources()));
      s.setRequestHandler('resources/templates/list', this.guard('resources/templates/list', () => this.domain.listResourceTemplates()));
      s.setRequestHandler('resources/read', this.guard('resources/read', (request) => this.domain.readResource(request.params as ReadResourceParams)));
      if (capabilities.resources.subscribe) {
        s.setRequestHandler('resources/subscribe', this.guard('resources/subscribe', (request) => {
          this.subscriptions.add(request.params.uri);
          return {};
        }));
        s.setRequestHandler('resources/unsubscribe', this.guard('resources/unsubscribe', (request) => {
          this.subscriptions.delete(request.params.uri);
          return {};
        }));
      }
    }
    if (capabilities.prompts) {
      s.setRequestHandler('prompts/list', this.guard('prompts/list', () => this.domain.listPrompts()));
      s.setRequestHandler('prompts/get', this.guard('prompts/get', (request) => this.domain.getPrompt(request.params as GetPromptParams)));
    }
    if (capabilities.logging) {
      // Replaces the SDK's handler, which keeps the level per HTTP session id;
      // ours is one level per connection, and the domain's logger reads it.
      s.setRequestHandler('logging/setLevel', this.guard('logging/setLevel', (request) => {
        this.domain.setLogLevel(request.params.level as LoggingLevel);
        return {};
      }));
    }
  }

  /**
   * Every domain handler runs through here: requests before initialize are
   * refused, a `RequestError` keeps its code, anything else is an internal
   * error. All leave as `ProtocolError`, which `IfcProtocolServer` passes
   * through untouched.
   */
  // Returns Promise<never>: our wire types (protocol/types.ts) are structurally
  // looser than the SDK's zod-derived ones, and the SDK encodes and checks
  // each result against the spec schema at runtime anyway.
  private guard<P, R>(method: string, handler: (request: P, ctx: ServerContext) => R | Promise<R>): (request: P, ctx: ServerContext) => Promise<never> {
    return async (request, ctx) => {
      if (!this.initialized) {
        throw new HandlerFailure(JsonRpcErrorCode.ServerNotInitialized, 'Server not initialized — send `initialize` first');
      }
      try {
        return (await handler(request, ctx)) as never;
      } catch (err) {
        if (err instanceof ProtocolError) throw err;
        if (err instanceof RequestError) throw new HandlerFailure(err.code, err.message, err.data);
        const message = describeThrown(err);
        this.domain.baseLogger.log('error', `Request ${method} failed`, { error: message });
        throw new HandlerFailure(ProtocolErrorCode.InternalError, message);
      }
    };
  }

  private progressFor(token: string | number | undefined, ctx: ServerContext): ProgressReporter {
    if (token === undefined) return { report() { /* no token => silent */ } };
    return {
      report: (progress, message, total) => {
        const params: Record<string, unknown> = { progressToken: token, progress };
        if (total !== undefined) params.total = total;
        if (message !== undefined) params.message = message;
        this.transport.takeSyncFailure(); // drop one left by an unrelated notification
        const sent = ctx.mcpReq.notify({ method: 'notifications/progress', params });
        // A sink that throws fails the producer on purpose (#7372): rethrow here.
        const failure = this.transport.takeSyncFailure();
        sent.catch((err: unknown) => {
          if (!failure) this.domain.baseLogger.log('warning', 'progress notification failed', { error: describeThrown(err) });
        });
        if (failure) throw failure.error;
      },
    };
  }
}
