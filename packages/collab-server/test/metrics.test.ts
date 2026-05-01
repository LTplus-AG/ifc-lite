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
});
