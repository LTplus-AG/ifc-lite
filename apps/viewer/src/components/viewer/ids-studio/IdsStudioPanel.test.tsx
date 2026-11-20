/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS-030 … IDS-032 through the mounted panel: create a document, add a
 * specification from the outline, edit it in the inspector, move through the
 * outline with the keyboard, and undo. Every assertion reads the Studio
 * document, which only ops can change.
 */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { clearDownloads, downloadedNames } from '@/test/download-capture.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blur, cleanup, click, press, render, type, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { loadStudioContexts } from '@/lib/ids-studio/context';
import { exportIds } from '@/lib/ids-studio/export';
import { wallFixture } from '@/test/ids-studio-fixture';
import { IdsStudioPanel } from './IdsStudioPanel';

const doc = () => useViewerStore.getState().idsStudioState?.doc;
const byText = (root: HTMLElement, selector: string, text: string) =>
  [...root.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text || el.textContent?.includes(text));
const labelled = (root: HTMLElement, label: string) => {
  const forId = [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)?.getAttribute('for');
  const control = forId ? root.querySelector<HTMLInputElement>(`[id="${forId}"]`) : null;
  assert.ok(control, `no control labelled "${label}"`);
  return control;
};

beforeEach(async () => {
  useViewerStore.getState().idsStudioClose();
  useViewerStore.getState().idsStudioSetContexts(await loadStudioContexts());
});
afterEach(cleanup);

