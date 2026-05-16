/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { ActionLog } from './writer.js';

describe('ActionLog — append', () => {
  it('assigns monotonic seqs and stamps timestamps', () => {
    const fixed = new Date('2026-05-16T00:00:00.000Z');
    const log = new ActionLog({ now: () => fixed });
    const a = log.append({ intent: 'model.load', params: { schema: 'IFC4' } });
    const b = log.append({ intent: 'query.run', params: { type: 'IfcWall' } });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.ts).toBe('2026-05-16T00:00:00.000Z');
  });

  it('defaults success to true', () => {
    const log = new ActionLog();
    const e = log.append({ intent: 'lens.apply', params: { id: 'fire' } });
    expect(e.success).toBe(true);
  });

  it('records params verbatim', () => {
    const log = new ActionLog();
    const e = log.append({ intent: 'export.run', params: { format: 'csv', entityCount: 42 } });
    expect(e.params).toEqual({ format: 'csv', entityCount: 42 });
  });
});

describe('ActionLog — list + filter', () => {
  it('filters by intent', () => {
    const log = new ActionLog();
    log.append({ intent: 'model.load', params: { schema: 'IFC4' } });
    log.append({ intent: 'query.run', params: { type: 'IfcWall' } });
    log.append({ intent: 'query.run', params: { type: 'IfcDoor' } });
    expect(log.list({ intent: 'query.run' })).toHaveLength(2);
  });

  it('filters by seq range', () => {
    const log = new ActionLog();
    for (let i = 0; i < 5; i += 1) {
      log.append({ intent: 'view.change', params: { mode: '3d' } });
    }
    expect(log.list({ sinceSeq: 2, untilSeq: 4 })).toHaveLength(3);
  });

  it('countByIntent', () => {
    const log = new ActionLog();
    log.append({ intent: 'model.load', params: {} });
    log.append({ intent: 'model.load', params: {} });
    log.append({ intent: 'query.run', params: {} });
    const counts = log.countByIntent();
    expect(counts['model.load']).toBe(2);
    expect(counts['query.run']).toBe(1);
  });
});

describe('ActionLog — eviction', () => {
  it('evicts oldest when maxEvents exceeded', () => {
    const log = new ActionLog({ maxEvents: 3 });
    for (let i = 0; i < 5; i += 1) {
      log.append({ intent: 'lens.apply', params: { id: `lens-${i}` } });
    }
    expect(log.size()).toBe(3);
    const last = log.list();
    expect((last[last.length - 1].params as { id: string }).id).toBe('lens-4');
  });

  it('uses UTF-8 byte size for byte cap', () => {
    const log = new ActionLog({ maxBytes: 1000 });
    log.append({ intent: 'chat.message', params: { intent: 'one-shot' } });
    expect(log.byteSize()).toBeGreaterThan(0);
    expect(log.byteSize()).toBeLessThan(1000);
  });
});

describe('ActionLog — subscribe', () => {
  it('emits new events to subscribers', () => {
    const log = new ActionLog();
    const listener = vi.fn();
    log.subscribe(listener);
    log.append({ intent: 'extension.install', params: { id: 'com.example.x' } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops further emissions', () => {
    const log = new ActionLog();
    const listener = vi.fn();
    const off = log.subscribe(listener);
    off();
    log.append({ intent: 'extension.install', params: { id: 'com.example.x' } });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('ActionLog — exportJson + clear', () => {
  it('exportJson includes header + events', () => {
    const log = new ActionLog({ now: () => new Date('2026-01-01') });
    log.append({ intent: 'model.load', params: { schema: 'IFC4' } });
    const j = JSON.parse(log.exportJson());
    expect(j.version).toBe(1);
    expect(j.events).toHaveLength(1);
  });

  it('clear preserves seq counter', () => {
    const log = new ActionLog();
    log.append({ intent: 'lens.apply', params: { id: 'a' } });
    log.clear();
    const next = log.append({ intent: 'lens.apply', params: { id: 'b' } });
    expect(next.seq).toBe(2);
  });
});
