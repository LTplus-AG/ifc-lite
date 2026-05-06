/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In-process transport — for hosts that already manage the BIM context
 * (e.g., the Tauri desktop app or unit tests). The "client" is just another
 * object in the same process that pushes JSON-RPC messages and listens for
 * outgoing ones.
 *
 * Useful for:
 *   - Unit tests (drive the server with hand-crafted messages, assert results)
 *   - Embedded LLM hosts that pipe their own MCP-aware client into the server
 */

import { JsonRpcMessage } from '../protocol/index.js';
import { MCPServer, OutgoingMessageSink } from '../server.js';

export type IncomingHandler = (message: JsonRpcMessage) => void;

export class InProcessTransport {
  private server: MCPServer | null = null;
  private listeners: IncomingHandler[] = [];

  async connect(server: MCPServer): Promise<void> {
    this.server = server;
    server.attach(this.makeSink());
  }

  /** Client → server. Returns the response (if any) for convenience. */
  async send(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    if (!this.server) throw new Error('InProcessTransport: not connected');
    return this.server.handleMessage(message);
  }

  /** Subscribe to messages emitted by the server (responses + notifications). */
  onMessage(handler: IncomingHandler): () => void {
    this.listeners.push(handler);
    return () => {
      const idx = this.listeners.indexOf(handler);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  close(): void {
    this.server?.detach();
    this.server = null;
    this.listeners = [];
  }

  private makeSink(): OutgoingMessageSink {
    return {
      send: (message: JsonRpcMessage) => {
        for (const listener of this.listeners) {
          try {
            listener(message);
          } catch (err) {
            // A listener throwing should not crash the server; log to stderr.
            // eslint-disable-next-line no-console
            console.error('[in-process] listener error', err);
          }
        }
      },
    };
  }
}