describe('IdsStudioPanel (IDS-030 … IDS-032)', () => {
  it('creates a document from the empty state and adds a specification from the outline', () => {
    const ui = render(<IdsStudioPanel />);
    type(labelled(ui, 'Title'), 'Fire safety');
    click(byText(ui, 'button', 'New IDS') as HTMLElement);
    assert.equal(doc()?.ids.info.title, 'Fire safety');
    assert.ok(ui.querySelector('[data-tour="ids-studio-panel"]'), 'the tour anchor is rendered');

    click(byText(ui, 'button', 'Add specification') as HTMLElement);
    assert.equal(doc()?.ids.specifications.length, 1);
    assert.deepEqual(doc()?.ids.specifications[0].ifcVersions, ['IFC4']);
    const row = ui.querySelector('[role="treeitem"][aria-level="1"]');
    assert.ok(row?.textContent?.includes('New specification'), 'the outline shows the new spec');
    assert.equal(row?.getAttribute('aria-selected'), 'true', 'and selects it');
    assert.ok(byText(ui, 'h3', 'Specification'), 'the inspector shows the specification');
  });

  it('commits a renamed specification as one op and undo restores it', async () => {
    const fixture = await wallFixture();
    useViewerStore.getState().idsStudioOpen(fixture.doc);
    useViewerStore.getState().idsStudioSelect(fixture.specId);
    const ui = render(<IdsStudioPanel />);
    const name = labelled(ui, 'Name');
    type(name, 'Walls');
    assert.equal(doc()?.ids.specifications[0].name, 'Walls – fire rating', 'typing alone writes nothing');
    blur(name);
    assert.equal(doc()?.ids.specifications[0].name, 'Walls');
    assert.equal(useViewerStore.getState().idsStudioState?.history.past.length, 1);
    click(ui.querySelector('[aria-label="Undo (Ctrl+Z)"]') as HTMLElement);
    assert.equal(doc()?.ids.specifications[0].name, 'Walls – fire rating');
  });

  it('sets the specification cardinality and explains what it means', async () => {
    const fixture = await wallFixture();
    useViewerStore.getState().idsStudioOpen(fixture.doc);
    useViewerStore.getState().idsStudioSelect(fixture.specId);
    const ui = render(<IdsStudioPanel />);
    const prohibited = [...ui.querySelectorAll('label')].find((l) => l.textContent === 'Prohibited')?.querySelector('input');
    assert.ok(prohibited);
    click(prohibited);
    assert.equal(doc()?.ids.specifications[0].maxOccurs, 0);
    assert.ok(ui.textContent?.includes('No element may match the applicability'));
  });

  it('moves through the outline with the arrow keys and selects with Enter', async () => {
    const fixture = await wallFixture();
    useViewerStore.getState().idsStudioOpen(fixture.doc);
    const ui = render(<IdsStudioPanel />);
    const tree = ui.querySelector('[role="tree"]') as HTMLElement;
    const rows = () => [...tree.querySelectorAll('[role="treeitem"]')];
    assert.equal(rows().length, 5, 'spec, Applies to, the entity, Requires, the property');
    press(tree, 'ArrowDown');
    press(tree, 'ArrowDown');
    press(tree, 'ArrowDown');
    assert.equal(tree.getAttribute('aria-activedescendant'), `outline-${fixture.entityId}`);
    press(tree, 'Enter');
    assert.equal(useViewerStore.getState().idsStudioSelection, fixture.entityId);
    press(tree, 'Home');
    press(tree, 'ArrowLeft');
    assert.equal(rows().length, 1, 'ArrowLeft on an open spec collapses it');
    press(tree, 'ArrowRight');
    assert.equal(rows().length, 5, 'ArrowRight expands it again');
  });

  it('saves the document as .ids and .idsz, and closes it (IDS-040)', async () => {
    const fixture = await wallFixture();
    const exported = { ...fixture.doc, ids: { ...fixture.doc.ids, info: { title: 'Exported draft' } } };
    useViewerStore.getState().idsStudioOpen(exported);
    clearDownloads();
    const ui = render(<IdsStudioPanel />);
    click(ui.querySelector('[aria-label="Save as IDS (.ids)"]') as HTMLElement);
    click(ui.querySelector('[aria-label="Save as Studio bundle (.idsz)"]') as HTMLElement);
    assert.deepEqual(downloadedNames(), ['Exported-draft.ids', 'Exported-draft.idsz']);
    assert.equal(ui.querySelector('[role="alert"]'), null, 'no save error');
    click(ui.querySelector('[aria-label="Close the document"]') as HTMLElement);
    await waitFor(() => useViewerStore.getState().idsStudioState === null, 'closing flushes its scheduled draft');
    assert.ok(byText(ui, 'button', 'New IDS'), 'the empty state is back');
    const summary = byText(ui, 'summary', 'Saved IDS drafts');
    assert.ok(summary, 'export and close preserve the recoverable draft');
    click(summary);
    const savedDraft = [...ui.querySelectorAll('li')].find(row => row.textContent?.includes('Exported draft'));
    assert.ok(savedDraft);
    click(byText(savedDraft, 'button', 'Restore draft') as HTMLElement);
    assert.deepEqual(doc(), exported);
    assert.ok(byText(ui, '[role="status"]', 'Draft saved in this browser'));
    click(byText(ui, 'button', 'Add specification') as HTMLElement);
    assert.ok(byText(ui, '[role="status"]', 'Saving IDS draft…'));
    assert.equal(byText(ui, '[role="status"]', 'Draft saved in this browser'), undefined);
  });

  it('resumes autosaving after browser storage refuses a draft write (#10585)', async ({ mock }) => {
    const fixture = await wallFixture();
    useViewerStore.getState().idsStudioOpen(fixture.doc);
    const ui = render(<IdsStudioPanel />);
    const status = (message: string) => byText(ui, '[role="status"]', message) !== undefined;
    await waitFor(() => status('Draft saved in this browser'), 'the first snapshot commits');
    const transaction = IDBDatabase.prototype.transaction;
    const refusal = mock.method(IDBDatabase.prototype, 'transaction', function (this: IDBDatabase,
      stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) {
      if (stores === 'items' && mode === 'readwrite') throw new DOMException('Storage full', 'QuotaExceededError');
      return transaction.call(this, stores, mode, options);
    });
    try {
      click(byText(ui, 'button', 'Add specification') as HTMLElement);
      await waitFor(() => !!byText(ui, '[role="alert"]', 'The IDS draft could not be saved'), 'quota refusal reaches the editor');
    } finally {
      refusal.mock.restore();
    }
    click(byText(ui, 'button', 'Add specification') as HTMLElement);
    await waitFor(() => status('Draft saved in this browser'), 'the next edit saves after quota recovers');
    assert.equal(doc()?.ids.specifications.length, 3);
  });

  it('undoes and redoes with the panel keyboard shortcuts', async () => {
    const fixture = await wallFixture();
    useViewerStore.getState().idsStudioOpen(fixture.doc);
    useViewerStore.getState().idsStudioSelect(fixture.specId);
    const ui = render(<IdsStudioPanel />);
    const name = labelled(ui, 'Name');
    type(name, 'Walls');
    blur(name);
    const tree = ui.querySelector('[role="tree"]') as HTMLElement;
    press(tree, 'z', { ctrlKey: true });
    assert.equal(doc()?.ids.specifications[0].name, 'Walls – fire rating', 'Ctrl+Z undoes');
    press(tree, 'z', { ctrlKey: true, shiftKey: true });
    assert.equal(doc()?.ids.specifications[0].name, 'Walls', 'Ctrl+Shift+Z redoes');
  });

  it('opens an IDS file dropped on the empty state (IDS-040)', async () => {
    const fixture = await wallFixture();
    const saved = exportIds(fixture.doc);
    assert.ok(saved.ok);
    if (!saved.ok) return;
    const ui = render(<IdsStudioPanel />);
    const file = new File([saved.content], 'walls.ids');
    const drop = new window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
    const zone = ui.querySelector('[data-tour="ids-studio-panel"] > div') as HTMLElement;
    zone.dispatchEvent(drop);
    await waitFor(() => doc() !== undefined, 'the dropped file opens');
    assert.equal(drop.defaultPrevented, true, 'the browser does not navigate to the file');
    assert.equal(doc()?.ids.specifications[0].name, 'Walls – fire rating');
  });
});
