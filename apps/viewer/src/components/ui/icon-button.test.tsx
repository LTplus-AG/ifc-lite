/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IconButton` (#5811): an icon-only button always has an accessible name,
 * and the same text shows as a tooltip on keyboard focus, not only on hover.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Plus } from 'lucide-react';
import { TooltipProvider } from './tooltip.js';
import { IconButton } from './icon-button.js';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './dialog.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: ReactNode): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<TooltipProvider delayDuration={0}>{node}</TooltipProvider>));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('IconButton', () => {
  it('names the button with its label and renders only the icon inside', () => {
    const host = render(<IconButton label="Add property"><Plus /></IconButton>);
    const button = host.querySelector('button');
    assert.ok(button, 'renders a <button>');
    assert.equal(button.getAttribute('aria-label'), 'Add property');
    assert.equal(button.getAttribute('type'), 'button', 'never submits a surrounding form by accident');
    assert.equal(button.getAttribute('title'), null, 'no title= duplicate of the tooltip');
    assert.equal(button.textContent, '', 'the label is not rendered as visible text');
  });

  it('shows the label as a tooltip on keyboard focus', async () => {
    const host = render(<IconButton label="Undo"><Plus /></IconButton>);
    const button = host.querySelector('button')!;
    await act(async () => {
      button.focus();
    });
    const tip = document.querySelector('[role="tooltip"]');
    assert.ok(tip, 'focusing the button opens a tooltip');
    assert.equal(tip.textContent, 'Undo');
  });

  it('shows `tooltip` as the visible text while keeping `label` as the name', async () => {
    const host = render(<IconButton label="Save" tooltip="Review scope"><Plus /></IconButton>);
    const button = host.querySelector('button')!;
    await act(async () => {
      button.focus();
    });
    assert.equal(button.getAttribute('aria-label'), 'Save');
    assert.equal(document.querySelector('[role="tooltip"]')?.textContent, 'Review scope');
  });

  it('keeps extra tooltip text as the button description while the tooltip is closed', () => {
    const host = render(<IconButton label="Fork" tooltip="Fork: edit this extension in the chat"><Plus /></IconButton>);
    const button = host.querySelector('button')!;
    assert.equal(document.querySelector('[role="tooltip"]'), null, 'tooltip is closed');
    const describedBy = button.getAttribute('aria-describedby');
    assert.ok(describedBy, 'the button has a description');
    const description = document.getElementById(describedBy);
    assert.equal(description?.textContent, 'Fork: edit this extension in the chat');
    assert.ok(description?.hidden, 'the description takes no layout');
  });

  it('adds no description when the tooltip only repeats the label', () => {
    const host = render(<IconButton label="Undo" tooltip="Undo"><Plus /></IconButton>);
    assert.equal(host.querySelector('button')!.getAttribute('aria-describedby'), null);
  });

  it('forwards its ref and passes a Radix trigger through (asChild composition)', () => {
    const ref = createRef<HTMLButtonElement>();
    const host = render(
      <Dialog>
        <DialogTrigger asChild>
          <IconButton ref={ref} label="Open editor"><Plus /></IconButton>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Editor</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const button = host.querySelector('button')!;
    assert.equal(ref.current, button);
    act(() => {
      button.click();
    });
    assert.ok(document.querySelector('[role="dialog"]'), 'the dialog trigger still opens its dialog');
    assert.equal(button.getAttribute('aria-label'), 'Open editor');
  });

  it('renders with no TooltipProvider above it (a tour card, a standalone dialog)', async () => {
    // Radix throws "`Tooltip` must be used within `TooltipProvider`"; a button
    // that used to carry a plain `title=` must not start crashing where the
    // app shell's provider is absent.
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<IconButton label="Close tour"><Plus /></IconButton>));
    const button = container.querySelector('button')!;
    assert.equal(button.getAttribute('aria-label'), 'Close tour');
    await act(async () => {
      button.focus();
    });
    assert.ok(document.querySelector('[role="tooltip"]'), 'its own provider still opens the tooltip');
  });

  it('falls back to the label when `tooltip` is empty', async () => {
    const host = render(<IconButton label="Undo" tooltip=""><Plus /></IconButton>);
    const button = host.querySelector('button')!;
    await act(async () => {
      button.focus();
    });
    assert.equal(document.querySelector('[role="tooltip"]')?.textContent, 'Undo');
    assert.equal(button.getAttribute('aria-describedby'), null);
  });
});

/**
 * `label` is required. That is a compile-time guarantee, so it is checked at
 * compile time, not by a runtime assertion (constructing JSX always succeeds):
 * `pnpm typecheck` runs this file through `scripts/typecheck-tests.mjs`, and
 * the directive below becomes an "unused @ts-expect-error" error the moment
 * `label` turns optional.
 */
export function labelIsRequired(): unknown {
  // @ts-expect-error `label` is required: an icon-only button without a name is the defect.
  return <IconButton><Plus /></IconButton>;
}
