/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildScheduleExtraction } from './build.js';
import type { ImportedTaskRow, ParsedScheduleSource } from './types.js';

function row(partial: Partial<ImportedTaskRow> & Pick<ImportedTaskRow, 'sourceId' | 'name' | 'outlineLevel'>): ImportedTaskRow {
  return {
    isMilestone: false,
    dependencies: [],
    ...partial,
  };
}

function source(rows: ImportedTaskRow[], projectName?: string): ParsedScheduleSource {
  return { rows, warnings: [], projectName };
}

describe('buildScheduleExtraction — hierarchy', () => {
  it('resolves parent/child links from outline levels 1,2,2,1', () => {
    const rows = [
      row({ sourceId: 'a', name: 'A', outlineLevel: 1 }),
      row({ sourceId: 'b', name: 'B', outlineLevel: 2 }),
      row({ sourceId: 'c', name: 'C', outlineLevel: 2 }),
      row({ sourceId: 'd', name: 'D', outlineLevel: 1 }),
    ];
    const { extraction } = buildScheduleExtraction(source(rows), { seed: 'seed-1' });
    const byName = new Map(extraction.tasks.map(t => [t.name, t]));
    const a = byName.get('A')!;
    const b = byName.get('B')!;
    const c = byName.get('C')!;
    const d = byName.get('D')!;

    assert.strictEqual(a.parentGlobalId, undefined);
    assert.strictEqual(b.parentGlobalId, a.globalId);
    assert.strictEqual(c.parentGlobalId, a.globalId);
    assert.strictEqual(d.parentGlobalId, undefined);

    assert.deepStrictEqual(a.childGlobalIds.sort(), [b.globalId, c.globalId].sort());
    assert.deepStrictEqual(d.childGlobalIds, []);
  });

  it('clamps an outline-level jump (1 -> 3) and warns', () => {
    const rows = [
      row({ sourceId: 'a', name: 'A', outlineLevel: 1 }),
      row({ sourceId: 'b', name: 'B', outlineLevel: 3 }),
    ];
    const { extraction, warnings } = buildScheduleExtraction(source(rows), { seed: 'seed-2' });
    const byName = new Map(extraction.tasks.map(t => [t.name, t]));
    // Clamped to parent-of-A + 1 == level 2, so B's parent is still A.
    assert.strictEqual(byName.get('B')!.parentGlobalId, byName.get('A')!.globalId);
    assert.ok(warnings.some(w => w.code === 'outline-level-jump'));
  });
});

