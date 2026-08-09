/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2323 follow-up: the property/quantity cards must render what the parse path
 * stored, VERBATIM.
 *
 * Every producer of a pset name, property name, property value or quantity name
 * decodes exactly once at the parse boundary (`EntityExtractor` /
 * `columnar-parser-attributes.ts` on the TypeScript path,
 * `AttributeValue::from_token` on the Rust/WASM and server paths). Correct
 * decoding is not idempotent — `decodeIfcString` collapses `\\` to `\` — so the
 * cards' second `decodeIfcString` turned the authored UNC path `\\server\share`
 * into `\server\share` on screen while the stored, exported and round-tripped
 * value stayed correct.
 *
 * An idempotent decoder is not the alternative: idempotence would require
 * treating an already-decoded `\` and an authored, still-doubled `\\` alike,
 * which is precisely the ambiguity #2323 removed.
 *
 * The assertions go through a real `createRoot` render rather than the helpers,
 * because the defect was in JSX that looked harmless — only what the DOM ends
 * up holding proves it.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectUnits } from '@ifc-lite/parser';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { PropertySetCard } from './PropertySetCard.js';
import { QuantitySetCard } from './QuantitySetCard.js';

/** The authored value: a Windows UNC path, `\\server\share`. */
const UNC = '\\\\server\\share';

const UNITS = ProjectUnits.empty();

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: React.ReactElement): string {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    // The panel wraps the whole properties tree in a provider; the cards use
    // Radix tooltips for the measure-type hints and throw without it.
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
          name: `Pset ${UNC}`,
          properties: [{ name: `P ${UNC}`, value: `V ${UNC}` }],
        }}
        projectUnits={UNITS}
      />,
    );

    // Each site carries its own prefix, so no assertion can be satisfied by
    // one of the other two. A second decode rendered `Pset \server\share` /
    // `P \server\share` / `V \server\share` — one separator short in each.
    assert.ok(text.includes(`Pset ${UNC}`), `pset name verbatim in: ${text}`);
    assert.ok(text.includes(`P ${UNC}`), `property name verbatim in: ${text}`);
    assert.ok(text.includes(`V ${UNC}`), `property value verbatim in: ${text}`);
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
          name: `Qto ${UNC}`,
          quantities: [{ name: `Q ${UNC}`, value: 1.5, type: 0 }],
        }}
        projectUnits={UNITS}
      />,
    );
    assert.ok(text.includes(`Qto ${UNC}`), `qset name verbatim in: ${text}`);
    assert.ok(text.includes(`Q ${UNC}`), `quantity name verbatim in: ${text}`);
  });
});
