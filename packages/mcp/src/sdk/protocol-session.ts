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
  SdkError,
  Server,
  type JSONRPCRequest,
  type RequestMethod,
  type RequestTypeMap,
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
import { describeThrown, ToolErrorCode, toolError } from '../errors.js';
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
  /** The server's logger: lines also reach clients that set a log level. */
  readonly logger: Logger;
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

/** An error our own handler raised (see `guard`): answered with its code as is. */
class HandlerError extends ProtocolError {}
/**
 * Requests whose own handler started, keyed by the request's abort signal
 * (the SDK may hand the handler a copy of ctx, never a new signal). An SDK
 * error on one of these came after the handler.
 */
const entered = new WeakSet<AbortSignal>();

/**
 * The SDK `Server` with two changes, applied to every request handler:
 * - requests other than initialize/ping before the handshake answer -32600,
 *   ahead of the SDK's param validation (the SDK itself does not gate them);
 * - errors are labelled by where they arose. Our handler's own errors
 *   (`HandlerError`) keep their code. Before our handler started, the error
 *   is the SDK's param validation: -32602 (a bare `Error` from the SDK is
 *   relabelled; an `SdkError` is a fault, -32603). After it, an SDK error is
 *   its result validation refusing what we returned, a server fault: -32603,
 *   or an INTERNAL_ERROR tool result for `tools/call` so the client keeps the
 *   structured envelope. (A failure in the SDK's final wire encoding happens
 *   outside this wrapper and answers a bare -32603.)
 */
class IfcProtocolServer extends Server {
  /** Runs after the SDK answered `initialize`, with the request and the negotiated result. */
  onInitialize?: (params: { protocolVersion: string; clientInfo?: unknown }, result: { protocolVersion: string }) => void;

  constructor(
    info: { name: string; version: string },
    options: ConstructorParameters<typeof Server>[1],
    /** Whether initialize has arrived (requests before it are refused), and where an aborted request is reported. */
    private readonly link: {
      readonly handshakeSent: boolean;
      initializeSettled(): Promise<void>;
      take(id: string | number): ((response: null) => void) | undefined;
    },
  ) {
    super(info, options);
  }

