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
import { JsonRpcMessage } from '../protocol/index.js';
import { errorResponse, parseMessage } from '../protocol/jsonrpc.js';
import { JsonRpcErrorCode } from '../protocol/index.js';
import { MCPServer, OutgoingMessageSink } from '../server.js';

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
  private server: MCPServer | null = null;
  private closed = false;

  constructor(opts: StdioTransportOptions = {}) {
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
    this.stderr = opts.stderr ?? process.stderr;
  }

  async connect(server: MCPServer): Promise<void> {
    this.server = server;
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

  private async onData(chunk: string): Promise<void> {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        await this.handleLine(line);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (!this.server) return;
    const parsed = parseMessage(line);
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
