/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { createPortal } from 'react-dom';
import { cleanup, click, press, render, type, waitFor } from '@/test/render.js';
import { ConfirmDialogHost, confirmDialog, promptDialog } from '@/components/ui/confirm-dialog';
import { PortalContainerProvider } from '@/components/ui/portal-container';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { DocumentMenu } from './DocumentMenu';

const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  cleanup();
  for (const frame of frames.splice(0)) frame.remove();
});

function childDocument(): Document {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  frames.push(frame);
  assert.ok(frame.contentDocument);
  return frame.contentDocument;
}

function MenuHarness() {
  const [doc, setDoc] = useState<DocumentSpec>({ version: DOCUMENT_VERSION, id: 'doc-6488', name: 'Report', page: { size: 'A4', orientation: 'portrait' }, blocks: [] });
  return <><output>{doc.name}</output><DocumentMenu document={doc} onUpsert={setDoc} onActivate={() => {}} onDelete={() => {}} /></>;
}

function openMenu(source: Document): void {
  const trigger = source.querySelector<HTMLButtonElement>('button[aria-label="Document actions"]');
  assert.ok(trigger);
  act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  click(trigger);
}

function choose(source: Document, label: string): void {
  const item = [...source.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === label);
  assert.ok(item, `${label} is available`);
  click(item);
}

it('#6488 rename, cancel and Escape leave the popped-out document interactive', async () => {
  const child = childDocument();
  render(<><ConfirmDialogHost />{createPortal(<PortalContainerProvider container={child.body}><MenuHarness /></PortalContainerProvider>, child.body)}</>);
  for (const action of ['save', 'cancel', 'escape'] as const) {
    openMenu(child);
    choose(child, 'Rename');
    const dialog = child.querySelector<HTMLElement>('[role="alertdialog"]');
    assert.ok(dialog, 'the prompt belongs to the window that opened the menu');
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
    const input = dialog.querySelector<HTMLInputElement>('input');
    assert.ok(input);
    assert.equal(child.activeElement, input);
    type(input, action === 'save' ? 'Renamed report' : 'Discard this');
    if (action === 'save') click(dialog.querySelector('button[type="submit"]')!);
    else if (action === 'cancel') click(dialog.querySelector('button')!);
    else press(input, 'Escape');
    await waitFor(() => !child.querySelector('[role="alertdialog"]'), 'rename dialog closes');
    await waitFor(() => child.querySelector('output')?.textContent === 'Renamed report', 'the saved name is applied and cancellation preserves it');
    assert.equal(child.querySelector('output')?.textContent, 'Renamed report');
    await waitFor(() => child.body.style.pointerEvents !== 'none', 'child modal lock is released');
    assert.notEqual(document.body.style.pointerEvents, 'none', 'main window remains interactive');
  }
  openMenu(child);
  choose(child, 'Duplicate');
  await waitFor(() => child.querySelector('output')?.textContent === 'Renamed report (copy)', 'Duplicate still works after renaming');
});

it('#6488 requests queued across documents release the correct modal lock', async () => {
  const child = childDocument();
  render(<ConfirmDialogHost />);
  let first!: Promise<boolean>;
  let second!: Promise<string | null>;
  let third!: Promise<boolean>;
  act(() => {
    first = confirmDialog({ description: 'Main first' });
    second = promptDialog({ description: 'Child second' }, child.body);
    third = confirmDialog({ description: 'Main third' });
  });
  click(document.querySelector('[role="alertdialog"] button')!);
  assert.equal(await first, false);
  assert.match(child.querySelector('[role="alertdialog"]')?.textContent ?? '', /Child second/);
  assert.notEqual(document.body.style.pointerEvents, 'none');
  click(child.querySelector('[role="alertdialog"] button')!);
  assert.equal(await second, null);
  assert.match(document.querySelector('[role="alertdialog"]')?.textContent ?? '', /Main third/);
  assert.notEqual(child.body.style.pointerEvents, 'none');
  click(document.querySelector('[role="alertdialog"] button')!);
  assert.equal(await third, false);
  assert.notEqual(document.body.style.pointerEvents, 'none');
});

it('#6488 closing a source window cancels its active and queued requests', async () => {
  const child = childDocument();
  render(<ConfirmDialogHost />);
  let first!: Promise<string | null>;
  let second!: Promise<boolean>;
  act(() => {
    first = promptDialog({ description: 'Child active' }, child.body);
    second = confirmDialog({ description: 'Child queued' }, child.body);
  });
  act(() => child.defaultView?.dispatchEvent(new window.Event('pagehide')));
  assert.equal(await first, null);
  assert.equal(await second, false);
  assert.equal(child.querySelector('[role="alertdialog"]'), null);
  assert.notEqual(child.body.style.pointerEvents, 'none');
});
