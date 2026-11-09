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
import { routeConsoleToStderr } from './stdio-console.js';

export interface StdioTransportOptions {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
}

export class StdioTransport {
  private stdin: Readable;
  private stdout: Writable;
  private stderr: Writable;
  private buffer = '';
  private initializeResponse: Promise<void> | null = null;
  private waitingRequests = new Map<JsonRpcId, { cancelled: boolean }>();
  private server: MCPServer | null = null;
  private closed = false;

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
    this.stdin.on('end', () => this.close());
    this.stdin.on('error', (err: Error) => {
      this.stderr.write(`[ifc-lite-mcp] stdin error: ${err.message}\n`);
      this.close();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.waitingRequests.clear();
    this.server?.detach();
    this.server = null;
  }

  private makeSink(): OutgoingMessageSink {
    return {
      send: (message: JsonRpcMessage) => {
        if (this.closed) return;
        try {
          const line = JSON.stringify(message) + '\n';
          this.stdout.write(line);
        } catch (err) {
          this.stderr.write(`[ifc-lite-mcp] failed to serialize outgoing message: ${(err as Error).message}\n`);
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
        this.dispatch(parseMessage(line));
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
      this.stderr.write(`[ifc-lite-mcp] handler error: ${(err as Error).message}\n`);
    }
  }
}
