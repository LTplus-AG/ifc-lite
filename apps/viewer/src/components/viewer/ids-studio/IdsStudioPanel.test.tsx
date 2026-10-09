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
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blur, cleanup, click, press, render, type } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { loadStudioContexts } from '@/lib/ids-studio/context';
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
});
