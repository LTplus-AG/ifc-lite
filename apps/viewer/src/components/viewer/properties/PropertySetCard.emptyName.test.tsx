/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcRoot.Name` is optional, so an `IFCPROPERTYSET`/`IFCELEMENTQUANTITY`
 * with an empty-string `Name` (`''`, not the null marker `$`) is a real STEP
 * shape. `on-demand-extractors.ts`'s `extractPsetsFromIds` only fabricates a
 * placeholder when the `Name` attribute is not a string at all (the `$` /
 * omitted case); a declared empty string passes through untouched:
 *
 *   const psetName = typeof psetAttrs[2] === 'string' ? psetAttrs[2] : `PropertySet #${psetId}`;
 *
 * so `psetName` is `''` today on unmodified main for that file, before PR
 * #3534 (which stops fabricating the `$`-case placeholder too). Either way
 * the properties panel must not render a blank group header.
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
import { QuantitySetCard } from './QuantitySetCard.js';

const UNITS = ProjectUnits.empty();

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: ReactElement): string {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<TooltipProvider>{node}</TooltipProvider>);
  });
  return host.textContent ?? '';
}

/** The card's collapsible-trigger button holds ONLY the header row (name +
 *  count badge) — the property/quantity rows live in a sibling
 *  `CollapsibleContent`, not inside the button — so this isolates the header
 *  text from the row content, unlike reading the whole card's textContent. */
function headerText(): string {
  return host?.querySelector('button')?.textContent ?? '';
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('property/quantity cards fall back on an empty set name', () => {
  it('renders a non-blank header for a pset whose Name is the empty string', () => {
    render(
      <PropertySetCard
        pset={{ name: '', properties: [] }}
        projectUnits={UNITS}
      />,
    );
    // With zero properties, the header button's only other content is the
    // "0" count badge — so a blank name collapses the header to just "0".
    const header = headerText();
    assert.ok(header.replace(/0/g, '').trim().length > 0, `expected a non-blank header, got: ${JSON.stringify(header)}`);
  });

  it('renders a non-blank header for a qset whose Name is the empty string', () => {
    render(
      <QuantitySetCard
        qset={{ name: '', quantities: [] }}
        projectUnits={UNITS}
      />,
    );
    const header = headerText();
    assert.ok(header.replace(/0/g, '').trim().length > 0, `expected a non-blank header, got: ${JSON.stringify(header)}`);
  });

  // CONTROL — a named set must keep rendering its real name unchanged, not
  // the fallback placeholder.
  it('still renders the real name for a named pset/qset', () => {
    render(
      <PropertySetCard
        pset={{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: '.T.' }] }}
        projectUnits={UNITS}
      />,
    );
    assert.ok(headerText().includes('Pset_WallCommon'), `named pset should render its real name in: ${headerText()}`);

    render(
      <QuantitySetCard
        qset={{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 1.5, type: 0 }] }}
        projectUnits={UNITS}
      />,
    );
    assert.ok(headerText().includes('Qto_WallBaseQuantities'), `named qset should render its real name in: ${headerText()}`);
  });
});
