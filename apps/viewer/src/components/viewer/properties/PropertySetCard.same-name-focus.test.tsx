/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An entity can carry two distinct IfcPropertySet occurrences that share the
 * same `Name` (see `packages/query/src/entity-node.ts`). The bSDD "jump to
 * added property" flow (issue #1107) arms a `focusedPropKey` of
 * `"${entityId}:${psetName}:${propName}"` and every `PropertySetCard` for that
 * entity independently highlights any row whose own key matches it.
 *
 * Tracing the add path (`BsddCard.handleAddProperty` -> the store's
 * `setProperty` -> `MutablePropertyView.getForEntity`,
 * `packages/mutations/src/mutable-property-view.ts`) found the actual defect
 * one layer below this component: before that fix, a brand-new property was
 * written into EVERY same-named base pset, so BOTH cards' rendered
 * `pset.properties` contained the key and BOTH highlighted — not because this
 * component picks the wrong one, but because the data genuinely duplicated.
 * `getForEntity` now gives a new property to only the first same-named
 * instance (`packages/mutations/test/mutable-property-view.duplicate-pset.test.ts`
 * pins that). This file pins the consequence on the rendered side: given
 * correct (non-duplicated) data, the existing per-card `keyFor`/`isFocused`
 * matching already lands the highlight on exactly the card that was actually
 * mutated — no viewer-side change was needed once the data stopped lying.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectUnits } from '@ifc-lite/parser';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { PropertySetCard } from './PropertySetCard.js';

const UNITS = ProjectUnits.empty();
const ENTITY_ID = 42;
const PSET_NAME = 'Pset_Common';
const FOCUSED_KEY = `${ENTITY_ID}:${PSET_NAME}:FireRating`;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<TooltipProvider>{node}</TooltipProvider>);
  });
  return host;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Amber highlight ring is the same class PropertySetCard applies to `isFocused` rows. */
function highlightedKeys(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-prop-key]'))
    .filter((el) => el.className.includes('ring-amber-400'))
    .map((el) => el.getAttribute('data-prop-key')!);
}

describe('PropertySetCard focus highlight — two same-named psets, one holds the new property', () => {
  it('highlights only the row on the pset that actually carries the new property', () => {
    const container = render(
      <>
        {/* First same-named pset: this is the one the fixed data layer actually
            wrote FireRating into. */}
        <PropertySetCard
          pset={{ name: PSET_NAME, properties: [{ name: 'Reference', value: 'refA' }, { name: 'FireRating', value: 'RF60' }] }}
          entityId={ENTITY_ID}
          focusedPropKey={FOCUSED_KEY}
          projectUnits={UNITS}
        />
        {/* Second same-named pset: unrelated properties, no FireRating row at all. */}
        <PropertySetCard
          pset={{ name: PSET_NAME, properties: [{ name: 'Status', value: 'NEW' }] }}
          entityId={ENTITY_ID}
          focusedPropKey={FOCUSED_KEY}
          projectUnits={UNITS}
        />
      </>,
    );

    const dataKeys = Array.from(container.querySelectorAll('[data-prop-key]')).map((el) =>
      el.getAttribute('data-prop-key'),
    );
    // Both cards compute the SAME string key for their own rows (entityId +
    // shared pset name), so only the presence of the actual FireRating row
    // distinguishes them -- confirming the two cards really do collide on key
    // shape, and only one of them has a matching row to highlight.
    assert.deepEqual(dataKeys, [`${ENTITY_ID}:${PSET_NAME}:Reference`, FOCUSED_KEY, `${ENTITY_ID}:${PSET_NAME}:Status`]);

    assert.deepEqual(highlightedKeys(container), [FOCUSED_KEY], 'exactly one row highlighted, on the pset that holds it');
  });

  // CONTROL — a uniquely-named pset still highlights correctly, so the
  // same-name scenario above is testing the collision, not breaking the
  // ordinary case.
  it('control: a unique-named pset highlights its own added property', () => {
    const container = render(
      <PropertySetCard
        pset={{ name: 'Pset_Unique', properties: [{ name: 'Reference', value: 'refA' }, { name: 'FireRating', value: 'RF60' }] }}
        entityId={ENTITY_ID}
        focusedPropKey={`${ENTITY_ID}:Pset_Unique:FireRating`}
        projectUnits={UNITS}
      />,
    );

    assert.deepEqual(highlightedKeys(container), [`${ENTITY_ID}:Pset_Unique:FireRating`]);
  });
});
