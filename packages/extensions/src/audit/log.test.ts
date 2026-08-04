/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from './log.js';

describe('AuditLog — append + list', () => {
  it('assigns monotonic seqs', () => {
    const log = new AuditLog();
    const a = log.append({ kind: 'install', extensionId: 'ext-a' });
    const b = log.append({ kind: 'enable', extensionId: 'ext-a' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it('stamps ISO timestamps from the configured clock', () => {
    const fixed = new Date('2026-05-16T00:00:00.000Z');
    const log = new AuditLog({ now: () => fixed });
    const event = log.append({ kind: 'install', extensionId: 'ext-a' });
    expect(event.ts).toBe('2026-05-16T00:00:00.000Z');
  });

  it('list returns all events oldest-first', () => {
    const log = new AuditLog();
    log.append({ kind: 'install', extensionId: 'ext-a' });
    log.append({ kind: 'install', extensionId: 'ext-b' });
    const events = log.list();
    expect(events.map((e) => e.extensionId)).toEqual(['ext-a', 'ext-b']);
  });

  it('filters by extensionId', () => {
    const log = new AuditLog();
    log.append({ kind: 'install', extensionId: 'ext-a' });
    log.append({ kind: 'install', extensionId: 'ext-b' });
    expect(log.list({ extensionId: 'ext-b' })).toHaveLength(1);
  });

  it('filters by kind', () => {
    const log = new AuditLog();
    log.append({ kind: 'install', extensionId: 'a' });
    log.append({ kind: 'uninstall', extensionId: 'a' });
    expect(log.list({ kind: 'uninstall' })).toHaveLength(1);
  });

  it('filters by seq range', () => {
    const log = new AuditLog();
    for (let i = 0; i < 5; i += 1) {
      log.append({ kind: 'activate', extensionId: 'ext-a' });
    }
    expect(log.list({ sinceSeq: 2, untilSeq: 4 })).toHaveLength(3);
  });
});

describe('AuditLog — countByKind', () => {
  it('counts events per kind', () => {
    const log = new AuditLog();
    log.append({ kind: 'install', extensionId: 'a' });
    log.append({ kind: 'install', extensionId: 'b' });
    log.append({ kind: 'uninstall', extensionId: 'a' });
    const counts = log.countByKind();
    expect(counts.install).toBe(2);
    expect(counts.uninstall).toBe(1);
  });
});

describe('AuditLog — eviction', () => {
  it('evicts oldest when maxEvents exceeded', () => {
    const log = new AuditLog({ maxEvents: 3 });
    for (let i = 0; i < 5; i += 1) {
      log.append({ kind: 'install', extensionId: `ext-${i}` });
    }
    const events = log.list();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.extensionId)).toEqual(['ext-2', 'ext-3', 'ext-4']);
  });

  it('evicts when maxBytes exceeded', () => {
    // Each event JSON is ~80-100 bytes; cap at 200 means ~2 events fit.
    const log = new AuditLog({ maxBytes: 200, maxEvents: 1000 });
    log.append({ kind: 'install', extensionId: 'a' });
    log.append({ kind: 'install', extensionId: 'b' });
    log.append({ kind: 'install', extensionId: 'c' });
    expect(log.size()).toBeLessThanOrEqual(3);
    expect(log.byteSize()).toBeLessThanOrEqual(200);
  });

  it('seq does not reset across eviction', () => {
    const log = new AuditLog({ maxEvents: 2 });
    for (let i = 0; i < 5; i += 1) {
      log.append({ kind: 'install', extensionId: `ext-${i}` });
    }
    const events = log.list();
    expect(events[events.length - 1].seq).toBe(5);
  });
});

describe('AuditLog — exportJson', () => {
  it('produces a self-describing JSON envelope', () => {
    const log = new AuditLog({ now: () => new Date('2026-01-01') });
    log.append({ kind: 'install', extensionId: 'ext-a' });
    const json = log.exportJson();
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('AuditLog — clear', () => {
  it('drops events but keeps seq', () => {
    const log = new AuditLog();
    log.append({ kind: 'install', extensionId: 'a' });
    log.clear();
    expect(log.size()).toBe(0);
    const next = log.append({ kind: 'install', extensionId: 'b' });
    expect(next.seq).toBe(2);
  });
});

describe('AuditLog — faulting listeners', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('warns once per faulting listener and keeps delivering to the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = new AuditLog();
    const bad = () => { throw new Error('subscriber blew up'); };
    const seen: string[] = [];
    log.subscribe(bad);
    log.subscribe((e) => { seen.push(e.extensionId); });

    log.append({ kind: 'install', extensionId: 'ext-a' });
    log.append({ kind: 'install', extensionId: 'ext-b' });
    log.append({ kind: 'install', extensionId: 'ext-c' });

    // Every event still reaches the healthy listener.
    expect(seen).toEqual(['ext-a', 'ext-b', 'ext-c']);
    // ...and the fault is reported exactly once, not once per event.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('[audit]');
  });

  it('latches per listener, so a second faulting subscriber still warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = new AuditLog();
    log.subscribe(() => { throw new Error('one'); });
    log.subscribe(() => { throw new Error('two'); });
    log.append({ kind: 'install', extensionId: 'ext-a' });
    log.append({ kind: 'install', extensionId: 'ext-b' });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
