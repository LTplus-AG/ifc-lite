/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `open.federation`: several processed models opened together. Additive to
 * version 1, so it is checked as strictly as `open.processedModel` and a
 * host may send both (the single model for viewers that predate federations).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseViewerRuntimeConfig, ViewerConfigError, MAX_FEDERATION_SLOTS } from './runtime-config';

const SHA = 'a91f9cf15d3f70fdd707d8567b5ade051e706af3a807367fa23fc9813f31d96a';
const OTHER = 'b'.repeat(64);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** A quarter turn about Z, then 10 m east, 2 m up (column-major). */
const TURNED = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 0, 2, 1];

const slot = (over: Record<string, unknown> = {}) => ({
  slot: 'arch', label: 'Architecture', sha256: SHA, bytes: 1_000, name: 'arch.ifc', visible: true, ...over,
});
const config = (federation: unknown, extra: Record<string, unknown> = {}) =>
  ({ version: 1, open: { federation, ...extra } });
const refused = (value: unknown): ViewerConfigError => {
  try { parseViewerRuntimeConfig(value, 'https://host.example/'); }
  catch (error) { assert.ok(error instanceof ViewerConfigError); return error; }
  assert.fail('expected the configuration to be refused');
};

describe('open.federation', () => {
  it('keeps every slot, lowercases hashes, copies transforms and drops members it does not know', () => {
    const parsed = parseViewerRuntimeConfig(config({
      id: 'workspace-1', revision: 4,
      slots: [
        slot({ sha256: SHA.toUpperCase(), colour: 'red' }),
        slot({ slot: 'struct', label: 'Structure', sha256: OTHER, bytes: 0, name: 'struct.ifc', visible: false, transform: TURNED }),
      ],
    }), 'https://host.example/');
    assert.deepEqual(parsed.open, { federation: { id: 'workspace-1', slots: [
      { slot: 'arch', label: 'Architecture', sha256: SHA, bytes: 1_000, name: 'arch.ifc', visible: true },
      { slot: 'struct', label: 'Structure', sha256: OTHER, bytes: 0, name: 'struct.ifc', visible: false, transform: TURNED },
    ] } });
  });

  it('uses the federation when a host also sends the single model older viewers read', () => {
    const parsed = parseViewerRuntimeConfig(config({ id: 'w', slots: [slot()] }, {
      processedModel: { sha256: OTHER, bytes: 1, name: 'fallback.ifc' },
    }), 'https://host.example/');
    assert.equal(parsed.open?.processedModel, undefined, 'the fallback model is not opened beside the federation');
    assert.equal(parsed.open?.federation?.slots[0].slot, 'arch');
  });

  it('still checks that fallback model: a malformed one is a host bug either way', () => {
    refused(config({ id: 'w', slots: [slot()] }, { processedModel: { sha256: 'nope', bytes: 1, name: 'x.ifc' } }));
  });

  it(`accepts ${MAX_FEDERATION_SLOTS} slots and refuses one more`, () => {
    const slots = (n: number) => Array.from({ length: n }, (_, i) => slot({ slot: `s${i}` }));
    assert.equal(parseViewerRuntimeConfig(config({ id: 'w', slots: slots(MAX_FEDERATION_SLOTS) })).open?.federation?.slots.length, MAX_FEDERATION_SLOTS);
    assert.match(refused(config({ id: 'w', slots: slots(MAX_FEDERATION_SLOTS + 1) })).message, /open\.federation\.slots/);
  });

  it('accepts an identity transform and a turned, moved one', () => {
    for (const transform of [IDENTITY, TURNED]) {
      assert.deepEqual(parseViewerRuntimeConfig(config({ id: 'w', slots: [slot({ transform })] })).open?.federation?.slots[0].transform, transform);
    }
  });

  const BAD: ReadonlyArray<readonly [string, unknown]> = [
    ['no slots', { id: 'w', slots: [] }],
    ['slots that are not a list', { id: 'w', slots: {} }],
    ['no id', { slots: [slot()] }],
    ['an empty id', { id: ' ', slots: [slot()] }],
    ['an id with a control character', { id: 'w\n', slots: [slot()] }],
    ['an id over 128 characters', { id: 'w'.repeat(129), slots: [slot()] }],
    ['two slots with one id', { id: 'w', slots: [slot(), slot({ sha256: OTHER })] }],
    ['a slot without an id', { id: 'w', slots: [slot({ slot: undefined })] }],
    ['a slot without a label', { id: 'w', slots: [slot({ label: '' })] }],
    ['a label over 120 characters', { id: 'w', slots: [slot({ label: 'x'.repeat(121) })] }],
    ['a slot whose hash is not a SHA-256', { id: 'w', slots: [slot({ sha256: '../../etc' })] }],
    ['a slot with a fractional size', { id: 'w', slots: [slot({ bytes: 1.5 })] }],
    ['a slot with a negative size', { id: 'w', slots: [slot({ bytes: -1 })] }],
    ['a slot without a name', { id: 'w', slots: [slot({ name: undefined })] }],
    ['a slot without visibility', { id: 'w', slots: [slot({ visible: undefined })] }],
    ['a slot with visibility as text', { id: 'w', slots: [slot({ visible: 'true' })] }],
    ['a transform of 15 numbers', { id: 'w', slots: [slot({ transform: IDENTITY.slice(1) })] }],
    ['a transform with a non-finite number', { id: 'w', slots: [slot({ transform: [...IDENTITY.slice(0, 15), Number.NaN] })] }],
    ['a transform with text', { id: 'w', slots: [slot({ transform: IDENTITY.map(String) })] }],
    ['a scaling transform', { id: 'w', slots: [slot({ transform: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1] })] }],
    ['a mirroring transform', { id: 'w', slots: [slot({ transform: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })] }],
    ['a tilting transform', { id: 'w', slots: [slot({ transform: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1] })] }],
    ['a projective transform', { id: 'w', slots: [slot({ transform: [1, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })] }],
    ['a translation past the renderable range', { id: 'w', slots: [slot({ transform: [...IDENTITY.slice(0, 12), 1e39, 0, 0, 1] })] }],
    ['a federation that is not an object', 'arch'],
  ];
  for (const [what, federation] of BAD) {
    it(`refuses the whole configuration for ${what}`, () => {
      assert.match(refused(config(federation)).message, /open\.federation/);
    });
  }

  it('refuses an open with neither a model nor a federation', () => {
    assert.match(refused({ version: 1, open: {} }).message, /open\.processedModel/);
  });
});
