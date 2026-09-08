/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadDrawing2DEntry,
  saveDrawing2DEntry,
  clearAllDrawing2DEntries,
  keyFor,
  type PersistedDrawing2DEntry,
} from './drawing2DSlice.persistence.js';
import { getDefaultDrawing2DState } from './drawing2DSlice.js';
import type { Measure2DResult, PolygonArea2DResult, TextAnnotation2D, CloudAnnotation2D } from './drawing2DSlice.js';

const DEFAULT_DISPLAY_OPTIONS = getDefaultDrawing2DState().drawing2DDisplayOptions;

function installStubStorage(opts?: { throwing?: boolean }): { wipe: () => void } {
  const data = new Map<string, string>();
  const throwing = opts?.throwing ?? false;
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => {
      if (throwing) throw new DOMException('blocked', 'SecurityError');
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throwing) throw new DOMException('quota exceeded', 'QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
  } as Storage;
  return { wipe: () => data.clear() };
}

function sampleMeasure(id = 'm1'): Measure2DResult {
  return { id, start: { x: 0, y: 0 }, end: { x: 3, y: 4 }, distance: 5 };
}

function samplePolygon(id = 'p1'): PolygonArea2DResult {
  return {
    id,
    points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }],
    area: 12,
    perimeter: 14,
  };
}

function sampleText(id = 't1'): TextAnnotation2D {
  return {
    id,
    position: { x: 1, y: 1 },
    text: 'Defect here',
    fontSize: 14,
    color: '#000000',
    backgroundColor: '#ffffff',
    borderColor: '#cccccc',
  };
}

function sampleCloud(id = 'c1'): CloudAnnotation2D {
  return {
    id,
    points: [{ x: 0, y: 0 }, { x: 2, y: 2 }],
    color: '#E53935',
    label: 'Rev A',
  };
}

function sampleEntry(overrides?: Partial<Omit<PersistedDrawing2DEntry, 'savedAt'>>): Omit<PersistedDrawing2DEntry, 'savedAt'> {
  return {
    measure2DResults: [sampleMeasure()],
    polygonArea2DResults: [samplePolygon()],
    textAnnotations2D: [sampleText()],
    cloudAnnotations2D: [sampleCloud()],
    drawing2DDisplayOptions: DEFAULT_DISPLAY_OPTIONS,
    sectionConfig: null,
    ...overrides,
  };
}

