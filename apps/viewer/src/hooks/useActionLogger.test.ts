/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  detectActions,
  hashLensId,
  type ActionLoggerStateShape,
} from './useActionLogger.js';

function makeState(over: Partial<ActionLoggerStateShape> = {}): ActionLoggerStateShape {
  return {
    models: over.models ?? new Map(),
    activeLensId: over.activeLensId ?? null,
    selectedEntities: over.selectedEntities ?? [],
    sectionPlane: over.sectionPlane,
    drawing2DPanelVisible: over.drawing2DPanelVisible,
  };
}

describe('hashLensId', () => {
  it('produces a stable 8-char hex token', () => {
    const h1 = hashLensId('by-fire-rating');
    const h2 = hashLensId('by-fire-rating');
    assert.strictEqual(h1, h2);
    assert.match(h1, /^lens-[0-9a-f]{8}$/);
  });

  it('distinguishes distinct ids', () => {
    assert.notStrictEqual(hashLensId('foo'), hashLensId('bar'));
  });

  it('does not leak the original string', () => {
    const h = hashLensId("John's basement check");
    assert.ok(!h.includes('John'));
    assert.ok(!h.includes('basement'));
  });
});

describe('detectActions', () => {
  it('emits model.load when a model is added', () => {
    const prev = makeState();
    const next = makeState({
      models: new Map([['m1', { schemaVersion: 'IFC4', ifcDataStore: { entityCount: 100 }, fileSize: 5000 }]]),
    });
    const events = detectActions(prev, next);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].intent, 'model.load');
    if (events[0].intent === 'model.load') {
      assert.strictEqual(events[0].params.schema, 'IFC4');
      assert.strictEqual(events[0].params.entityCount, 100);
      assert.strictEqual(events[0].params.sizeBytes, 5000);
    }
  });

  it('emits model.unload when a model is removed', () => {
    const prev = makeState({
      models: new Map([['m1', { schemaVersion: 'IFC4', ifcDataStore: null, fileSize: 0 }]]),
    });
    const next = makeState();
    const events = detectActions(prev, next);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].intent, 'model.unload');
  });

  it('emits both load and unload on a same-size swap', () => {
    const prev = makeState({
      models: new Map([['old', { schemaVersion: 'IFC4', ifcDataStore: null, fileSize: 0 }]]),
    });
    const next = makeState({
      models: new Map([['new', { schemaVersion: 'IFC4', ifcDataStore: null, fileSize: 0 }]]),
    });
    const events = detectActions(prev, next);
    const intents = events.map((e) => e.intent).sort();
    assert.deepStrictEqual(intents, ['model.load', 'model.unload']);
  });

  it('hashes lens ids before emitting lens.apply', () => {
    const prev = makeState();
    const next = makeState({ activeLensId: "John's basement" });
    const events = detectActions(prev, next);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].intent, 'lens.apply');
    if (events[0].intent === 'lens.apply') {
      assert.ok(!events[0].params.id?.includes('John'));
      assert.match(events[0].params.id ?? '', /^lens-/);
    }
  });

  it('emits lens.clear when lens is unset', () => {
    const prev = makeState({ activeLensId: 'foo' });
    const next = makeState({ activeLensId: null });
    const events = detectActions(prev, next);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].intent, 'lens.clear');
  });

  it('emits selection.change only on count delta', () => {
    const prev = makeState({ selectedEntities: [1, 2, 3] });
    const next = makeState({ selectedEntities: [1, 2, 3] }); // same count
    assert.strictEqual(detectActions(prev, next).length, 0);

    const next2 = makeState({ selectedEntities: [1, 2] });
    const events = detectActions(prev, next2);
    assert.strictEqual(events.length, 1);
    if (events[0].intent === 'selection.change') {
      assert.strictEqual(events[0].params.count, 2);
    }
  });

  it('emits section.apply on enable transition only', () => {
    // false → true emits.
    const prev = makeState({ sectionPlane: { enabled: false } });
    const next = makeState({ sectionPlane: { enabled: true } });
    assert.strictEqual(detectActions(prev, next).length, 1);
    // true → true does not emit.
    const events = detectActions(next, next);
    assert.strictEqual(events.length, 0);
  });

  it('emits view.change on 2d/3d mode flip', () => {
    const prev = makeState({ drawing2DPanelVisible: false });
    const next = makeState({ drawing2DPanelVisible: true });
    const events = detectActions(prev, next);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].intent, 'view.change');
    if (events[0].intent === 'view.change') {
      assert.strictEqual(events[0].params.mode, '2d');
    }
  });

  it('emits exactly one event per unique transition (no duplicates)', () => {
    const prev = makeState();
    const next = makeState({
      models: new Map([['m1', { schemaVersion: 'IFC4', ifcDataStore: null, fileSize: 0 }]]),
      activeLensId: 'lens-1',
      selectedEntities: [1],
      sectionPlane: { enabled: true },
      drawing2DPanelVisible: true,
    });
    const events = detectActions(prev, next);
    const intents = events.map((e) => e.intent).sort();
    assert.deepStrictEqual(
      intents,
      ['lens.apply', 'model.load', 'section.apply', 'selection.change', 'view.change'],
    );
  });

  it('returns an empty array when state is identical', () => {
    const state = makeState({
      models: new Map([['m1', { schemaVersion: 'IFC4', ifcDataStore: null, fileSize: 0 }]]),
      activeLensId: 'lens-1',
      selectedEntities: [1],
      sectionPlane: { enabled: true },
      drawing2DPanelVisible: true,
    });
    assert.strictEqual(detectActions(state, state).length, 0);
  });
});
