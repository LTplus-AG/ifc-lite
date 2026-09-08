/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The symbolic overlay is the one thing a mesh filter cannot reach, so this
 * gate is the only place `hideTypes: ['IfcAnnotation']` can be honoured
 * (#2934). Each test names the mutation it kills.
 *
 * The class names are taken FROM `OVERLAY_CHANNEL_OWNER_TYPES` rather than
 * retyped here, on purpose: the first attempt at this fix asked the host
 * whether `'IfcGrid'` was hidden — a class the overlay never draws, since the
 * grid channel carries `IfcGridAxis` — and its test asserted the same wrong
 * spelling, so the pair agreed with each other and with nothing else. A test
 * that re-spells the table cannot catch the table being read wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { symbolicOverlayGate } from './symbolic-overlay-gate.js';
import { toHostHiddenIfcTypes } from './host-hidden-ifc-types.js';
import {
  OVERLAY_CHANNEL_OWNER_TYPES,
  OVERLAY_OWNER_TYPE_NAMES,
  isOverlayOwnerType,
  type OverlayChannel,
} from './overlay-parse/overlay-channels.js';

const CHANNELS = Object.keys(OVERLAY_CHANNEL_OWNER_TYPES) as OverlayChannel[];
const ALL_ON = Object.fromEntries(CHANNELS.map((c) => [c, true])) as Record<OverlayChannel, boolean>;

describe('symbolicOverlayGate', () => {
  it('switches a channel off when the host hid the class that channel draws', () => {
    // KILLS: `gate[channel] = toggles[channel]` — the store toggle alone,
    // which is what the overlay hooks did before this module existed.
    // `hideTypes: ['IfcAnnotation']` was then a silent no-op: the overlay is
    // not in the mesh list the embed filters, so nothing else could remove it.
    // ALSO KILLS: asking the host about a class the overlay does not draw
    // (`'IfcGrid'` for the grid channel, `'Annotation'` for the annotation
    // one), because the names come from the table the parse itself uses.
    for (const channel of CHANNELS) {
      for (const ownerType of OVERLAY_CHANNEL_OWNER_TYPES[channel]) {
        const gate = symbolicOverlayGate(ALL_ON, toHostHiddenIfcTypes([ownerType]));
        assert.equal(gate[channel], false, `${ownerType} should switch ${channel} off`);
        for (const other of CHANNELS) {
          // KILLS: collapsing the two channels onto one decision. #862 split
          // them precisely so grid axes can go without dimensions/leaders.
          if (other !== channel) assert.equal(gate[other], true, `${ownerType} hid ${other} too`);
        }
      }
    }
  });

  it('draws every channel when the host hid nothing, or hid something else', () => {
    // KILLS: inverting the empty-list default — a host hiding an unrelated
    // class, or nothing at all, must change nothing.
    assert.deepEqual(symbolicOverlayGate(ALL_ON, null), ALL_ON);
    assert.deepEqual(symbolicOverlayGate(ALL_ON, undefined), ALL_ON);
    assert.deepEqual(symbolicOverlayGate(ALL_ON, toHostHiddenIfcTypes([])), ALL_ON);
    assert.deepEqual(symbolicOverlayGate(ALL_ON, toHostHiddenIfcTypes(['IfcWall'])), ALL_ON);
  });

  it('leaves an off toggle off whatever the host hid', () => {
    // KILLS: `||` in place of `&&`, which would let a host that hides nothing
    // turn the user's own store toggles back on.
    const allOff = Object.fromEntries(CHANNELS.map((c) => [c, false])) as Record<OverlayChannel, boolean>;
    assert.deepEqual(symbolicOverlayGate(allOff, null), allOff);
    assert.deepEqual(symbolicOverlayGate(allOff, toHostHiddenIfcTypes(['IfcWall'])), allOff);
  });

  it('matches the host spelling case-insensitively, and trims', () => {
    // KILLS: comparing raw strings. The SDK's own documented example passes
    // SCREAMING_CASE (`IFCANNOTATION`, the spelling STEP files use) while the
    // overlay's owner types are PascalCase, so a raw comparison would hide
    // nothing and report nothing — the #2934 shape again.
    for (const channel of CHANNELS) {
      for (const ownerType of OVERLAY_CHANNEL_OWNER_TYPES[channel]) {
        for (const spelling of [ownerType.toUpperCase(), ownerType.toLowerCase(), ` ${ownerType} `]) {
          const gate = symbolicOverlayGate(ALL_ON, toHostHiddenIfcTypes([spelling]));
          assert.equal(gate[channel], false, `${spelling} should switch ${channel} off`);
        }
      }
    }
  });

  it('gates exactly the owner types the overlay parse keeps, and no others', () => {
    // KILLS: a class added to one definition and not the other. The parse's
    // `'overlay'` filter and this gate must name the same set, or a class the
    // overlay draws becomes unhideable (silence, #2934) or a class it does
    // not draw becomes a channel switch (over-hiding). Also KILLS retyping
    // `'IfcGrid'` into the table: `isOverlayOwnerType` would reject it.
    const gated = CHANNELS.flatMap((c) => [...OVERLAY_CHANNEL_OWNER_TYPES[c]]);
    for (const ownerType of gated) assert.ok(isOverlayOwnerType(ownerType), ownerType);
    for (const notDrawn of ['IfcGrid', 'IfcWall', 'IfcSpace', 'Annotation']) {
      assert.ok(!isOverlayOwnerType(notDrawn), notDrawn);
      assert.deepEqual(symbolicOverlayGate(ALL_ON, toHostHiddenIfcTypes([notDrawn])), ALL_ON);
    }
  });

  it('returns a plain boolean per channel, never undefined', () => {
    // KILLS: dropping a channel from the loop and yielding `undefined`, which
    // React would pass on as a falsy-but-not-false `enabled`.
    const gate = symbolicOverlayGate(ALL_ON, toHostHiddenIfcTypes(['IfcAnnotation']));
    assert.deepEqual(Object.keys(gate).sort(), [...CHANNELS].sort());
    for (const channel of CHANNELS) assert.equal(typeof gate[channel], 'boolean');
  });

  it('the flat owner-type list covers every class in the channel table', () => {
    // KILLS: adding a channel or an owner class to OVERLAY_CHANNEL_OWNER_TYPES
    // and leaving OVERLAY_OWNER_TYPE_NAMES behind. That list is what the
    // parse-cache short-circuit asks the entity store about, so a class missing
    // from it means a model containing only that class skips the parse entirely
    // and the overlay never draws. The failure is silent: no error, no lines.
    const fromTable = Object.values(OVERLAY_CHANNEL_OWNER_TYPES).flat().sort();
    assert.deepEqual([...OVERLAY_OWNER_TYPE_NAMES].sort(), fromTable);
  });
});
