/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { createCollabSession } from '../src/session.js';
import { createEntity, setAttribute } from '../src/doc/entity.js';
// Through the branch barrel, so these tests still load against a tree without
// history-driver.ts and fail on their assertions instead.
import { attachHistorySidecar, MemoryHistorySidecar } from '../src/branch/index.js';

describe('MemoryHistorySidecar', () => {
  it('records, lists, and time-traces entries', async () => {
    const sidecar = new MemoryHistorySidecar();
    const ifcx = (label: string) => ({
      header: {
        id: label,
        ifcxVersion: 'ifcx_alpha',
        dataVersion: '1.0.0',
        author: 't',
        timestamp: new Date().toISOString(),
      },
      imports: [],
      schemas: {},
      data: [],
    });
    const a = await sidecar.record({ snapshot: ifcx('A'), label: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await sidecar.record({ snapshot: ifcx('B'), label: 'second' });
    const list = await sidecar.entries();
    expect(list.map((e) => e.entryId)).toEqual([a.entryId, b.entryId]);
    expect(list.map((e) => e.label)).toEqual(['first', 'second']);

    const found = await sidecar.at(a.at);
    expect(found?.entryId).toBe(a.entryId);
  });

  it('diff returns added / removed / changed paths', async () => {
    const sidecar = new MemoryHistorySidecar();
    const make = (data: Array<{ path: string; attributes?: Record<string, unknown> }>) => ({
      header: { id: 'x', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: 'now' },
      imports: [],
      schemas: {},
      data,
    });
    const a = await sidecar.record({
      snapshot: make([{ path: 'wall', attributes: { Name: 'A' } }, { path: 'door' }]),
    });
    const b = await sidecar.record({
      snapshot: make([
        { path: 'wall', attributes: { Name: 'B' } },
        { path: 'window' },
      ]),
    });
    const diff = await sidecar.diff(a.entryId, b.entryId);
    expect(diff.added).toEqual(['window']);
    expect(diff.removed).toEqual(['door']);
    expect(diff.changed).toEqual(['wall']);
  });

  it('branches and merges', async () => {
    const sidecar = new MemoryHistorySidecar();
    const ifcx = {
      header: { id: 'x', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: 'now' },
      imports: [],
      schemas: {},
      data: [],
    };
    const main = await sidecar.record({ snapshot: ifcx });
    const exp = await sidecar.branch('experiment', main.entryId);
    expect(exp.forkedFromEntryId).toBe(main.entryId);
    await sidecar.record({ branch: 'experiment', snapshot: ifcx });
    const merge = await sidecar.merge('experiment', 'main', ifcx);
    expect(merge.label).toContain('merge experiment → main');
    expect((await sidecar.branches()).map((b) => b.name).sort()).toEqual(['experiment', 'main']);
  });
});

describe('attachHistorySidecar', () => {
  it('captures snapshots on demand from a CollabSession', async () => {
    const session = await createCollabSession({
      roomId: 'r',
      user: { id: 'louis', name: 'Louis' },
      provider: 'memory',
    });
    const sidecar = new MemoryHistorySidecar();
    const driver = attachHistorySidecar(session, sidecar, { intervalMs: 999_999 });

    session.transact(() => {
      createEntity(session.doc, 'wall', { ifcClass: 'IfcWall' });
      setAttribute(session.doc, 'wall', 'Name', 'V1');
    });
    const e1 = await driver.capture('first');

    session.transact(() => setAttribute(session.doc, 'wall', 'Name', 'V2'));
    const e2 = await driver.capture('second');

    expect(e1.label).toBe('first');
    expect(e2.label).toBe('second');
    // The second capture should include a diff layer.
    expect(e2.diff).toBeDefined();
    const diffPaths = e2.diff?.data.map((n) => n.path) ?? [];
    expect(diffPaths).toContain('wall');

    driver.detach();
    session.dispose();
  });
});

describe('attachHistorySidecar lifecycle', () => {
  interface Deferred {
    resolve: () => void;
    reject: (err: Error) => void;
  }
  /** A sidecar whose every record() parks until the test settles it. */
  function gatedSidecar() {
    const inner = new MemoryHistorySidecar();
    const gates: Deferred[] = [];
    const recorded: (string | undefined)[] = [];
    const sidecar = Object.create(inner) as MemoryHistorySidecar;
    sidecar.record = (input) => {
      recorded.push(input.label);
      return new Promise((resolve, reject) => {
        gates.push({
          resolve: () => resolve(inner.record(input)),
          reject,
        });
      });
    };
    return { sidecar, gates, recorded };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const memorySession = () =>
    createCollabSession({ roomId: 'r', user: { id: 'u', name: 'U' }, provider: 'memory' });

  it('runs overlapping captures one at a time, diffing each against the one before', async () => {
    const session = await memorySession();
    const { sidecar, gates, recorded } = gatedSidecar();
    const driver = attachHistorySidecar(session, sidecar, { intervalMs: 999_999 });

    session.transact(() => createEntity(session.doc, 'a', { ifcClass: 'IfcWall' }));
    const first = driver.capture('first');
    session.transact(() => createEntity(session.doc, 'b', { ifcClass: 'IfcWall' }));
    const second = driver.capture('second');
    await flush();
    // The second capture must not snapshot/diff while the first is unrecorded.
    expect([...recorded]).toEqual(['first']);
    gates[0].resolve();
    await first;
    await flush();
    expect([...recorded]).toEqual(['first', 'second']);
    gates[1].resolve();
    const e2 = await second;
    const diffPaths = e2.diff?.data.map((n) => n.path) ?? [];
    expect(diffPaths).toContain('b');
    expect(diffPaths).not.toContain('a');

    driver.detach();
    session.dispose();
  });

  it('never records a queued capture once detached', async () => {
    const session = await memorySession();
    const { sidecar, gates, recorded } = gatedSidecar();
    const driver = attachHistorySidecar(session, sidecar, { intervalMs: 999_999 });

    const first = driver.capture('first');
    const queued = driver.capture('queued');
    await flush();
    driver.detach();
    gates[0].resolve();
    await first;
    await expect(queued).rejects.toMatchObject({ name: 'HistoryDriverDetachedError' });
    expect([...recorded]).toEqual(['first']);
    session.dispose();
  });

  it('detaches when the session is disposed', async () => {
    const session = await memorySession();
    const sidecar = new MemoryHistorySidecar();
    const driver = attachHistorySidecar(session, sidecar, { intervalMs: 999_999 });
    session.dispose();
    await expect(driver.capture('late')).rejects.toMatchObject({ name: 'HistoryDriverDetachedError' });
    expect((await sidecar.entries()).length).toBe(0);
  });

  it('skips timer ticks while a capture is still in flight', async () => {
    vi.useFakeTimers();
    try {
      const session = await memorySession();
      const { sidecar, gates, recorded } = gatedSidecar();
      const driver = attachHistorySidecar(session, sidecar, { intervalMs: 10 });
      await vi.advanceTimersByTimeAsync(55);
      expect(recorded.length).toBe(1);
      // Settling the in-flight capture must not release a backlog of ticks
      // queued behind it: nothing more records until the next tick fires.
      gates[0].resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(recorded.length).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(recorded.length).toBe(2);
      driver.detach();
      session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
