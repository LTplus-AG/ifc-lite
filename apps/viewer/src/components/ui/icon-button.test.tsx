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

  it('requires a label at the type level', () => {
    // @ts-expect-error `label` is required: an icon-only button without a name is the defect.
    const element = <IconButton><Plus /></IconButton>;
    assert.ok(element);
  });
});
