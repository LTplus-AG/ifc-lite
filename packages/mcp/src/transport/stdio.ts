/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * stdio transport — newline-delimited JSON-RPC over stdin/stdout.
 *
 * This is the transport every MCP client uses when launching the server as a
 * subprocess (Claude Desktop, Cursor, Goose, etc.). The framing rule is
 * simple: one JSON message per line on stdout; one per line read on stdin.
 *
 * We avoid Buffer string concatenation cost by buffering a single Buffer and
 * scanning for `\n` boundaries. Anything written to stderr is reserved for
 * server logs so the client's stdout reader doesn't choke on it.
 */

import { Readable, Writable } from 'node:stream';
import { JsonRpcMessage, JsonRpcId } from '../protocol/index.js';
import { errorResponse, parseMessage, isJsonRpcRequest, isJsonRpcNotification } from '../protocol/jsonrpc.js';
import { JsonRpcErrorCode } from '../protocol/index.js';
import { MCPServer, OutgoingMessageSink } from '../server.js';
import { describeThrown } from '../errors.js';
import { routeConsoleToStderr } from './stdio-console.js';

export interface StdioTransportOptions {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
}

/** Why the transport closed: the peer ended stdin, stdin failed, or stdout failed (EPIPE: the peer is gone). */
export type StdioCloseReason = 'stdin-end' | 'stdin-error' | 'stdout-error' | 'closed';

export class StdioTransport {
  private stdin: Readable;
  private stdout: Writable;
  private stderr: Writable;
  private buffer = '';
  private initializeResponse: Promise<void> | null = null;
  private waitingRequests = new Map<JsonRpcId, { cancelled: boolean }>();
  private server: MCPServer | null = null;
  private closed = false;
  private closeListeners: Array<(reason: StdioCloseReason) => void> = [];

  constructor(opts: StdioTransportOptions = {}) {
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
    this.stderr = opts.stderr ?? process.stderr;
  }

  async connect(server: MCPServer): Promise<void> {
    this.server = server;
    // stdout is the JSON-RPC channel: nothing that logs may reach it.
    if (this.stdout === process.stdout) routeConsoleToStderr();
    server.attach(this.makeSink());

    // UTF-8 — MCP spec mandates it.
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => this.onData(chunk));
    this.stdin.on('end', () => this.close('stdin-end'));
    this.stdin.on('error', (err: Error) => {
      this.stderr.write(`[ifc-lite-mcp] stdin error: ${err.message}\n`);
      this.close('stdin-error');
    });
    // A failed stdout write (EPIPE, ECONNRESET, ...) means the peer stopped
    // reading for good. Without a listener it is an uncaught exception that
    // kills the process; treat it as the peer closing instead.
    this.stdout.on('error', (err: Error) => {
      if (this.closed) return;
      this.stderr.write(`[ifc-lite-mcp] stdout closed by the peer (${(err as NodeJS.ErrnoException).code ?? err.message}); stopping\n`);
      this.close('stdout-error');
      // Nothing can be answered any more: stop reading requests too.
      this.stdin.destroy();
    });
  }

  /** Called once when the transport closes, with the reason. */
  onClose(listener: (reason: StdioCloseReason) => void): void {
    this.closeListeners.push(listener);
  }

  close(reason: StdioCloseReason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.waitingRequests.clear();
    this.server?.detach();
    this.server = null;
    for (const l of this.closeListeners.splice(0)) {
      try {
        l(reason);
      } catch (err) {
        this.stderr.write(`[ifc-lite-mcp] close listener failed: ${describeThrown(err)}\n`);
      }
    }
  }

  private makeSink(): OutgoingMessageSink {
    return {
      send: (message: JsonRpcMessage) => {
        if (this.closed) return;
        let line: string;
        try {
          line = JSON.stringify(message) + '\n';
        } catch (err) {
          const why = describeThrown(err);
          this.stderr.write(`[ifc-lite-mcp] failed to serialize outgoing message: ${why}\n`);
          // A response that cannot be serialized must still answer its request,
          // or the client waits forever. Notifications are dropped (logged above).
          const id = 'id' in message && ('result' in message || 'error' in message) ? message.id : undefined;
          if (id === undefined || id === null) return;
          line = JSON.stringify(errorResponse(id, JsonRpcErrorCode.InternalError, `Response could not be serialized: ${why}`)) + '\n';
        }
        try {
          this.stdout.write(line);
        } catch (err) {
          // Some streams throw synchronously once destroyed; same meaning as an 'error' event.
          this.stderr.write(`[ifc-lite-mcp] stdout write failed: ${describeThrown(err)}\n`);
          this.close('stdout-error');
        }
      },
    };
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        // One bad line must never take the process down with it.
        try {
          this.dispatch(parseMessage(line));
        } catch (err) {
          this.stderr.write(`[ifc-lite-mcp] failed to handle an incoming message: ${describeThrown(err)}\n`);
        }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatch(message: JsonRpcMessage | null): void {
    if (this.closed) return;
    if (message && isJsonRpcNotification(message) && message.method === 'notifications/cancelled') {
      const id = (message.params as { requestId?: JsonRpcId } | undefined)?.requestId;
      const waiting = id === undefined ? undefined : this.waitingRequests.get(id);
      if (waiting) {
        waiting.cancelled = true;
        return;
      }
      void this.handleLine(message);
      return;
    }
    const barrier = this.initializeResponse;
    if (message && isJsonRpcRequest(message) && message.method === 'initialize') {
      const run = barrier ? barrier.then(() => this.handleLine(message)) : this.handleLine(message);
      this.initializeResponse = run;
      void run.then(() => { if (this.initializeResponse === run) this.initializeResponse = null; });
    } else if (barrier) {
      const id = message && isJsonRpcRequest(message) ? message.id : undefined;
      const waiting = { cancelled: false };
      if (id !== undefined) this.waitingRequests.set(id, waiting);
      void barrier.then(() => {
        if (id !== undefined && this.waitingRequests.get(id) === waiting) this.waitingRequests.delete(id);
        if (waiting.cancelled) return;
        return this.handleLine(message);
      });
    } else {
      void this.handleLine(message);
    }
  }

  private async handleLine(parsed: JsonRpcMessage | null): Promise<void> {
    if (!this.server) return;
    if (!parsed) {
      // Send a Parse Error with id=null per JSON-RPC 2.0 spec.
      const sink = this.makeSink();
      void sink.send(errorResponse(null, JsonRpcErrorCode.ParseError, 'Failed to parse JSON-RPC message'));
      return;
    }
    try {
      const response = await this.server.handleMessage(parsed);
      if (response) {
        const sink = this.makeSink();
        void sink.send(response);
      }
    } catch (err) {
      this.stderr.write(`[ifc-lite-mcp] handler error: ${describeThrown(err)}\n`);
    }
  }
}
