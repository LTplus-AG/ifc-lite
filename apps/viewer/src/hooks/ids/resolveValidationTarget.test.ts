/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  resolveValidationTarget,
  type ValidationTargetModel,
} from './resolveValidationTarget.js';
import type { IfcDataStore } from '@ifc-lite/parser';

// Minimal stand-ins: the resolver only ever reads/returns the store by
// reference, so an opaque tagged object is enough to assert identity.
const store = (tag: string): IfcDataStore => ({ __tag: tag } as unknown as IfcDataStore);

const model = (s: IfcDataStore | null): ValidationTargetModel => ({ ifcDataStore: s });

describe('resolveValidationTarget (#1702 C1)', () => {
  it('explicit target with a data store returns that model + store (no fallback)', () => {
    const a = store('a');
    const b = store('b');
    const models = new Map([
      ['m-a', model(a)],
      ['m-b', model(b)],
    ]);
    const result = resolveValidationTarget({
      targetModelId: 'm-b',
      activeModelId: 'm-a',
      models,
      legacyDataStore: null,
    });
    assert.deepStrictEqual(result, { modelId: 'm-b', dataStore: b });
  });

  it('explicit target WITHOUT a data store errors and does NOT fall back', () => {
    const a = store('a');
    const models = new Map([
      ['m-a', model(a)],
      ['m-geom', model(null)], // geometry-only / mid-load / cache-restored
    ]);
    const result = resolveValidationTarget({
      targetModelId: 'm-geom',
      activeModelId: 'm-a',
      models,
      legacyDataStore: a,
    });
    assert.ok('error' in result, 'expected an error result');
    // Crucially, it must not silently return the active model's store.
    assert.ok(!('dataStore' in result));
  });

  it('explicit unknown target id errors', () => {
    const a = store('a');
    const models = new Map([['m-a', model(a)]]);
    const result = resolveValidationTarget({
      targetModelId: 'does-not-exist',
      activeModelId: 'm-a',
      models,
      legacyDataStore: null,
    });
    assert.ok('error' in result);
  });

  it('no target resolves to the active model', () => {
    const a = store('a');
    const b = store('b');
    const models = new Map([
      ['m-a', model(a)],
      ['m-b', model(b)],
    ]);
    const result = resolveValidationTarget({
      activeModelId: 'm-b',
      models,
      legacyDataStore: null,
    });
    assert.deepStrictEqual(result, { modelId: 'm-b', dataStore: b });
  });

  it('no target and no active model resolves to the first loaded model', () => {
    const a = store('a');
    const b = store('b');
    const models = new Map([
      ['m-a', model(a)],
      ['m-b', model(b)],
    ]);
    const result = resolveValidationTarget({
      activeModelId: null,
      models,
      legacyDataStore: null,
    });
    assert.deepStrictEqual(result, { modelId: 'm-a', dataStore: a });
  });

  it('legacy single-model path is preserved (no models, legacy store)', () => {
    const legacy = store('legacy');
    const result = resolveValidationTarget({
      activeModelId: null,
      models: new Map(),
      legacyDataStore: legacy,
    });
    assert.deepStrictEqual(result, { modelId: '__legacy__', dataStore: legacy });
  });

  it('no target, active model missing its store, falls back to legacy paired with __legacy__', () => {
    const legacy = store('legacy');
    const models = new Map([['m-a', model(null)]]);
    const result = resolveValidationTarget({
      activeModelId: 'm-a',
      models,
      legacyDataStore: legacy,
    });
    // Active model has no store and no other model does either; the no-target
    // path falls back to the legacy store, but the modelId must stay coupled to
    // that store (the '__legacy__' sentinel), never the active model's id.
    assert.deepStrictEqual(result, { modelId: '__legacy__', dataStore: legacy });
  });

  it('no target, first model has no store, resolves to the second (coupled pair)', () => {
    const b = store('b');
    // Insertion order: m-a first (storeless), m-b second (loaded).
    const models = new Map([
      ['m-a', model(null)],
      ['m-b', model(b)],
    ]);
    const result = resolveValidationTarget({
      activeModelId: null,
      models,
      legacyDataStore: null,
    });
    // Must skip the storeless first entry and return the SECOND model with its
    // own store, never erroring on the empty first entry.
    assert.deepStrictEqual(result, { modelId: 'm-b', dataStore: b });
  });

  it('nothing loaded at all errors', () => {
    const result = resolveValidationTarget({
      activeModelId: null,
      models: new Map(),
      legacyDataStore: null,
    });
    assert.ok('error' in result);
  });
});
