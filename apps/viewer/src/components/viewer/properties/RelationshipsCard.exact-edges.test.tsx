/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RelationshipsCard } from './RelationshipsCard.js';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('RelationshipsCard exact relationship edges (#4205)', () => {
  it('renders an otherwise unsupported exact IfcRel* class and selects its opposite endpoint', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    let selected: number | undefined;

    act(() => {
      root!.render(
        <RelationshipsCard
          relationships={{
            voids: [], fills: [], groups: [], connections: [],
            relations: [{
              relationshipId: 90,
              relationshipType: 'IfcRelDefinesByTemplate',
              direction: 'inverse',
              entity: { id: 42, name: 'Template A', type: 'IfcPropertySetTemplate' },
            }],
          }}
          onSelectEntity={(id) => { selected = id; }}
        />,
      );
    });

    const edge = Array.from(host.querySelectorAll('button'))
      .find((button) => button.title === '#90 IfcRelDefinesByTemplate');
    assert.ok(edge, 'the exact relationship record is visible in the card');
    assert.match(edge.textContent ?? '', /← #42/);
    assert.match(edge.textContent ?? '', /Template A/);
    assert.match(edge.textContent ?? '', /IfcRelDefinesByTemplate/);

    act(() => edge.click());
    assert.equal(selected, 42);
  });

  it('does not duplicate an exact edge already represented by a purpose-built section', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    act(() => {
      root!.render(
        <RelationshipsCard relationships={{
          voids: [{ id: 7, name: 'Opening', type: 'IfcOpeningElement' }],
          fills: [], groups: [], connections: [],
          relations: [{
            relationshipId: 91,
            relationshipType: 'IfcRelVoidsElement',
            direction: 'forward',
            entity: { id: 7, name: 'Opening', type: 'IfcOpeningElement' },
          }],
        }} />,
      );
    });

    assert.ok(host.textContent?.includes('Openings (1)'));
    assert.equal(host.querySelector('[title="#91 IfcRelVoidsElement"]'), null);
    assert.equal(host.textContent?.includes('IfcRelVoidsElement'), false);
  });
});