  protected override _wrapHandler(
    method: string,
    handler: (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>,
  ): (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result> {
    const inner = super._wrapHandler(method, handler);
    const opening = method === 'initialize' || method === 'ping';
    return async (request, ctx) => {
      const signal = ctx.mcpReq.signal;
      const id = ctx.mcpReq.id;
      // The SDK sends nothing for a request it aborted. On abort the id is
      // freed at once (a retry may reuse it); the caller hears once the
      // handler has unwound, so the retry cannot collide with the old run.
      let held: ((response: null) => void) | undefined;
      let unwound = false;
      const abandon = () => {
        held ??= this.link.take(id);
        if (unwound) held?.(null);
      };
      if (signal.aborted) abandon();
      else signal.addEventListener('abort', abandon, { once: true });
      let result: Result;
      try {
        if (!opening && !this.link.handshakeSent) {
          await this.link.initializeSettled();
          if (!this.link.handshakeSent) {
            throw new HandlerError(JsonRpcErrorCode.ServerNotInitialized, 'Server not initialized — send `initialize` first');
          }
        }
        result = await inner(request, ctx);
      } catch (err) {
        if (err instanceof HandlerError) throw err;
        const message = describeThrown(err);
        if (!entered.has(signal)) {
          // Before our handler, only the SDK's param validation is the client's fault:
          // it throws a bare Error or a -32602 ProtocolError (SDK 2.4). Anything else is ours.
          if ((err instanceof Error && err.constructor === Error)
            || (err instanceof ProtocolError && err.code === ProtocolErrorCode.InvalidParams)) {
            throw invalidParams(err, (note) => this.onerror?.(new Error(note)));
          }
          throw err instanceof ProtocolError ? err : new ProtocolError(ProtocolErrorCode.InternalError, message);
        }
        this.onerror?.(new Error(`${method} produced a result the protocol refused: ${message}`));
        if (method === 'tools/call') return toolError({ code: ToolErrorCode.INTERNAL_ERROR, message }) as unknown as Result;
        throw new ProtocolError(ProtocolErrorCode.InternalError, message);
      } finally {
        unwound = true;
        if (signal.aborted) abandon();
      }
      if (method === 'initialize' && !signal.aborted) {
        // A failing observer must not fail a handshake the SDK already answered.
        try {
          this.onInitialize?.(request.params as { protocolVersion: string }, result as { protocolVersion: string });
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
      return result;
    };
  }
}

/**
 * The SDK's param validation fails with a message that is a zod issue list
 * as pretty-printed JSON (a bare `Error`, or a -32602 `ProtocolError`; SDK
 * 2.4). Say it in one line; keep the issues in `data`. Anything else passes:
 * if the SDK changes that format, clients get its raw message.
 */
function invalidParams(err: unknown, report: (note: string) => void): ProtocolError {
  if (err instanceof ProtocolError && err.code !== ProtocolErrorCode.InvalidParams) return err;
  const text = err instanceof Error ? err.message : describeThrown(err);
  // The list may follow a prefix such as "Invalid tools/call request: ".
  const start = text.indexOf('[');
  const issues = start < 0 || !text.trimEnd().endsWith(']') ? undefined : zodIssues(text.slice(start), report);
  // A bare Error that is not an issue list is an SDK fault, not the client's params.
  if (!issues) return err instanceof ProtocolError ? err : new ProtocolError(ProtocolErrorCode.InternalError, text);
  const summary = issues.map((i) => `${(i.path ?? []).join('.') || '(params)'}: ${i.message ?? 'invalid'}`).join('; ');
  const prefix = start > 0 ? text.slice(0, start).trim().replace(/:$/, '') : 'Invalid params';
  return new ProtocolError(ProtocolErrorCode.InvalidParams, `${prefix}: ${summary}`, { issues });
}

function zodIssues(text: string, report: (note: string) => void): Array<{ path?: unknown[]; message?: string }> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch (err) {
    // Looked like an issue list but is not one: the raw message goes out as is.
    report(`unparsable validation message: ${describeThrown(err)}`);
    return undefined;
  }
}

/**
 * Runs `fn` with a signal that aborts with a plain AbortError when `source`
 * aborts. Tools check `error.name === 'AbortError'`; the SDK aborts its own
 * signal with the client's reason or an SdkError instead.
 */
async function withPlainAbort<T>(source: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const plain = new AbortController();
  // Keeps the client's reason (or the SDK's close error) readable as the message.
  const forward = () => plain.abort(new DOMException(describeThrown(source.reason), 'AbortError'));
  if (source.aborted) forward();
  else source.addEventListener('abort', forward, { once: true });
  try {
    return await fn(plain.signal);
  } finally {
    source.removeEventListener('abort', forward);
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

  constructor(private readonly domain: ProtocolDomain, sink: () => LoopbackSink | null) {
    const capabilities = domain.capabilities;
    this.transport = new LoopbackTransport(sink);
    this.server = new IfcProtocolServer(
      { name: domain.name, version: domain.version },
      {
        capabilities: capabilities as Record<string, unknown>,
        instructions: domain.instructions,
        supportedProtocolVersions: NEGOTIABLE_VERSIONS,
      },
      this.transport,
    );
    this.server.onerror = (err) => domain.baseLogger.log('warning', 'MCP protocol error', { error: describeThrown(err) });
    this.register(capabilities);
    void this.server.connect(this.transport);
  }

  isInitialized(): boolean {
    return this.transport.handshakeSent;
  }

  /** One inbound message; resolves with the response, or null for notifications. */
  deliver(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    return this.transport.deliver(message);
  }

  /** Ends the connection: requests in flight are aborted and answered with -32603. */
  close(): void {
    void this.server.close();
    this.transport.settleAll();
  }

  /** Send a server notification. Dropped until initialize; a failing sink is logged, never thrown at the caller. */
  notify(method: string, params: Record<string, unknown>): void {
    // The transport drops it before the handshake anyway; skip the SDK's encode.
    if (!this.isInitialized()) return;
    const failed = (err: unknown) => this.domain.baseLogger.log('warning', `notify ${method} failed`, { error: describeThrown(err) });
    this.server.notification({ method, params }).catch(failed);
  }

  resourceUpdated(uri: string): void {
    if (this.subscriptions.has(uri)) this.notify('notifications/resources/updated', { uri });
  }

  private register(capabilities: ServerCapabilities): void {
    const s = this.server;
    // The SDK answers initialize and negotiates the version; we only record it.
    s.onInitialize = (params, result) => {
      this.domain.initialized({ client: params.clientInfo, protocol: params.protocolVersion, negotiated: result.protocolVersion });
    };
    const on = <M extends RequestMethod>(method: M, handler: (request: RequestTypeMap[M], ctx: ServerContext) => unknown) =>
      s.setRequestHandler(method, this.guard(method, handler) as never);
    if (capabilities.tools) {
      on('tools/list', () => this.domain.listTools());
      on('tools/call', (request, ctx) => withPlainAbort(ctx.mcpReq.signal, (signal) => this.domain.callTool(request.params as CallToolParams, {
        signal,
        progress: this.progressFor(request.params._meta?.progressToken, ctx),
      })));
    }
    if (capabilities.resources) {
      on('resources/list', () => this.domain.listResources());
      on('resources/templates/list', () => this.domain.listResourceTemplates());
      on('resources/read', (request) => this.domain.readResource(request.params as ReadResourceParams));
      if (capabilities.resources.subscribe) {
        on('resources/subscribe', (request) => { this.subscriptions.add(request.params.uri); return {}; });
        on('resources/unsubscribe', (request) => { this.subscriptions.delete(request.params.uri); return {}; });
      }
    }
    if (capabilities.prompts) {
      on('prompts/list', () => this.domain.listPrompts());
      on('prompts/get', (request) => this.domain.getPrompt(request.params as GetPromptParams));
    }
    if (capabilities.logging) {
      // Replaces the SDK's handler, which keeps the level per HTTP session id;
      // ours is one level per connection, and the domain's logger reads it.
      on('logging/setLevel', (request) => { this.domain.setLogLevel(request.params.level as LoggingLevel); return {}; });
    }
  }

  /**
   * Every domain handler runs through here: a `RequestError` keeps its code,
   * anything else is an internal error. Both leave as `ProtocolError`, which
   * `IfcProtocolServer` passes through untouched.
   */
  // `on` casts the result: our wire types (protocol/types.ts) are structurally
  // looser than the SDK's zod-derived ones, and the SDK encodes and checks
  // each result against the spec schema at runtime anyway.
  private guard<P>(method: string, handler: (request: P, ctx: ServerContext) => unknown): (request: P, ctx: ServerContext) => Promise<unknown> {
    return async (request, ctx) => {
      entered.add(ctx.mcpReq.signal);
      try {
        return await handler(request, ctx);
      } catch (err) {
        if (err instanceof ProtocolError) throw new HandlerError(err.code, err.message, err.data);
        if (err instanceof RequestError) throw new HandlerError(err.code, err.message, err.data);
        const message = describeThrown(err);
        this.domain.logger.log('error', `Request ${method} failed`, { error: message });
        throw new HandlerError(ProtocolErrorCode.InternalError, message);
      } finally {
        const signal = ctx.mcpReq.signal;
        if (signal.aborted) {
          // The SDK aborts with an SdkError when the connection closes; a client cancel carries its reason.
          const what = signal.reason instanceof SdkError ? 'Request ended by connection close' : 'Cancelled request';
          this.domain.logger.log('info', `${what} ${String(ctx.mcpReq.id)}`, { method, reason: describeThrown(signal.reason) });
        }
      }
    };
  }

  private progressFor(token: string | number | undefined, ctx: ServerContext): ProgressReporter {
    if (token === undefined) return { report() { /* no token => silent */ } };
    return {
      report: (progress, message, total) => {
        // A cancelled or closed request has nobody listening for its progress.
        if (ctx.mcpReq.signal.aborted) return;
        const params: Record<string, unknown> = { progressToken: token, progress };
        if (total !== undefined) params.total = total;
        if (message !== undefined) params.message = message;
        this.transport.takeSyncFailure(); // drop a failure left by an earlier, unrelated send
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
