/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A dropdown menu body must stay inside the viewport and scroll what does not
 * fit (PR #2510 review, Codex P2).
 *
 * The classic strip's View menu grew a 12-command camera block, and on a short
 * desktop window the whole menu no longer fitted: measured at 1280x640 it drew
 * 697px of menu into 640px of window, ending 101px below the fold. Nothing
 * recovered those items — the base style was `overflow-hidden` with no
 * `max-height`, so the Projection / Helpers / Toolbar controls at the bottom
 * could be neither seen nor scrolled to. Radix already measures the space it
 * has (`--radix-dropdown-menu-content-available-height`); the styling simply
 * never read it.
 *
 * SCOPE OF THIS TEST. happy-dom has no layout engine, so nothing here can
 * measure a rendered height — that half was verified in a real browser, before
 * and after (before: 697px tall, `max-height: none`, `overflow-y: hidden`,
 * last item bottom at y=736 with the window 640 tall and unreachable; after:
 * capped at 596.5px, `overflow-y: auto`, scrollHeight 695 > clientHeight 595,
 * last item reachable by scrolling; and at a tall window the cap does not
 * bind and no scrollbar appears). What this test pins is that the two
 * declarations doing the work are still on the REAL rendered menu node, for
 * both the menu body and its submenus, so they cannot be dropped silently.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: ReactNode): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/** The Radix variable is the whole point: a fixed cap would be wrong at every
 *  other window height, and a viewport unit ignores where the trigger sits. */
const AVAILABLE_HEIGHT_VAR = '--radix-dropdown-menu-content-available-height';

function assertFitsAndScrolls(node: Element, label: string): void {
  const classes = node.className;
  assert.ok(
    classes.includes(`max-h-[var(${AVAILABLE_HEIGHT_VAR})]`),
    `${label} must cap its height at the space Radix measured, got: ${classes}`,
  );
  assert.ok(
    classes.includes('overflow-y-auto'),
    `${label} must scroll what does not fit, got: ${classes}`,
  );
  // The shorthand must be gone rather than merely paired with `overflow-y-auto`:
  // with both present, which one wins is Tailwind's emitted rule order, not ours.
  assert.ok(
    !/(?:^|\s)overflow-hidden(?:\s|$)/.test(classes),
    `${label} must not re-add the overflow shorthand next to overflow-y-auto, got: ${classes}`,
  );
}

describe('dropdown menu bodies fit the viewport', () => {
  it('caps the menu body and scrolls the overflow', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuItem>Only item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu, 'the menu body must render');
    assertFitsAndScrolls(menu, 'DropdownMenuContent');
  });

  it('caps submenu bodies too', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const menus = [...document.querySelectorAll('[role="menu"]')];
    assert.equal(menus.length, 2, 'both the menu and its submenu must render');
    for (const menu of menus) assertFitsAndScrolls(menu, 'submenu body');
  });
});