describe('drawing2DSlice persistence', () => {
  // Several cases below deliberately corrupt a localStorage entry to prove the
  // production code degrades gracefully (readEntryRaw catches JSON.parse and
  // logs via console.warn). Left unstubbed, that warning's real SyntaxError
  // text lands in the runner's captured stdout, which the revert-oracle's
  // load-failure heuristic matches on regardless of test outcome (#4159 CI).
  const realWarn = console.warn;
  beforeEach(() => {
    console.warn = () => { /* keep the intentional parse-failure warning out of test output */ };
    installStubStorage();
    clearAllDrawing2DEntries();
  });
  afterEach(() => {
    console.warn = realWarn;
  });

  describe('round-trip', () => {
    it('writes state under a model hash and reads it back after a fresh load', () => {
      saveDrawing2DEntry('hash-a', sampleEntry());

      const restored = loadDrawing2DEntry('hash-a', DEFAULT_DISPLAY_OPTIONS);
      assert.ok(restored);
      assert.strictEqual(restored!.measure2DResults.length, 1);
      assert.strictEqual(restored!.measure2DResults[0].id, 'm1');
      assert.strictEqual(restored!.polygonArea2DResults[0].id, 'p1');
      assert.strictEqual(restored!.textAnnotations2D[0].id, 't1');
      assert.strictEqual(restored!.cloudAnnotations2D[0].id, 'c1');
    });

    it('round-trips a persisted SectionConfig', () => {
      const sectionConfig = {
        plane: { axis: 'z' as const, position: 1.5, flipped: false },
        projectionDepth: 10,
        includeHiddenLines: true,
        creaseAngle: 30,
        scale: 100,
      };
      saveDrawing2DEntry('hash-a', sampleEntry({ sectionConfig }));
      const restored = loadDrawing2DEntry('hash-a', DEFAULT_DISPLAY_OPTIONS);
      assert.deepStrictEqual(restored!.sectionConfig, sectionConfig);
    });

    it('round-trips custom display options', () => {
      const options = { ...DEFAULT_DISPLAY_OPTIONS, scale: 50, showHiddenLines: false };
      saveDrawing2DEntry('hash-a', sampleEntry({ drawing2DDisplayOptions: options }));
      const restored = loadDrawing2DEntry('hash-a', DEFAULT_DISPLAY_OPTIONS);
      assert.strictEqual(restored!.drawing2DDisplayOptions.scale, 50);
      assert.strictEqual(restored!.drawing2DDisplayOptions.showHiddenLines, false);
    });
  });

  describe('model scoping — MUTATION TARGET 1', () => {
    it('does not leak markup saved under one model hash into a lookup for a different one', () => {
      saveDrawing2DEntry('hash-a', sampleEntry());

      const forOtherModel = loadDrawing2DEntry('hash-b', DEFAULT_DISPLAY_OPTIONS);
      assert.strictEqual(forOtherModel, null);
    });

    it('keeps two models fully independent, each under its own localStorage key', () => {
      saveDrawing2DEntry('hash-a', sampleEntry({ measure2DResults: [sampleMeasure('a-measure')] }));
      saveDrawing2DEntry('hash-b', sampleEntry({ measure2DResults: [sampleMeasure('b-measure')] }));

      const a = loadDrawing2DEntry('hash-a', DEFAULT_DISPLAY_OPTIONS);
      const b = loadDrawing2DEntry('hash-b', DEFAULT_DISPLAY_OPTIONS);
      assert.strictEqual(a!.measure2DResults[0].id, 'a-measure');
      assert.strictEqual(b!.measure2DResults[0].id, 'b-measure');
    });

    it('a corrupt entry for one model does not destroy other models\' entries (#4159)', () => {
      // Reproduces the shared-blob cascade: under the old single-key design,
      // `saveDrawing2DEntry` read the WHOLE blob, degraded it to `{}` on a
      // parse failure, and wrote that `{}` (plus only the new entry) back
      // over every other model's data. One model's own real save is exactly
      // the trigger — nothing exotic has to touch the corrupt key itself.
      saveDrawing2DEntry('hash-a', sampleEntry({ measure2DResults: [sampleMeasure('a-measure')] }));
      saveDrawing2DEntry('hash-b', sampleEntry({ measure2DResults: [sampleMeasure('b-measure')] }));

      (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(keyFor('hash-a'), '{not valid json');

      // An ordinary save for a THIRD, unrelated model — the real-world
      // trigger (any user drawing on any model after one entry corrupts).
      saveDrawing2DEntry('hash-c', sampleEntry({ measure2DResults: [sampleMeasure('c-measure')] }));

      const b = loadDrawing2DEntry('hash-b', DEFAULT_DISPLAY_OPTIONS);
      assert.ok(b, 'model B\'s entry must survive a save for an unrelated model C while A is corrupt');
      assert.strictEqual(b!.measure2DResults[0].id, 'b-measure');

      const c = loadDrawing2DEntry('hash-c', DEFAULT_DISPLAY_OPTIONS);
      assert.ok(c, 'the triggering save itself must still land');
      assert.strictEqual(c!.measure2DResults[0].id, 'c-measure');

      // A's own corruption is real and un-recovered — that part is expected.
      assert.strictEqual(loadDrawing2DEntry('hash-a', DEFAULT_DISPLAY_OPTIONS), null);
    });
  });

  describe('malformed storage — MUTATION TARGET 2', () => {
    it('returns null (never throws) for a JSON parse failure and lets the caller fall back to defaults', () => {
      (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(keyFor('hash-a'), '{not valid json');
      assert.doesNotThrow(() => {
        const result = loadDrawing2DEntry('hash-a', DEFAULT_DISPLAY_OPTIONS);
        assert.strictEqual(result, null);
      });
    });

    it('returns null for a stored value that is an array instead of an entry object', () => {
      (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(keyFor('hash-a'), '[1,2,3]');
      const result = loadDrawing2DEntry('hash-a', DEFAULT_DISPLAY_OPTIONS);
      assert.strictEqual(result, null);
    });

    it('skips a malformed entry (missing required arrays) for one hash without throwing', () => {
      (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(
        keyFor('hash-a'),
        JSON.stringify({ measure2DResults: 'not-an-array' }),
      );
      const result = loadDrawing2DEntry('hash-a', DEFAULT_DISPLAY_OPTIONS);
      assert.strictEqual(result, null);
    });

    it('filters out individually-malformed array entries rather than rejecting the whole load', () => {
      saveDrawing2DEntry('hash-a', sampleEntry());
      const raw = JSON.parse((globalThis as unknown as { localStorage: Storage }).localStorage.getItem(keyFor('hash-a'))!);
      raw.measure2DResults.push({ id: 'bad', start: { x: 'oops' } });
      (globalThis as unknown as { localStorage: Storage }).localStorage.setItem(keyFor('hash-a'), JSON.stringify(raw));

      const result = loadDrawing2DEntry('hash-a', DEFAULT_DISPLAY_OPTIONS);
      assert.strictEqual(result!.measure2DResults.length, 1);
      assert.strictEqual(result!.measure2DResults[0].id, 'm1');
    });

    it('falls back to the caller-supplied defaults for a corrupt sectionConfig instead of dropping the whole entry', () => {
      saveDrawing2DEntry('hash-a', sampleEntry({ sectionConfig: { plane: {}, projectionDepth: 'nope' } as never }));
      const result = loadDrawing2DEntry('hash-a', DEFAULT_DISPLAY_OPTIONS);
      assert.ok(result);
      assert.strictEqual(result!.sectionConfig, null);
      assert.strictEqual(result!.measure2DResults.length, 1);
    });
  });

  describe('storage unavailable — MUTATION TARGET 3', () => {
    it('save degrades silently when localStorage throws (private window / blocked storage)', () => {
      installStubStorage({ throwing: true });
      assert.doesNotThrow(() => saveDrawing2DEntry('hash-a', sampleEntry()));
    });

    it('load degrades to null when localStorage throws', () => {
      installStubStorage({ throwing: true });
      assert.doesNotThrow(() => {
        const result = loadDrawing2DEntry('hash-a', DEFAULT_DISPLAY_OPTIONS);
        assert.strictEqual(result, null);
      });
    });

    it('load returns null (app starts at defaults) when localStorage is undefined', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).localStorage;
      assert.doesNotThrow(() => {
        const result = loadDrawing2DEntry('hash-a', DEFAULT_DISPLAY_OPTIONS);
        assert.strictEqual(result, null);
      });
      installStubStorage();
    });
  });

  describe('drawing2D is never persisted', () => {
    it('PersistedDrawing2DEntry has no drawing2D field in what actually gets written', () => {
      saveDrawing2DEntry('hash-a', sampleEntry());
      const raw = (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(keyFor('hash-a'))!;
      const parsed = JSON.parse(raw);
      assert.ok(!('drawing2D' in parsed));
    });
  });

  describe('eviction', () => {
    it('drops the oldest entry once more than 20 distinct models are saved', async () => {
      for (let i = 0; i < 21; i++) {
        saveDrawing2DEntry(`hash-${i}`, sampleEntry());
        // Force distinct savedAt ordering across iterations.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 1));
      }
      assert.strictEqual(loadDrawing2DEntry('hash-0', DEFAULT_DISPLAY_OPTIONS), null);
      assert.ok(loadDrawing2DEntry('hash-20', DEFAULT_DISPLAY_OPTIONS));
    });
  });
});
