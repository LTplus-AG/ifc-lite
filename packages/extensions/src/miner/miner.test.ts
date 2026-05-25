/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { ActionEvent, ActionIntent } from '../log/types.js';
import { mineSequences, splitSessions } from './sequence.js';
import { scorePatterns, topPatterns } from './score.js';

let seq = 1;
function event(intent: ActionIntent, ts: string): ActionEvent {
  return {
    seq: seq++,
    ts,
    intent,
    params: {} as never,
    success: true,
  } as ActionEvent;
}

function sessionEvents(intents: ActionIntent[], baseTs: string): ActionEvent[] {
  return intents.map((intent, i) => {
    const date = new Date(baseTs);
    date.setSeconds(date.getSeconds() + i);
    return event(intent, date.toISOString());
  });
}

describe('splitSessions', () => {
  it('groups events within the gap', () => {
    const events = sessionEvents(['model.load', 'query.run', 'export.run'], '2026-01-01T10:00:00.000Z');
    const sessions = splitSessions(events, 60_000);
    expect(sessions).toHaveLength(1);
  });

  it('splits on long gaps', () => {
    const morning = sessionEvents(['model.load'], '2026-01-01T08:00:00.000Z');
    const afternoon = sessionEvents(['query.run'], '2026-01-01T14:00:00.000Z');
    const sessions = splitSessions([...morning, ...afternoon], 60_000);
    expect(sessions).toHaveLength(2);
  });
});

describe('mineSequences', () => {
  it('finds the obvious 3-step pattern across multiple sessions', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
    const events: ActionEvent[] = [];
    for (const day of days) {
      events.push(...sessionEvents(['model.load', 'lens.apply', 'export.run'], `${day}T10:00:00.000Z`));
    }
    const patterns = mineSequences(events, { minOccurrences: 3, minSessions: 2 });
    const triple = patterns.find((p) => p.sequence.join('>') === 'model.load>lens.apply>export.run');
    expect(triple).toBeDefined();
    expect(triple?.occurrences).toBe(4);
    expect(triple?.sessionsTouched).toBe(4);
  });

  it('respects minOccurrences', () => {
    const events = [
      ...sessionEvents(['model.load', 'lens.apply'], '2026-01-01T10:00:00.000Z'),
      ...sessionEvents(['model.load', 'lens.apply'], '2026-01-02T10:00:00.000Z'),
    ];
    const patterns = mineSequences(events, { minOccurrences: 3 });
    expect(patterns).toEqual([]);
  });

  it('respects minSessions', () => {
    const events = sessionEvents(
      ['model.load', 'lens.apply', 'model.load', 'lens.apply', 'model.load', 'lens.apply'],
      '2026-01-01T10:00:00.000Z',
    );
    const patterns = mineSequences(events, { minOccurrences: 2, minSessions: 2 });
    expect(patterns).toEqual([]);
  });

  it('does not surface patterns longer than maxLength', () => {
    const days = ['2026-01-01', '2026-01-02', '2026-01-03'];
    const events: ActionEvent[] = [];
    for (const day of days) {
      events.push(...sessionEvents(['model.load', 'lens.apply', 'query.run', 'export.run', 'view.change'], `${day}T10:00:00.000Z`));
    }
    const patterns = mineSequences(events, { maxLength: 2 });
    expect(patterns.every((p) => p.sequence.length <= 2)).toBe(true);
  });
});

describe('scorePatterns', () => {
  it('ranks recent + frequent patterns higher', () => {
    const days = ['2026-04-01', '2026-04-02', '2026-04-03'];
    const recent: ActionEvent[] = [];
    for (const day of days) {
      recent.push(...sessionEvents(['model.load', 'lens.apply'], `${day}T10:00:00.000Z`));
    }
    const stale: ActionEvent[] = [];
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      stale.push(...sessionEvents(['model.load', 'query.run'], `${day}T10:00:00.000Z`));
    }
    const patterns = mineSequences([...recent, ...stale], { minOccurrences: 2, minSessions: 2 });
    const now = new Date('2026-04-10T00:00:00.000Z');
    const scored = scorePatterns(patterns, { now });
    expect(scored[0].sequence.join('>')).toBe('model.load>lens.apply');
  });

  it('topPatterns truncates', () => {
    const events: ActionEvent[] = [];
    for (const day of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      events.push(...sessionEvents(['model.load', 'lens.apply', 'export.run'], `${day}T10:00:00.000Z`));
    }
    const patterns = mineSequences(events, { minOccurrences: 3, minSessions: 3 });
    expect(topPatterns(patterns, 1)).toHaveLength(1);
  });
});
