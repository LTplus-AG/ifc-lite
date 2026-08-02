/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/metrics.js';
import { startCollabServer } from '../src/server.js';
import { MemoryPersistence } from '../src/persistence.js';

describe('metrics', () => {
  it('counter / gauge / histogram round-trip', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('foo_total', 'A counter');
    c.inc();
    c.inc(2, { label: 'x' });
    expect(c.get()).toBe(1);
    expect(c.get({ label: 'x' })).toBe(2);

    const g = reg.gauge('foo_gauge', 'A gauge');
    g.set(7);
    g.dec(2);
    expect(g.get()).toBe(5);

    const h = reg.histogram('foo_hist', 'A histogram');
    h.observe(10);
    h.observe(20);
    expect(h.mean()).toBe(15);

    const text = reg.render();
    expect(text).toContain('# HELP foo_total A counter');
    expect(text).toContain('foo_total 1');
    expect(text).toContain('foo_total{label="x"} 2');
    expect(text).toContain('foo_gauge 5');
  });

  it('/metrics endpoint serves Prometheus text', async () => {
    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
    });
    const port = (handle.httpServer.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const body = await res.text();
    expect(body).toContain('collab_rooms');
    expect(body).toContain('# HELP');
    await handle.stop();
  });

  it('gated /metrics refuses hostile bearer shapes without crashing', async () => {
    // The digest-based comparison must behave identically for empty, huge,
    // and multi-byte presented tokens: never throw (raw timingSafeEqual
    // throws on unequal lengths), never accept anything but an exact match,
    // and never leak the token length via an early return.
    const metricsToken = 'metrics-secret';
    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
      metricsToken,
    });
    const port = (handle.httpServer.address() as { port: number }).port;
    const get = (headers?: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/metrics`, { headers });
    try {
      expect((await get()).status).toBe(401); // no credential
      expect((await get({ authorization: 'Bearer' })).status).toBe(401); // empty
      expect((await get({ authorization: 'Bearer  ' })).status).toBe(401); // whitespace only
      // Very long (but under Node's 16KB header ceiling, which 431s first).
      expect((await get({ authorization: `Bearer ${'x'.repeat(4000)}` })).status).toBe(401);
      expect((await get({ authorization: 'Bearer metrics-secre' })).status).toBe(401); // shorter prefix
      expect((await get({ authorization: 'Bearer metrics-secret2' })).status).toBe(401); // longer superstring
      // Multi-byte junk (UTF-8 bytes smuggled through the latin-1 header
      // path): refused, not a crash.
      const unicode = Buffer.from('tok-éü-✓', 'utf8').toString('latin1');
      expect((await get({ authorization: `Bearer ${unicode}` })).status).toBe(401);
      // The exact token still authorizes.
      expect((await get({ authorization: `Bearer ${metricsToken}` })).status).toBe(200);
    } finally {
      await handle.stop();
    }
  });

  it('a unicode-configured metrics token gates without crashing', async () => {
    // HTTP headers travel latin-1, so a multi-byte secret is effectively
    // un-presentable verbatim; what matters is the server never 500s and
    // never authorizes a mismatch.
    const handle = await startCollabServer({
      port: 0,
      persistence: new MemoryPersistence(),
      metricsToken: 'tok-éü-✓',
    });
    const port = (handle.httpServer.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { authorization: 'Bearer tok-eu-x' },
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.stop();
    }
  });
});
