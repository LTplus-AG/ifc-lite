/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { scoreReply } from './score.mjs';

function literalFacts(text) {
  const agent = {
    parse: () => [{ type: 'a2ui', a2ui: [{ createSurface: { components: [{ id: 't', component: 'Text', text }] } }] }],
  };
  return scoreReply(agent, '<a2ui></a2ui>', { expectSurface: true, expect: [] }).literalFacts;
}

describe('scoreReply literal facts (#11344)', () => {
  it('flags a number next to a unit or entity word', () => {
    expect(literalFacts('120 m²')).toEqual(['120 m²']);
    expect(literalFacts('Area: 120 m² total')).toEqual(['Area: 120 m² total']);
    expect(literalFacts('12 walls')).toEqual(['12 walls']);
  });

  it('ignores a unit word that runs on into a longer word', () => {
    expect(literalFacts('3 wallsx')).toEqual([]);
    expect(literalFacts('Walls by storey')).toEqual([]);
  });
});