describe('buildScheduleExtraction — dependencies', () => {
  it('drops a dependency on an unknown predecessor and warns', () => {
    const rows = [
      row({
        sourceId: 'a',
        name: 'A',
        outlineLevel: 1,
        dependencies: [{ predecessorSourceId: 'missing', type: 'FINISH_START' }],
      }),
    ];
    const { extraction, warnings } = buildScheduleExtraction(source(rows), { seed: 'seed-3' });
    assert.strictEqual(extraction.sequences.length, 0);
    assert.ok(warnings.some(w => w.code === 'unknown-predecessor'));
  });

  it('drops a self-referencing predecessor', () => {
    const rows = [
      row({
        sourceId: 'a',
        name: 'A',
        outlineLevel: 1,
        dependencies: [{ predecessorSourceId: 'a', type: 'FINISH_START' }],
      }),
    ];
    const { extraction, warnings } = buildScheduleExtraction(source(rows), { seed: 'seed-4' });
    assert.strictEqual(extraction.sequences.length, 0);
    assert.ok(warnings.some(w => w.code === 'unparsable-predecessor'));
  });

  it('keeps a valid dependency between two known tasks', () => {
    const rows = [
      row({ sourceId: 'a', name: 'A', outlineLevel: 1 }),
      row({
        sourceId: 'b',
        name: 'B',
        outlineLevel: 1,
        dependencies: [{ predecessorSourceId: 'a', type: 'FINISH_START', lagSeconds: 3600 }],
      }),
    ];
    const { extraction } = buildScheduleExtraction(source(rows), { seed: 'seed-5' });
    assert.strictEqual(extraction.sequences.length, 1);
    const seq = extraction.sequences[0]!;
    assert.strictEqual(seq.sequenceType, 'FINISH_START');
    assert.strictEqual(seq.timeLagSeconds, 3600);
    assert.strictEqual(seq.timeLagDuration, 'PT1H');
  });

  it('sets a matching timeLagDuration for a lag (positive)', () => {
    const rows = [
      row({ sourceId: 'a', name: 'A', outlineLevel: 1 }),
      row({
        sourceId: 'b',
        name: 'B',
        outlineLevel: 1,
        // "12SS+1 day"-style: a 1-day lag.
        dependencies: [{ predecessorSourceId: 'a', type: 'START_START', lagSeconds: 86_400 }],
      }),
    ];
    const { extraction } = buildScheduleExtraction(source(rows), { seed: 'seed-lag-pos' });
    const seq = extraction.sequences[0]!;
    assert.strictEqual(seq.timeLagSeconds, 86_400);
    assert.strictEqual(seq.timeLagDuration, 'P1D');
  });

  it('sets a matching signed timeLagDuration for a lead (negative lag)', () => {
    const rows = [
      row({ sourceId: 'a', name: 'A', outlineLevel: 1 }),
      row({
        sourceId: 'b',
        name: 'B',
        outlineLevel: 1,
        // "12SS-1 day"-style: a 1-day lead, negative lag.
        dependencies: [{ predecessorSourceId: 'a', type: 'START_START', lagSeconds: -86_400 }],
      }),
    ];
    const { extraction } = buildScheduleExtraction(source(rows), { seed: 'seed-lag-neg' });
    const seq = extraction.sequences[0]!;
    // PR #1963 maintainer ruling (reversing an earlier drop-the-sign
    // implementation): `timeLagDuration` now carries the ISO 8601-2 signed
    // form, agreeing with the signed `timeLagSeconds` rather than being
    // left unset. The interop tradeoff — some third-party `^P...`
    // IfcDuration parsers reject the leading "-" — is accepted in exchange
    // for a lossless ifc-lite round trip; see
    // packages/parser/src/iso8601-duration.ts.
    assert.strictEqual(seq.timeLagSeconds, -86_400);
    assert.strictEqual(seq.timeLagDuration, '-P1D');
  });
});

