/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins the bSDD property tooltip's secondary lines (description, data type)
 * to the app's accessible semantic tokens — by mounting the PRODUCTION
 * `BsddCard`, not a copied fragment.
 *
 * Same root cause as `QuantitySetCard.contrast.test.tsx` and
 * `PropertySetCard.contrast.test.tsx`: `TooltipContent` switched to the
 * neutral `bg-popover`/`text-popover-foreground` surface in #4767, but
 * `BsddCard`'s secondary tooltip lines kept `text-primary-foreground/80` and
 * `/70` — white-on-white in light mode, identical-on-identical in dark mode
 * (`apps/viewer/src/index.css`).
 *
 * An earlier version of this test rendered a JSX fragment copied verbatim
 * out of `BsddCard.tsx` instead of the component itself, so it could not
 * catch a mistake in how `BsddCard` actually wires `prop` into that markup
 * (review on #4788). This version mounts `BsddCard` for real:
 *  - the network call (`fetchClassInfo`, `services/bsdd.ts`) is stubbed by
 *    swapping `globalThis.fetch` for the run of one test, restored in
 *    `afterEach` — a plain property swap, not `mock.module` (this repo
 *    rejects `mock.module`; see `loadTelemetry.test.ts`'s `posthog.capture`
 *    swap for the same pattern);
 *  - the `useViewerStore` mutation setters `BsddCard` reads
 *    (`setProperty`, `createPropertySet`, etc.) are the REAL store — it
 *    needs no wasm/geometry engine to construct, and this test never calls
 *    any of them (it only opens a tooltip), so they run unexercised, exactly
 *    like production before a user clicks "add".
 *
 * Reverting the fix (classNames back to `text-primary-foreground/80` and
 * `/70` on `BsddCard.tsx`'s description/dataType lines) turns this red.
 */

import '@/test/setup-dom.js';
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { BsddCard } from './BsddCard.js';
import { registerLocale, setLocale } from '@/i18n';

// ---------------------------------------------------------------------------
// Network stub for services/bsdd.ts's fetchClassInfo, which calls the
// module-level `fetch`. One property (`classProperties`) carries the fixture
// this suite pins: a Pset_* property with both a description and a dataType,
// the exact shape whose tooltip lines #4783 made invisible.
// ---------------------------------------------------------------------------

const BSDD_CLASS_RESPONSE = {
  uri: 'https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcWall',
  code: 'IfcWall',
  name: 'IfcWall',
  definition: 'A wall.',
  classProperties: [
    {
      name: 'FireRating',
      propertyCode: 'FireRating',
      propertyUri: 'https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/prop/FireRating',
      description: 'Fire resistance rating',
      dataType: 'IfcLabel',
      propertySet: 'Pset_WallCommon',
      units: null,
    },
  ],
};

let realFetch: typeof fetch;

before(() => {
  realFetch = globalThis.fetch;
});

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
  globalThis.fetch = realFetch;
  setLocale('en');
});

describe('BsddCard property tooltip contrast (production component)', () => {
  it('renders description and data-type lines on the popover surface with semantic muted text', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(BSDD_CLASS_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    render(
      <BsddCard
        entityType="IfcWall"
        modelId="m1"
        entityId={1}
        existingPsets={[]}
        existingProps={new Set<string>()}
      />,
    );

    // Flush the useEffect's fetchClassInfo().then(...) microtasks.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Expand the Pset_WallCommon group so its property row (and tooltip
    // trigger) actually mounts.
    const psetHeader = Array.from(document.querySelectorAll('button')).find((el) =>
      el.textContent?.includes('Pset_WallCommon'),
    );
    assert.ok(psetHeader, 'Pset_WallCommon group header rendered');
    act(() => {
      (psetHeader as HTMLElement).click();
    });

    const trigger = Array.from(document.querySelectorAll('span')).find((el) => el.textContent === 'FireRating');
    assert.ok(trigger, 'FireRating property renders as a tooltip trigger');
    act(() => {
      (trigger as HTMLElement).focus();
    });

    const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    assert.ok(tooltip, 'tooltip content opened');
    assert.ok(tooltip!.classList.contains('bg-popover'), 'tooltip surface is the neutral popover, not bg-primary');
    assert.ok(!tooltip!.classList.contains('bg-primary'));

    const lines = Array.from(tooltip!.querySelectorAll('p'));
    assert.equal(lines.length, 3, 'name, description, dataType lines');
    assert.equal(lines[1].textContent, 'Fire resistance rating');
    assert.equal(lines[1].className, 'mt-0.5 text-muted-foreground', 'description line derives from the popover surface');
    assert.equal(lines[2].textContent, 'IfcLabel');
    assert.equal(lines[2].className, 'mt-0.5 text-muted-foreground', 'data-type line derives from the popover surface');
  });

  it('formats its property and action counts with the active locale', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(BSDD_CLASS_RESPONSE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    registerLocale('ar-EG', {
      'properties.bsdd.addAllTooltip': { one: '[add {countDisplay}]', other: '[add {countDisplay}]' },
      'properties.bsdd.editedCount': '[edited {countDisplay}]',
    });
    setLocale('ar-EG');
    render(<BsddCard entityType="IfcWall" modelId="m1" entityId={1} existingPsets={[]} existingProps={new Set()} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const header = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Pset_WallCommon'));
    assert.ok(header);
    assert.match(header.textContent ?? '', /١/);
    const addAll = header.querySelector<HTMLButtonElement>('button');
    assert.ok(addAll);
    act(() => addAll.focus());
    assert.match(document.body.textContent ?? '', /\[add ١\]/);
    act(() => addAll.click());
    assert.match(document.body.textContent ?? '', /\[edited ١\]/);
  });
});
