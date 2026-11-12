/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useLayoutEffect, useState } from 'react';
import { cleanup, render } from '@/test/render.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';
import { Toaster, toast } from './toast';

afterEach(() => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss notification"]')) act(() => button.click());
  cleanup();
});

it('#9875 a notice from a child layout effect belongs to the opening modal', () => {
  function Failure() {
    useLayoutEffect(() => { toast.error('Preview refused'); }, []);
    return null;
  }
  render(<Toaster />);
  render(<Dialog open><DialogContent><DialogTitle>Preview</DialogTitle><DialogDescription>Review</DialogDescription><Failure /></DialogContent></Dialog>);
  assert.ok(document.querySelector('[role="dialog"] [data-dialog-notices]')?.textContent?.includes('Preview refused'));
});

it('#9875 the deepest modal owns a notice, and closing it preserves that notice at the app anchor', () => {
  const anchor = render(<Toaster />);
  render(<Dialog open><DialogContent><DialogTitle>Parent</DialogTitle><DialogDescription>Review</DialogDescription>
    <Dialog open><DialogContent><DialogTitle>Child</DialogTitle><DialogDescription>Review</DialogDescription></DialogContent></Dialog>
  </DialogContent></Dialog>);
  act(() => toast.error('Child operation failed'));
  const dialogs = [...document.querySelectorAll('[role="dialog"]')];
  assert.equal(dialogs.length, 2);
  assert.ok(dialogs[1]?.querySelector('[data-dialog-notices]')?.textContent?.includes('Child operation failed'));
  assert.equal(dialogs[0]?.querySelector('[data-dialog-notices]'), null);
  assert.ok(!anchor.textContent?.includes('Child operation failed'));
  cleanup();
  const nextAnchor = render(<Toaster />);
  assert.ok(nextAnchor.textContent?.includes('Child operation failed'), 'closing the modal must not discard persistent errors');
});

it('#9875 non-modal previews keep using the app toast anchor', () => {
  const anchor = render(<Toaster />);
  render(<Dialog open modal={false}><DialogContent><DialogTitle>Preview</DialogTitle><DialogDescription>Review</DialogDescription></DialogContent></Dialog>);
  act(() => toast.info('Preview updated'));
  assert.ok(anchor.textContent?.includes('Preview updated'));
  assert.equal(document.querySelector('[data-dialog-notices]'), null);
});

it('#9875 modal success notices remain visible for their existing lifetime', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  render(<Toaster />);
  render(<Dialog open><DialogContent><DialogTitle>Settings</DialogTitle><DialogDescription>Review</DialogDescription></DialogContent></Dialog>);
  const liveRegion = document.querySelector('[role="dialog"] [aria-live="polite"]');
  assert.ok(liveRegion, 'the polite live region exists before the first notice');
  assert.equal(document.querySelector('[role="dialog"] [role="alert"]'), null, 'an empty notice shelf is not a dialog validation alert');
  assert.equal(document.querySelector('[role="dialog"] [role="status"]'), null, 'the shelf does not impersonate the dialog progress status');
  act(() => toast.success('Settings saved'));
  assert.equal(document.querySelector('[role="dialog"] [aria-live="polite"]'), liveRegion, 'first notice updates the existing live region');
  assert.ok(document.querySelector('[data-dialog-notices]')?.textContent?.includes('Settings saved'));
  act(() => t.mock.timers.tick(3000));
  assert.equal(document.querySelector('[data-dialog-notices]'), null);
});

it('#9875 a newly opened independent modal owns notices above an older nested modal', () => {
  render(<Toaster />);
  render(<Dialog open><DialogContent><DialogTitle>Parent</DialogTitle><DialogDescription>Review</DialogDescription>
    <Dialog open><DialogContent><DialogTitle>Nested</DialogTitle><DialogDescription>Review</DialogDescription></DialogContent></Dialog>
  </DialogContent></Dialog>);
  render(<Dialog open><DialogContent><DialogTitle>New modal</DialogTitle><DialogDescription>Review</DialogDescription></DialogContent></Dialog>);
  act(() => toast.error('Newest modal failure'));
  const dialogs = [...document.querySelectorAll('[role="dialog"]')];
  assert.equal(dialogs.length, 3);
  assert.ok(dialogs[2]?.querySelector('[data-dialog-notices]')?.textContent?.includes('Newest modal failure'));
  assert.equal(dialogs[1]?.querySelector('[data-dialog-notices]'), null);
});

it('#9875 reopening a dialog does not re-adopt notices from its previous opening', () => {
  let changeOpen: (open: boolean) => void = () => { throw new Error('Dialog not mounted'); };
  function Controlled() {
    const [open, setOpen] = useState(true);
    changeOpen = setOpen;
    return <Dialog open={open}><DialogContent><DialogTitle>Settings</DialogTitle><DialogDescription>Review</DialogDescription></DialogContent></Dialog>;
  }
  const anchor = render(<Toaster />);
  render(<Controlled />);
  act(() => toast.error('Previous save failed'));
  act(() => changeOpen(false));
  assert.ok(anchor.textContent?.includes('Previous save failed'));
  act(() => changeOpen(true));
  assert.ok(anchor.textContent?.includes('Previous save failed'));
  assert.equal(document.querySelector('[role="dialog"] [data-dialog-notices]'), null);
  act(() => toast.error('Current save failed'));
  assert.ok(document.querySelector('[data-dialog-notices]')?.textContent?.includes('Current save failed'));
});

