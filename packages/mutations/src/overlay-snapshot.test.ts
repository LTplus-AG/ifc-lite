/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from './mutable-property-view.js';
import { StoreEditor } from './store-editor.js';
import { snapshotOverlay, restoreOverlay, OverlaySourceMismatchError } from './overlay-snapshot.js';
import type { OverlaySnapshotV1 } from './overlay-snapshot-types.js';

const HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const options = { sourceContentHash: HASH };
const compatibility = readFileSync(new URL('./fixtures/overlay-snapshot-v1.json', import.meta.url), 'utf8');
function dto(view: MutablePropertyView): OverlaySnapshotV1 { return JSON.parse(snapshotOverlay(view, options)) as OverlaySnapshotV1; }
function fixture() {
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor({ entityIndex: { byId: new Map() } }, view);
  const entity = editor.addEntity('IfcColourRgb', [null, 1, 0, 0]);
  return { view, editor, id: entity.expressId };
}

describe('versioned overlay persistence (#8453)', () => {
  it('restores the committed v1 format and rebuilds class lookup/allocator', () => {
    const view = new MutablePropertyView(null, 'm');
    restoreOverlay(view, compatibility, options);
    expect(Array.from(view.getNewEntitiesOfType('IFCWALL'), row => row.expressId)).toEqual([42]);
    expect(view.getPropertyValue(42, 'Pset:Persistence', 'Fire:Rating')).toBe('REI60');
    expect(view.createEntity('IFCWALL', []).expressId).toBe(43);
  });

  it('preserves skip-history logical targets and nonfinite nested attribute/quantity values', () => {
    const { view, id } = fixture();
    view.setProperty(id, 'Pset:A', 'Name:B', 'persisted', PropertyValueType.String, undefined, true);
    view.setQuantity(id, 'Qto:A', 'Length:B', Infinity, QuantityType.Length, undefined, true);
    view.setPositionalAttribute(id, 1, [{ real: NaN }, { typed: { type: 'IfcReal', value: -Infinity } }, -0], true);
    const json = snapshotOverlay(view, options), copy = new MutablePropertyView(null, 'm');
    restoreOverlay(copy, json, options);
    expect(dto(copy).state.properties[0].slice(0, 3)).toEqual([id, 'Pset:A', 'Name:B']);
    expect(copy.getPropertyValue(id, 'Pset:A', 'Name:B')).toBe('persisted');
    expect(copy.getQuantityMutation(id, 'Qto:A', 'Length:B')?.value).toBe(Infinity);
    const values = copy.getPositionalMutationsForEntity(id)?.get(1);
    expect(values).toEqual([{ real: NaN }, { typed: { type: 'IfcReal', value: -Infinity } }, -0]);
    expect(copy.getMutations()).toEqual(view.getMutations());
  });

  it('preserves forgotten rows through restore and undo-of-delete, including colon names', () => {
    const { view, id } = fixture();
    view.setProperty(id, 'Custom:A', 'Fire:B', 'yes');
    const parked = structuredClone(view.getNewEntity(id)!);
    view.deleteEntity(id);
    const copy = new MutablePropertyView(null, 'm');
    restoreOverlay(copy, snapshotOverlay(view, options), options);
    expect(copy.getEffectiveChanges()).toHaveLength(0);
    copy.restoreNewEntity(parked);
    expect(copy.getPropertyValue(id, 'Custom:A', 'Fire:B')).toBe('yes');
    expect(dto(copy).state.properties[0].slice(0, 3)).toEqual([id, 'Custom:A', 'Fire:B']);
    expect(copy.peekNextExpressId()).toBeGreaterThan(id);
  });

  it('keeps whole-set undo/redo usable after JSON restore', () => {
    const { view, id } = fixture();
    view.setProperty(id, 'Pset:A', 'First:B', 'before');
    const edit = view.createPropertySet(id, 'Pset:A', [{ name: 'Second:C', value: 'after' }]);
    const copy = new MutablePropertyView(null, 'm');
    restoreOverlay(copy, snapshotOverlay(view, options), options);
    const restored = copy.getMutations().find(row => row.id === edit.id)!;
    copy.restoreSetOverlay(restored.setOverlay!.before);
    expect(copy.getPropertyValue(id, 'Pset:A', 'First:B')).toBe('before');
    copy.restoreSetOverlay(restored.setOverlay!.after);
    expect(copy.getPropertyValue(id, 'Pset:A', 'Second:C')).toBe('after');
    expect(() => snapshotOverlay(copy, options)).not.toThrow();
  });

  it('rejects mismatched sources atomically and leaves pending transactions valid', () => {
    const { view } = fixture(), before = dto(view);
    const pending = view.prepareAtomic(draft => draft.createEntity('IFCWALL', []));
    const revision = view.getMutationRevision();
    expect(() => restoreOverlay(view, compatibility, { sourceContentHash: 'sha256:' + 'a'.repeat(64), replace: true })).toThrow(OverlaySourceMismatchError);
    expect(dto(view).state).toEqual(before.state);
    expect(view.getMutationRevision()).toBe(revision);
    expect(() => pending.validate()).not.toThrow();
  });

  it('requires explicit replacement, retains the high watermark, and invalidates old drafts', () => {
    const { view } = fixture(); view.setExpressIdWatermark(500);
    const pending = view.prepareAtomic(draft => draft.createEntity('IFCWALL', []));
    expect(() => restoreOverlay(view, compatibility, options)).toThrow(/replace/);
    restoreOverlay(view, compatibility, { ...options, replace: true });
    expect(view.peekNextExpressId()).toBe(501);
    expect(() => pending.validate()).toThrow(/changed/);
    expect(Array.from(view.getNewEntitiesOfType('IFCWALL'), row => row.expressId)).toEqual([42]);
  });

  it.each(['version', 'oversize', 'malformed', 'duplicate'])('refuses %s before any publication', kind => {
    const { view } = fixture(), before = dto(view), revision = view.getMutationRevision();
    const bad = JSON.parse(compatibility) as OverlaySnapshotV1;
    let json = compatibility, maxBytes = 64 * 1024 * 1024;
    if (kind === 'version') { json = compatibility.replace('"version": 1', '"version": 2'); }
    if (kind === 'oversize') maxBytes = 2;
    if (kind === 'malformed') { bad.state.properties[0][0] = -1; json = JSON.stringify(bad); }
    if (kind === 'duplicate') { bad.state.createdEntities.push(bad.state.createdEntities[0]); json = JSON.stringify(bad); }
    expect(() => restoreOverlay(view, json, { ...options, maxBytes, replace: true })).toThrow();
    expect(dto(view).state).toEqual(before.state);
    expect(view.getMutationRevision()).toBe(revision);
  });

  it('drops the entire invalid host history but keeps the valid edits', () => {
    const { view } = fixture();
    const history = { undo: ['missing'], redo: [], groups: [], parked: [] };
    const copy = new MutablePropertyView(null, 'm');
    const result = restoreOverlay(copy, snapshotOverlay(view, { ...options, history }), options);
    expect(result.history).toBeUndefined();
    expect(result.historyDroppedReason).toMatch(/missing/);
    expect(copy.getNewEntities().length).toBe(1);
  });

  it('returns valid host history detached from the live journal and source options', () => {
    const { view } = fixture(), ids = view.getMutations().map(row => row.id);
    const history = { undo: ids, redo: [], groups: ids.map(id => [id, 'batch'] as [string, string]), parked: [] };
    const copy = new MutablePropertyView(null, 'm');
    const result = restoreOverlay(copy, snapshotOverlay(view, { ...options, history }), options);
    expect(result.history).toEqual(history);
    history.undo.length = 0;
    expect(result.history?.undo).toHaveLength(1);
  });

  it('supports asynchronous work on an escaped detached draft without a new fork API', async () => {
    const { view, id } = fixture();
    const fork = view.prepareAtomic(draft => draft).result;
    await Promise.resolve();
    fork.setPositionalAttribute(id, 1, 0.25);
    const copy = new MutablePropertyView(null, 'm');
    restoreOverlay(copy, snapshotOverlay(fork, options), options);
    expect(copy.getPositionalMutationsForEntity(id)?.get(1)).toBe(0.25);
    expect(view.getPositionalMutationsForEntity(id)).toBeNull();
  });
});

it('#8453 refuses a sampled 64-bit cache fingerprint as source identity', () => {
  const view = new MutablePropertyView(null, 'm');
  expect(() => snapshotOverlay(view, { sourceContentHash: '0123456789abcdef' })).toThrow(/full source/);
});