describe('buildScheduleExtraction — duplicate dependency edges', () => {
  it('dedupes an exact duplicate (same pred/succ/type/lag) with no duplicate GlobalId', () => {
    const rows = [
      row({ sourceId: 'a', name: 'A', outlineLevel: 1 }),
      row({
        sourceId: 'b',
        name: 'B',
        outlineLevel: 1,
        dependencies: [
          { predecessorSourceId: 'a', type: 'FINISH_START', lagSeconds: 3600 },
          { predecessorSourceId: 'a', type: 'FINISH_START', lagSeconds: 3600 },
        ],
      }),
    ];
    const { extraction, warnings } = buildScheduleExtraction(source(rows), { seed: 'dup-1' });
    assert.strictEqual(extraction.sequences.length, 1);
    // No warning for a genuinely identical duplicate — it carries no new
    // information, unlike the differing-lag case below.
    assert.ok(!warnings.some(w => w.code === 'duplicate-dependency'));
    // GlobalIds within the result must all be unique (the bug this guards:
    // two IfcRelSequence entities sharing a GlobalId, an IfcRoot violation).
    const ids = extraction.sequences.map(s => s.globalId);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it('keeps one edge and warns when duplicate edges disagree on lag', () => {
    const rows = [
      row({ sourceId: 'a', name: 'A', outlineLevel: 1 }),
      row({
        sourceId: 'b',
        name: 'B',
        outlineLevel: 1,
        dependencies: [
          { predecessorSourceId: 'a', type: 'FINISH_START', lagSeconds: 3600 },
          { predecessorSourceId: 'a', type: 'FINISH_START', lagSeconds: 7200 },
        ],
      }),
    ];
    const { extraction, warnings } = buildScheduleExtraction(source(rows), { seed: 'dup-2' });
    assert.strictEqual(extraction.sequences.length, 1);
    // First-seen lag is kept.
    assert.strictEqual(extraction.sequences[0]!.timeLagSeconds, 3600);
    assert.ok(warnings.some(w => w.code === 'duplicate-dependency'));
  });

  it('does not dedupe edges that differ in type or predecessor', () => {
    const rows = [
      row({ sourceId: 'a', name: 'A', outlineLevel: 1 }),
      row({ sourceId: 'b', name: 'B', outlineLevel: 1 }),
      row({
        sourceId: 'c',
        name: 'C',
        outlineLevel: 1,
        dependencies: [
          { predecessorSourceId: 'a', type: 'FINISH_START' },
          { predecessorSourceId: 'a', type: 'START_START' },
          { predecessorSourceId: 'b', type: 'FINISH_START' },
        ],
      }),
    ];
    const { extraction } = buildScheduleExtraction(source(rows), { seed: 'dup-3' });
    assert.strictEqual(extraction.sequences.length, 3);
  });
});

describe('buildScheduleExtraction — determinism', () => {
  it('produces identical GlobalIds when building twice from the same input', () => {
    const rows = [
      row({ sourceId: 'a', name: 'A', outlineLevel: 1 }),
      row({
        sourceId: 'b',
        name: 'B',
        outlineLevel: 1,
        dependencies: [{ predecessorSourceId: 'a', type: 'FINISH_START' }],
      }),
    ];
    const first = buildScheduleExtraction(source(rows), { seed: 'seed-6' });
    const second = buildScheduleExtraction(source(rows), { seed: 'seed-6' });
    assert.deepStrictEqual(
      first.extraction.tasks.map(t => t.globalId),
      second.extraction.tasks.map(t => t.globalId),
    );
    assert.strictEqual(first.extraction.workSchedules[0]!.globalId, second.extraction.workSchedules[0]!.globalId);
    assert.deepStrictEqual(
      first.extraction.sequences.map(s => s.globalId),
      second.extraction.sequences.map(s => s.globalId),
    );
  });
});

describe('buildScheduleExtraction — work schedule bounds', () => {
  it('sets start/finish to the min start / max finish across tasks', () => {
    const rows = [
      row({ sourceId: 'a', name: 'A', outlineLevel: 1, start: '2026-02-01T08:00:00', finish: '2026-02-05T17:00:00' }),
      row({ sourceId: 'b', name: 'B', outlineLevel: 1, start: '2026-01-10T08:00:00', finish: '2026-01-15T17:00:00' }),
      row({ sourceId: 'c', name: 'C', outlineLevel: 1, start: '2026-03-01T08:00:00', finish: '2026-03-10T17:00:00' }),
    ];
    const { extraction } = buildScheduleExtraction(source(rows), { seed: 'seed-7' });
    const ws = extraction.workSchedules[0]!;
    assert.strictEqual(ws.startTime, '2026-01-10T08:00:00');
    assert.strictEqual(ws.finishTime, '2026-03-10T17:00:00');
  });
});

describe('buildScheduleExtraction — deliberate scope boundary', () => {
  it('leaves productExpressIds and productGlobalIds empty on every task', () => {
    const rows = [row({ sourceId: 'a', name: 'A', outlineLevel: 1 })];
    const { extraction } = buildScheduleExtraction(source(rows), { seed: 'seed-8' });
    for (const t of extraction.tasks) {
      assert.deepStrictEqual(t.productExpressIds, []);
      assert.deepStrictEqual(t.productGlobalIds, []);
    }
  });
});