it('#9875 an opening dialog without a mounted panel cannot hide app notifications', () => {
  const anchor = render(<Toaster />);
  render(<Dialog open><p>Loading dialog content</p></Dialog>);
  act(() => toast.error('Loading failed before the panel opened'));
  assert.ok(anchor.textContent?.includes('Loading failed before the panel opened'));
  assert.equal(document.querySelector('[role="dialog"]'), null);
});

it('#9875 closing a nested modal keeps its success notice readable in the still-open parent', () => {
  let closeChild: () => void = () => { throw new Error('Dialog not mounted'); };
  function Nested() {
    const [open, setOpen] = useState(true);
    closeChild = () => setOpen(false);
    return <Dialog open><DialogContent><DialogTitle>Parent</DialogTitle><DialogDescription>Review</DialogDescription>
      <Dialog open={open}><DialogContent><DialogTitle>Child</DialogTitle><DialogDescription>Review</DialogDescription></DialogContent></Dialog>
    </DialogContent></Dialog>;
  }
  const anchor = render(<Toaster />);
  render(<Nested />);
  act(() => toast.success('Flavor merged'));
  act(closeChild);
  assert.ok(document.querySelector('[role="dialog"] [data-dialog-notices]')?.textContent?.includes('Flavor merged'));
  assert.ok(!anchor.textContent?.includes('Flavor merged'));
});

it('#9875 closing an older modal cannot promote its notice over a later-opened modal', () => {
  let changeFirst: (open: boolean) => void = () => { throw new Error('Dialog not mounted'); };
  let changeSecond: (open: boolean) => void = changeFirst;
  function Surfaces() {
    const [first, setFirst] = useState(true);
    const [second, setSecond] = useState(false);
    changeFirst = setFirst;
    changeSecond = setSecond;
    return <>
      <Dialog open={first}><DialogContent><DialogTitle>First</DialogTitle><DialogDescription>Review</DialogDescription></DialogContent></Dialog>
      <Dialog open={second}><DialogContent><DialogTitle>Second</DialogTitle><DialogDescription>Review</DialogDescription></DialogContent></Dialog>
    </>;
  }
  const anchor = render(<Toaster />);
  render(<Surfaces />);
  act(() => toast.error('Earlier failure'));
  act(() => changeSecond(true));
  act(() => changeFirst(false));
  assert.equal(document.querySelector('[role="dialog"] [data-dialog-notices]'), null);
  assert.ok(anchor.textContent?.includes('Earlier failure'));
});


it('#9875 repeated errors in different surfaces preserve independent dismissal', () => {
  const anchor = render(<Toaster />);
  act(() => toast.error('Export failed'));
  render(<Dialog open><DialogContent><DialogTitle>Export</DialogTitle><DialogDescription>Review</DialogDescription></DialogContent></Dialog>);
  act(() => toast.error('Export failed'));
  const shelf = document.querySelector('[role="dialog"] [data-dialog-notices]');
  assert.ok(shelf?.textContent?.includes('Export failed'));
  assert.ok(anchor.textContent?.includes('Export failed'), 'the earlier app error retains its anchor');
  act(() => shelf?.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]')?.click());
  assert.equal(document.querySelector('[role="dialog"] [data-dialog-notices]'), null);
  assert.ok(anchor.textContent?.includes('Export failed'), 'dismissing the modal error preserves the app failure');
});


it('#9875 keyed save updates replace the same operation across surfaces and after closing', () => {
  const app = render(<Toaster />);
  act(() => toast.error('Save failed', 'save'));
  render(<Dialog open><DialogContent><DialogTitle>Save</DialogTitle><DialogDescription>Review</DialogDescription></DialogContent></Dialog>);
  act(() => toast.error('Save failed', 'save'));
  assert.ok(!app.textContent?.includes('Save failed'), 'a keyed operation moves its existing notice to its current surface');
  assert.equal(document.querySelectorAll('button[aria-label="Dismiss notification"]').length, 1);
  cleanup();
  const anchor = render(<Toaster />);
  act(() => toast.success('Saved', undefined, 'save'));
  assert.ok(anchor.textContent?.includes('Saved'));
  assert.ok(!anchor.textContent?.includes('Save failed'), 'success clears every earlier notice of this operation');
  assert.equal(anchor.querySelectorAll('button[aria-label="Dismiss notification"]').length, 1);
});

it('#9875 unkeyed errors coalesce after their owning surfaces converge', () => {
  render(<Toaster />);
  act(() => toast.error('Repeated failure'));
  render(<Dialog open><DialogContent><DialogTitle>Save</DialogTitle><DialogDescription>Review</DialogDescription></DialogContent></Dialog>);
  act(() => toast.error('Repeated failure'));
  assert.equal(document.querySelectorAll('button[aria-label="Dismiss notification"]').length, 2);
  cleanup();
  const anchor = render(<Toaster />);
  act(() => toast.error('Repeated failure'));
  assert.equal(anchor.querySelectorAll('button[aria-label="Dismiss notification"]').length, 1);
  assert.match(anchor.textContent ?? '', /×3/, 'all three occurrences are counted without leaving a stale duplicate');
});
