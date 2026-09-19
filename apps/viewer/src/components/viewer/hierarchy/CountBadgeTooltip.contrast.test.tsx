/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins the rendered count tooltip to the app's accessible semantic tokens.
 *
 * The hover card over a storey's object-count badge renders inside
 * `TooltipContent` used to pair the accent-blue `bg-primary` with
 * `text-primary-foreground`. That measured only 2.52:1 in light mode even at
 * full opacity, so no local secondary-text tweak could meet WCAG AA. The
 * shared primitive now uses the same neutral `bg-popover` /
 * `text-popover-foreground` surface as the other floating UI (19.9:1 light,
 * 8.52:1 dark), and the secondary lines use `text-muted-foreground`.
 *
 * This test asserts the class NAMES so a future edit can't silently
 * reintroduce a hardcoded neutral: reverting the fix (className reverted to
 * `text-zinc-400 dark:text-zinc-500`) turns this red.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.js';
import { CountBadgeTooltip } from './CountBadgeTooltip.js';
import { registerLocale, setLocale } from '@/i18n';

const summary = {
  counted: 5,
  rows: 6,
  typeCounts: [['IfcWall', 3], ['IfcDoor', 2]] as Array<[string, number]>,
  withoutGeometry: 0,
  spacesNotCounted: 1,
  geometryKnown: true,
};

afterEach(() => { cleanup(); setLocale('en'); });

describe('CountBadgeTooltip contrast', () => {
  it('renders the headline at text-xs', () => {
    const container = render(<CountBadgeTooltip elementCount={5} summary={summary} />);
    const headline = container.querySelector('p');
    assert.equal(headline?.textContent, '5 objects');
    assert.equal(headline?.className, 'text-xs');
  });

  it('renders on the popover surface with semantic muted secondary text', () => {
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>5</TooltipTrigger>
        <TooltipContent>
          <CountBadgeTooltip elementCount={5} summary={summary} />
        </TooltipContent>
      </Tooltip>,
    );

    const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    assert.ok(tooltip);
    assert.ok(tooltip.classList.contains('bg-popover'));
    assert.ok(tooltip.classList.contains('text-popover-foreground'));
    assert.ok(!tooltip.classList.contains('bg-primary'));

    const secondaryLines = Array.from(tooltip.querySelectorAll('p')).slice(1);
    assert.equal(secondaryLines.length, 2);
    for (const line of secondaryLines) {
      assert.equal(line.className, 'text-[10px] text-muted-foreground');
    }
  });

  it('resolves semantic count lines through the active catalogue (#4918)', () => {
    registerLocale('count-tooltip-test', {
      'hierarchy.countBadge.objects': { one: 'PSEUDO one {formatted}', other: 'PSEUDO many {formatted}' },
      'hierarchy.countBadge.spacesNotCounted': { one: 'PSEUDO space {formatted}', other: 'PSEUDO spaces {formatted}' },
    });
    setLocale('count-tooltip-test');
    const container = render(<CountBadgeTooltip elementCount={5} summary={summary} />);
    assert.match(container.textContent, /PSEUDO many 5/);
    assert.match(container.textContent, /PSEUDO space 1/);
  });

  it('formats every count with the active catalogue locale (#4918)', () => {
    registerLocale('de', {
      'hierarchy.countBadge.objects': { one: '{formatted} Objekt', other: '{formatted} Objekte' },
      'hierarchy.countBadge.spacesNotCounted': { one: '{formatted} Raum', other: '{formatted} Räume' },
    });
    setLocale('de');
    const localized = {
      ...summary,
      counted: 1234,
      typeCounts: [['IfcWall', 1234]] as Array<[string, number]>,
      spacesNotCounted: 1234,
    };
    const container = render(<CountBadgeTooltip elementCount={1234} summary={localized} />);
    assert.match(container.textContent, /1\.234 Objekte/);
    assert.match(container.textContent, /1\.234 IfcWall/);
    assert.match(container.textContent, /1\.234 Räume/);
  });
});
