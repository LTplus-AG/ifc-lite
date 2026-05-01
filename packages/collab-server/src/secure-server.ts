/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TLS termination helpers (spec §14, v0.5).
 *
 * In production we recommend terminating TLS at a reverse proxy
 * (nginx, Caddy, ALB, Cloudflare, etc.). For deployments that need
 * TLS in-process — single-binary appliance, edge worker, dev with a
 * self-signed cert — this module ships:
 *
 *   - `createSecureHttpServer(opts)` that wraps `node:https`'s
 *     `createServer` with strong defaults (TLS 1.2+ minVersion,
 *     conservative cipher list, ALPN for HTTP/1.1).
 *
 *   - `applySecurityHeaders(res)` that sets the OWASP-recommended
 *     baseline response headers (HSTS, no-sniff, frame deny). Drop
 *     this into the http handler before writing any response.
 *
 *   - `secureHttpHandler(inner)` wrapper that applies the headers and
 *     defends against the classic TRACE method.
 *
 * Apps that already terminate TLS upstream can ignore this module —
 * `startCollabServer` accepts a `server` option so they can pass any
 * pre-built `http.Server` (or `https.Server`).
 */

import * as https from 'node:https';
import * as fs from 'node:fs';
import type * as http from 'node:http';

export interface SecureHttpServerOptions {
  /** Path to the TLS certificate file (PEM). */
  certPath: string;
  /** Path to the TLS private key file (PEM). */
  keyPath: string;
  /** Optional CA bundle for client certificate verification. */
  caPath?: string;
  /** Reject TLS below this version. Default `'TLSv1.2'`. */
  minVersion?: 'TLSv1.2' | 'TLSv1.3';
  /** Override cipher list. Default modern AES-GCM / ChaCha set. */
  ciphers?: string;
  /** Optional request handler. */
  requestListener?: http.RequestListener;
}

const DEFAULT_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
].join(':');

/** Build a hardened `https.Server`. */
export function createSecureHttpServer(opts: SecureHttpServerOptions): https.Server {
  const tlsOpts: https.ServerOptions = {
    cert: fs.readFileSync(opts.certPath),
    key: fs.readFileSync(opts.keyPath),
    minVersion: opts.minVersion ?? 'TLSv1.2',
    ciphers: opts.ciphers ?? DEFAULT_CIPHERS,
    honorCipherOrder: true,
    ALPNProtocols: ['http/1.1'],
  };
  if (opts.caPath) tlsOpts.ca = fs.readFileSync(opts.caPath);
  return https.createServer(tlsOpts, opts.requestListener);
}

/**
 * Apply OWASP-baseline security headers to a response. Idempotent —
 * if headers are already set, they're left alone.
 */
export function applySecurityHeaders(res: http.ServerResponse): void {
  if (!res.headersSent) {
    if (!res.hasHeader('strict-transport-security')) {
      res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    if (!res.hasHeader('x-content-type-options')) {
      res.setHeader('x-content-type-options', 'nosniff');
    }
    if (!res.hasHeader('x-frame-options')) {
      res.setHeader('x-frame-options', 'DENY');
    }
    if (!res.hasHeader('referrer-policy')) {
      res.setHeader('referrer-policy', 'no-referrer');
    }
  }
}

/** Wrap a request handler with security-header + TRACE-defence. */
export function secureHttpHandler(inner: http.RequestListener): http.RequestListener {
  return (req, res) => {
    if (req.method === 'TRACE' || req.method === 'TRACK') {
      res.writeHead(405);
      res.end();
      return;
    }
    applySecurityHeaders(res);
    inner(req, res);
  };
}
