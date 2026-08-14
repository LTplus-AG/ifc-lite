/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2323 follow-up: the property/quantity cards must render what the parse path
 * stored, VERBATIM.
 *
 * Every producer of a pset name, property name, property value or quantity
 * name decodes exactly once, at the parse boundary — `EntityExtractor` /
 * `columnar-parser-attributes.ts` on the TypeScript path,
 * `AttributeValue::from_token` on the Rust/WASM and server paths (#2394). A
 * correct decoder is not idempotent: `decodeIfcString` collapses `\\` to `\`,
 * so the cards' second decode turned the authored UNC path `\\server\share`
 * into `\server\share` on screen while the stored, exported and round-tripped
 * value stayed correct. `C:\temp` is a fixed point of the decoder, which is
 * why the defect hides on the common case.
 *
 * An idempotent decoder is not the alternative: idempotence would require
 * treating an already-decoded `\` and an authored, still-doubled `\\` alike,
 * which is precisely the ambiguity #2323 removed.
 *
 * The assertions go through a real `createRoot` render rather than calling the
 * helpers, because the defect lived in JSX that read as harmless — only what
 * the DOM ends up holding proves it.
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

/**
 * One authored UNC path per SITE, each naming a different host. Sharing one
 * fixture would let the pset-name assertion be satisfied by the property name
 * (or the value) and hide a site that still double-decodes.
 */
const PSET_NAME = '\\\\psethost\\share';
const PROP_NAME = '\\\\prophost\\share';
const PROP_VALUE = '\\\\valuehost\\share';
const QSET_NAME = '\\\\qsethost\\share';
const QTY_NAME = '\\\\qtyhost\\share';

const UNITS = ProjectUnits.empty();

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: ReactElement): string {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    // The panel wraps the whole properties tree in a provider; the cards use
    // Radix tooltips for the measure-type hints and throw without one.
    root!.render(<TooltipProvider>{node}</TooltipProvider>);
  });
  return host.textContent ?? '';
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('property/quantity cards render already-decoded text verbatim', () => {
  it('keeps the adjacent backslashes of a UNC path in the pset name, property name and value', () => {
    const text = render(
      <PropertySetCard
        pset={{
          name: PSET_NAME,
          properties: [{ name: PROP_NAME, value: PROP_VALUE }],
        }}
        projectUnits={UNITS}
      />,
    );

    // A second decode rendered `\psethost\share` / `\prophost\share` /
    // `\valuehost\share` — one separator short at each of the three sites.
    assert.ok(text.includes(PSET_NAME), `pset name verbatim in: ${text}`);
    assert.ok(text.includes(PROP_NAME), `property name verbatim in: ${text}`);
    assert.ok(text.includes(PROP_VALUE), `property value verbatim in: ${text}`);
  });

  it('does not resolve a directive-shaped literal at display time', () => {
    // The parse path already resolved every real directive; what reaches the
    // card is literal text and must stay literal text.
    const literal = 'caf\\X2\\00E9\\X0\\';
    const text = render(
      <PropertySetCard
        pset={{ name: 'Pset_Literal', properties: [{ name: 'Label', value: literal }] }}
        projectUnits={UNITS}
      />,
    );
    assert.ok(text.includes(literal), `directive-shaped literal verbatim in: ${text}`);
    assert.ok(!text.includes('café'), 'the card must not decode the directive');
  });

  it('keeps the qset and quantity names verbatim too', () => {
    const text = render(
      <QuantitySetCard
        qset={{
          name: QSET_NAME,
          quantities: [{ name: QTY_NAME, value: 1.5, type: 0 }],
        }}
        projectUnits={UNITS}
      />,
    );
    assert.ok(text.includes(QSET_NAME), `qset name verbatim in: ${text}`);
    assert.ok(text.includes(QTY_NAME), `quantity name verbatim in: ${text}`);
  });

  // BOUNDING CONTROL — passes before and after. Deleting the decode must not
  // also delete the rendering: a card that rendered nothing at all would
  // satisfy neither of the assertions above, but a card that dropped only the
  // *value* would still satisfy the name ones if they shared a fixture.
  it('still renders ordinary names and values', () => {
    const text = render(
      <PropertySetCard
        pset={{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: '.T.' }] }}
        projectUnits={UNITS}
      />,
    );
    assert.ok(text.includes('Pset_WallCommon'), `plain pset name in: ${text}`);
    assert.ok(text.includes('IsExternal'), `plain property name in: ${text}`);
    assert.ok(text.includes('True'), `boolean enum still resolved in: ${text}`);
  });
});
