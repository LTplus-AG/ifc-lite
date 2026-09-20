/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins the quantity-type tooltip in `QuantitySetCard` to the app's accessible
 * semantic tokens.
 *
 * `TooltipContent` (`components/ui/tooltip.tsx`) switched from the
 * `bg-primary`/`text-primary-foreground` pair to the neutral
 * `bg-popover`/`text-popover-foreground` surface in #4767 (fixing #4766's
 * unreadable hover card). This card's secondary tooltip line kept using
 * `text-primary-foreground/80`, a premise #4767 made false: in light mode
 * `--color-popover` and `--color-primary-foreground` are both white
 * (white-on-white), and in dark mode both resolve to the same Tokyo Night
 * background colour (identical-on-identical) — see `apps/viewer/src/index.css`.
 *
 * This test asserts the class NAME so a future edit can't silently
 * reintroduce a hardcoded `text-primary-foreground` tier: reverting the fix
 * turns this red.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProjectUnits } from '@ifc-lite/parser';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { QuantitySetCard } from './QuantitySetCard.js';
import { registerLocale, setLocale } from '@/i18n';

const UNITS = ProjectUnits.empty();

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
  setLocale('en');
});

describe('QuantitySetCard quantity-type tooltip contrast', () => {
  it('renders the type-name tooltip on the popover surface with semantic muted text', () => {
    render(
      <QuantitySetCard
        qset={{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 3.2, type: 0 }] }}
        projectUnits={UNITS}
      />,
    );

    const trigger = Array.from(document.querySelectorAll('span')).find((el) => el.textContent === 'Length');
    assert.ok(trigger, 'quantity name span with a mapped type renders as a tooltip trigger');
    // Radix opens the tooltip immediately (no hover delay) on keyboard focus.
    act(() => {
      (trigger as HTMLElement).focus();
    });

    const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    assert.ok(tooltip, 'tooltip content opened');
    assert.ok(tooltip!.classList.contains('bg-popover'), 'tooltip surface is the neutral popover, not bg-primary');
    assert.ok(!tooltip!.classList.contains('bg-primary'));

    const secondary = tooltip!.querySelector('span');
    assert.equal(secondary?.textContent, 'Length');
    assert.equal(secondary?.className, 'text-muted-foreground', 'secondary text derives from the popover surface, not primary-foreground');
  });

  it('localizes the unnamed heading, type tooltip, count, and numeric value (#4918)', () => {
    registerLocale('ar-EG-x-quantity-card', {
      'properties.quantitySet.unnamed': '[مجموعة بلا اسم]',
      'properties.quantitySet.type.length': '[طول]',
    });
    setLocale('ar-EG-x-quantity-card');
    render(
      <QuantitySetCard
        qset={{ name: '', quantities: [{ name: 'Length', value: 1234.5, type: 0 }] }}
        projectUnits={UNITS}
      />,
    );
    assert.match(document.body.textContent ?? '', /\[مجموعة بلا اسم\]/);
    assert.match(document.body.textContent ?? '', new RegExp(new Intl.NumberFormat('ar-EG-x-quantity-card', { maximumFractionDigits: 3 }).format(1234.5)));
    const trigger = Array.from(document.querySelectorAll('span')).find((el) => el.textContent === 'Length');
    assert.ok(trigger);
    act(() => { (trigger as HTMLElement).focus(); });
    assert.match(document.body.textContent ?? '', /\[طول\]/);
  });
});
