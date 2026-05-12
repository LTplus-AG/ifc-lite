/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as http from 'node:http';
import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import { applySecurityHeaders, secureHttpHandler } from '../src/secure-server.js';

/** Send a raw HTTP request — undici's fetch refuses TRACE. */
function rawRequest(port: number, method: string, path = '/'): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    sock.on('error', reject);
  });
}

describe('secure-server helpers', () => {
  it('applySecurityHeaders sets the OWASP baseline', async () => {
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        applySecurityHeaders(res);
        res.writeHead(200);
        res.end();
      });
      server.listen(0, '127.0.0.1', async () => {
        try {
          const port = (server.address() as { port: number }).port;
          const result = await fetch(`http://127.0.0.1:${port}/`);
          expect(result.headers.get('strict-transport-security')).toMatch(/max-age=31536000/);
          expect(result.headers.get('x-content-type-options')).toBe('nosniff');
          expect(result.headers.get('x-frame-options')).toBe('DENY');
          expect(result.headers.get('referrer-policy')).toBe('no-referrer');
          server.close(() => resolve());
        } catch (err) {
          server.close(() => reject(err));
        }
      });
    });
  });

  it('secureHttpHandler blocks TRACE / TRACK', async () => {
    await new Promise<void>((resolve, reject) => {
      const inner = (_req: http.IncomingMessage, res: http.ServerResponse) => {
        res.writeHead(200);
        res.end('inner');
      };
      const server = http.createServer(secureHttpHandler(inner));
      server.listen(0, '127.0.0.1', async () => {
        try {
          const port = (server.address() as { port: number }).port;
          const traceResp = await rawRequest(port, 'TRACE');
          expect(traceResp.split('\r\n')[0]).toContain('405');
          const okResp = await rawRequest(port, 'GET');
          expect(okResp.split('\r\n')[0]).toContain('200');
          expect(okResp.toLowerCase()).toContain('x-content-type-options: nosniff');
          server.close(() => resolve());
        } catch (err) {
          server.close(() => reject(err));
        }
      });
    });
  });
});
