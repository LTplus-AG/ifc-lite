/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The HTTP listener under `--bridge`'s WebSocket (#9523): bound to 127.0.0.1
 * only, answering plain HTTP with 426, handing upgrades to the caller.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';

export interface LoopbackServer {
  http: Server;
  wss: WebSocketServer;
  port: number;
}

export async function listenLoopback(
  port: number,
  maxPayload: number,
  onUpgrade: (wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  log: (line: string) => void,
): Promise<LoopbackServer> {
  const http = createServer((_req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end('ifc-lite MCP bridge: WebSocket only\n');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  http.on('upgrade', (req, socket, head) => onUpgrade(wss, req, socket, head));
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    // 127.0.0.1 only, never a public interface.
    http.listen(port, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  http.on('error', (err) => log(`server error: ${err.message}`));
  return { http, wss, port: (http.address() as AddressInfo).port };
}

/** Answer an upgrade request with a bare HTTP status and drop the socket. */
export function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Drop `socket` once it has sent more than `limit` raw bytes while still
 * unpaired (`slot.paired` false), so an unpaired peer cannot make the bridge
 * buffer or parse more than a hello needs. `slot.bytes` starts with the
 * upgrade's already-read head.
 */
export function capUnpairedBytes(socket: Duplex, slot: { paired: boolean; bytes: number }, limit: number, onExceed: () => void): void {
  const onData = (chunk: Buffer): void => {
    if (slot.paired) return void socket.off('data', onData);
    slot.bytes += chunk.length;
    if (slot.bytes > limit) {
      onExceed();
      socket.destroy();
    }
  };
  socket.on('data', onData);
}
