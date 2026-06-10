/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { IFCLITE_ATTR, computeLayerId, getProvenance } from '@ifc-lite/ifcx';
import { createCollabDoc } from '../src/doc/schema.js';
import {
  createEntity,
  deleteAttribute,
  deleteEntity,
  removeChild,
  setAttribute,
  setChild,
  setPropertyValue,
  setQuantityValue,
} from '../src/doc/entity.js';
import { extractMinimalLayer } from '../src/snapshot/minimal-layer.js';
import { publishLayer } from '../src/snapshot/publish-layer.js';

describe('extractMinimalLayer deletion overlays', () => {
  it('emits a tombstone opinion for entities deleted since baseline', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
    createEntity(doc, 'door', { ifcClass: 'IfcDoor' });
    const baseline = Y.encodeStateAsUpdate(doc);

    deleteEntity(doc, 'door');

    const layer = extractMinimalLayer(doc, baseline);
    const tombstone = layer.data.find((n) => n.path === 'door');
    expect(tombstone?.attributes).toEqual({ [IFCLITE_ATTR.DELETED]: true });
  });

  it('emits null for removed attributes and children', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
    setAttribute(doc, 'wall', 'FireRating', 'REI60');
    setChild(doc, 'wall', 'Opening', 'opening-1');
    const baseline = Y.encodeStateAsUpdate(doc);

    deleteAttribute(doc, 'wall', 'FireRating');
    removeChild(doc, 'wall', 'Opening');

    const layer = extractMinimalLayer(doc, baseline);
    const wall = layer.data.find((n) => n.path === 'wall');
    expect(wall?.attributes?.FireRating).toBeNull();
    expect(wall?.children?.Opening).toBeNull();
  });

  it('includeDeletions:false restores the legacy additive-only shape', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'door', { ifcClass: 'IfcDoor' });
    const baseline = Y.encodeStateAsUpdate(doc);
    deleteEntity(doc, 'door');

    const layer = extractMinimalLayer(doc, baseline, { includeDeletions: false });
    expect(layer.data).toEqual([]);
  });
});

describe('publishLayer', () => {
  function draftWithEdits() {
    const doc = createCollabDoc();
    createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
    const baseline = Y.encodeStateAsUpdate(doc);
    setAttribute(doc, 'wall', 'bsi::ifc::v5a::Pset_FireSafety::FireRating', 'REI90');
    return { doc, baseline };
  }

  it('freezes a draft into an immutable, content-addressed layer with a valid manifest', () => {
    const { doc, baseline } = draftWithEdits();
    const published = publishLayer(doc, {
      intent: 'Reclassify fire-safety rating',
      author: { kind: 'agent', principal: 'agent@ltplus.ch', tool: '@ifc-lite/mcp' },
      baseline,
      base: { kind: 'layer', id: 'blake3:basebasebase' },
      scope_claim: ['model.mutate:Pset_FireSafety*@IfcWall'],
    });

    expect(published.layerId.startsWith('blake3:')).toBe(true);
    expect(published.file.header.id).toBe(published.layerId);
    expect(computeLayerId(published.file)).toBe(published.layerId);
    expect(published.opCount).toBe(1);

    const manifest = getProvenance(published.file);
    expect(manifest?.intent).toBe('Reclassify fire-safety rating');
    expect(manifest?.author.kind).toBe('agent');
    expect(manifest?.base).toEqual({ kind: 'layer', id: 'blake3:basebasebase' });
    expect(manifest?.parents).toEqual(['blake3:basebasebase']);
    expect(manifest?.scope_claim).toEqual(['model.mutate:Pset_FireSafety*@IfcWall']);
  });

  it('structured-branch edits publish into the layer and the content address (#1031)', () => {
    const doc = createCollabDoc();
    createEntity(doc, 'wall', { ifcClass: 'IfcWall' });
    const baseline = Y.encodeStateAsUpdate(doc);
    setPropertyValue(doc, 'wall', 'Pset_FireSafety', 'FireRating', {
      type: 'IfcLabel',
      value: 'F30',
    });
    setQuantityValue(doc, 'wall', 'Qto_WallBaseQuantities', 'NetVolume', 12.5);

    const fixed = {
      intent: 'structured edits',
      author: { kind: 'human' as const, principal: 'louis@lt.plus' },
      baseline,
      created: '2026-06-10T00:00:00Z',
    };
    const published = publishLayer(doc, fixed);
    const wallNode = published.file.data.find((n) => n.path === 'wall')!;
    expect(wallNode.attributes?.['bsi::ifc::v5a::Pset_FireSafety::FireRating']).toEqual({
      type: 'IfcLabel',
      value: 'F30',
    });
    expect(wallNode.attributes?.['bsi::ifc::v5a::Qto_WallBaseQuantities::NetVolume']).toBe(12.5);

    // Canonicalization covers the typed-record representation: the id is
    // stable for identical structured content and moves when it changes.
    expect(published.layerId).toBe(publishLayer(doc, fixed).layerId);
    expect(computeLayerId(published.file)).toBe(published.layerId);
    setPropertyValue(doc, 'wall', 'Pset_FireSafety', 'FireRating', {
      type: 'IfcLabel',
      value: 'F60',
    });
    expect(publishLayer(doc, fixed).layerId).not.toBe(published.layerId);
  });

  it('is deterministic for identical drafts and changes id when content changes', () => {
    const fixed = {
      intent: 'test',
      author: { kind: 'human' as const, principal: 'louis@lt.plus' },
      created: '2026-06-09T00:00:00Z',
    };
    const a = draftWithEdits();
    const b = draftWithEdits();
    const idA = publishLayer(a.doc, { ...fixed, baseline: a.baseline }).layerId;
    const idB = publishLayer(b.doc, { ...fixed, baseline: b.baseline }).layerId;
    expect(idA).toBe(idB);

    setAttribute(b.doc, 'wall', 'Name', 'changed');
    const idC = publishLayer(b.doc, { ...fixed, baseline: b.baseline }).layerId;
    expect(idC).not.toBe(idB);
  });

  it('does not mutate the draft and rejects empty intent', () => {
    const { doc, baseline } = draftWithEdits();
    const before = Y.encodeStateAsUpdate(doc).byteLength;
    publishLayer(doc, {
      intent: 'ok',
      author: { kind: 'human', principal: 'louis@lt.plus' },
      baseline,
    });
    expect(Y.encodeStateAsUpdate(doc).byteLength).toBe(before);

    expect(() =>
      publishLayer(doc, {
        intent: '   ',
        author: { kind: 'human', principal: 'louis@lt.plus' },
        baseline,
      })
    ).toThrow(/intent/);
  });
});
