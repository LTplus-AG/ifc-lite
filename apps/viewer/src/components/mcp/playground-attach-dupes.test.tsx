/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two different files sharing a basename, attached in one batch, must not
 * make the UI disagree with `playgroundUploads` about what is attached.
 *
 * The store (`playground-uploads.ts`) already de-dupes by basename,
 * last-wins, on purpose (see the comment at `UploadStore.add`). The bug is
 * that `PlaygroundChat`'s `attachFiles` pushed every resolved entry into its
 * own `pendingAttachments` list with no such de-dupe, so the chip list and
 * the store disagreed: two chips for one store entry, a duplicate React
 * key, and a Remove click that filtered by name and so dropped both chips
 * at once — see the PR body for the full write-up.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PlaygroundChat } from './PlaygroundChat.js';
import { playgroundUploads } from './playground-uploads.js';

function makeFile(name: string, content: string): File {
  return new File([content], name, { type: 'text/plain' });
}

async function attach(input: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // attachFiles awaits file.text() per file — flush those microtasks.
    await new Promise((r) => setTimeout(r, 0));
  });
}

function removeButtons(container: HTMLElement, name: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll(`button[aria-label="Remove ${name}"]`));
}

function allRemoveButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button[aria-label^="Remove "]'));
}

describe('duplicate-basename chat attachments', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    playgroundUploads.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    playgroundUploads.clear();
  });

  it('renders exactly one chip for a duplicate basename, matching the store', async () => {
    await act(async () => {
      root.render(<PlaygroundChat model={null} />);
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    assert.ok(input, 'file input must be present');

    await attach(input, [makeFile('spec.ids', '<A/>'), makeFile('spec.ids', '<B/>')]);

    // The store's own last-wins de-dupe: only <B/> is reachable.
    const resolved = playgroundUploads.resolve('spec.ids');
    assert.ok(resolved, 'store must have an entry for spec.ids');
    assert.equal(resolved!.text, '<B/>', 'store keeps the second file, per its documented last-wins rule');

    // The UI must agree: exactly one chip, not two.
    assert.equal(
      removeButtons(container, 'spec.ids').length,
      1,
      'exactly one chip should be rendered for a duplicate basename',
    );
  });

  it('removing the duplicate chip leaves an unrelated attachment intact', async () => {
    await act(async () => {
      root.render(<PlaygroundChat model={null} />);
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await attach(input, [
      makeFile('dup.ids', '<A/>'),
      makeFile('dup.ids', '<B/>'),
      makeFile('keep.ids', '<C/>'),
    ]);

    assert.equal(allRemoveButtons(container).length, 2, 'one chip per distinct name, not one per file');

    const dupButtons = removeButtons(container, 'dup.ids');
    assert.equal(dupButtons.length, 1, 'the duplicate name must render as a single chip');
    await act(async () => {
      dupButtons[0]!.click();
    });

    assert.equal(allRemoveButtons(container).length, 1, 'only the dup.ids chip should be removed');
    assert.equal(removeButtons(container, 'keep.ids').length, 1, 'keep.ids must survive removing dup.ids');
    assert.ok(playgroundUploads.resolve('keep.ids'), 'keep.ids must still resolve through the store');
    assert.equal(playgroundUploads.resolve('dup.ids'), null, 'dup.ids must be gone from the store too');
  });

  it('does not re-show a prior turn\'s attachment chip after send, even though the store keeps it', async () => {
    // The store deliberately outlives a send (so ids_validate can still
    // resolve an attachment from an earlier turn — playgroundUploads.clear()
    // is never called from onSubmit). The chip list must project only the
    // CURRENT turn's pending names through the store, not "everything the
    // store has ever seen" — else every past attachment reappears as a
    // chip forever.
    await act(async () => {
      root.render(<PlaygroundChat model={null} />);
    });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const form = container.querySelector('form') as HTMLFormElement;
    assert.ok(textarea && form);

    await attach(input, [makeFile('first.ids', '<A/>')]);
    assert.equal(allRemoveButtons(container).length, 1, 'first.ids chip is pending');

    // Submitting clears pendingNames synchronously in onSubmit, even though
    // send() itself will bail out immediately after (no model loaded) —
    // that bail-out happens strictly after the clear, so it doesn't affect
    // what we're testing here.
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    assert.equal(allRemoveButtons(container).length, 0, 'chip list must clear after send');
    assert.ok(playgroundUploads.resolve('first.ids'), 'the store must still hold it for later ids_path resolution');

    await attach(input, [makeFile('second.ids', '<B/>')]);
    assert.equal(allRemoveButtons(container).length, 1, 'only the new attachment is pending, not the old one');
    assert.equal(removeButtons(container, 'first.ids').length, 0, 'the prior turn\'s attachment must not resurface as a chip');
  });
});
