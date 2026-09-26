/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { en } from './en';
import type { TranslationValue } from './types';

function messages(value: TranslationValue): string[] {
  return typeof value === 'string'
    ? [value]
    : Object.values(value).filter((form): form is string => typeof form === 'string');
}

describe('plain-language English labels (#5875)', () => {
  it('keeps developer jargon out of labels while allowing explanations in tooltips', () => {
    const jargon = /\b(?:basket|flavou?rs?|edl|bvh|epsilon|straddlers?)\b/i;
    const offenders = Object.entries(en).flatMap(([key, value]) => {
      if (
        /tooltip|glossary/i.test(key)
        || key === 'pointCloudPanel.edlCheckboxTitle'
        || key === 'pointCloudPanel.edlStrengthTitle'
      ) return [];
      return messages(value)
        .filter(message => jargon.test(message.replace(/\{[^}]+\}/g, '')))
        .map(message => `${key}: ${message}`);
    });
    assert.deepEqual(offenders, []);
  });

  it('calls collaboration sessions sessions without changing IFC room terminology', () => {
    const collaborationKey = /^(?:zonesPanel\.roomPanel\.|shareDialog\.|shareScopeField\.|ribbon\.file\.room|mainToolbar\.(?:room|collaborationRoom)|commandPalette\.panel\.collab|appearance\..*leaveRoom)/;
    const offenders = Object.entries(en).flatMap(([key, value]) =>
      collaborationKey.test(key)
        ? messages(value)
            .filter(message => /\broom\b/i.test(message))
            .map(message => `${key}: ${message}`)
        : [],
    );
    assert.deepEqual(offenders, []);
    assert.equal(en['spaceSketch.panel.roomCount'].one, '{count} room');
    assert.equal(en['classVisibility.spaces.description'], 'Room volumes (IfcSpace)');
  });

  it('explains the EDL acronym in a tooltip and preserves the IFC entity name in export help', () => {
    assert.equal(en['pointCloudPanel.edlSectionLabel'], 'Edge shading');
    assert.match(en['pointCloudPanel.edlCheckboxTitle'], /\bEDL\b/);
    assert.equal(en['zonesPanel.writeBack.emitZonesLabel'], 'Write zones to IFC');
    assert.match(en['zonesPanel.writeBack.emitZonesTitle'], /\bIfcSpatialZone\b/);
  });
});
