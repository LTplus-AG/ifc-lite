/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test, expect, type Page } from '@playwright/test';

interface Store { __ifc_lite_viewer_store__: { getState(): {
  documentsStorage: { phase: string };
  documents: Array<{ id: string; blocks: Array<{ id: string }> }>;
  upsertDocument(document: unknown): Promise<boolean>;
  setActiveDocumentId(id: string): void;
  showWorkspacePanel(panel: string): void;
  setSidebarActivePanel(panel: string): void;
} } }
const store = () => (globalThis as unknown as Store).__ifc_lite_viewer_store__.getState();
const ID = 'block-jump-8227';

async function order(page: Page): Promise<string> {
  return page.evaluate(id => (globalThis as unknown as Store).__ifc_lite_viewer_store__.getState()
    .documents.find(document => document.id === id)!.blocks.map(block => block.id).join(''), ID);
}
async function previewOrder(page: Page): Promise<string> {
  return page.locator('[data-preview-block]').evaluateAll(blocks => blocks.map(block => block.getAttribute('data-preview-block')).join(''));
}

test('#8227 a block card jumps to the bottom or top with mouse and keyboard, carrying the selection', async ({ page }, info) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto('/');
  await page.waitForFunction(() => (globalThis as unknown as Store).__ifc_lite_viewer_store__?.getState().documentsStorage.phase === 'ready');
  await page.evaluate(() => { const s = (globalThis as unknown as Store).__ifc_lite_viewer_store__.getState(); s.showWorkspacePanel('document'); s.setSidebarActivePanel('model'); });
  const panel = page.locator('[data-document-panel]').first();
  await expect(panel).toBeVisible();
  await page.waitForFunction(() => (globalThis as unknown as Store).__ifc_lite_viewer_store__.getState().documents.length > 0);
  await page.evaluate(async id => {
    const s = (globalThis as unknown as Store).__ifc_lite_viewer_store__.getState();
    await s.upsertDocument({ ...structuredClone(s.documents[0]), id, name: 'Block jump', blocks: ['a', 'b', 'c', 'd', 'e'].map(block => ({ kind: 'text', id: block, text: `Block ${block.toUpperCase()}`, style: 'body' })) });
    s.setActiveDocumentId(id);
  }, ID);
  const jump = (id: string, label: string) => panel.locator(`[data-block-editor="${id}"]`).getByRole('button', { name: label, exact: true });
  await expect(jump('e', 'Move block to bottom')).toHaveAttribute('aria-disabled', 'true');
  await expect(jump('a', 'Move block to top')).toHaveAttribute('aria-disabled', 'true');
  await expect(jump('b', 'Move block to bottom')).toHaveAttribute('title', 'Move block to bottom');
  await panel.screenshot({ path: info.outputPath('before.png') });

  await jump('b', 'Move block to bottom').click();
  await expect.poll(() => order(page)).toBe('acdeb');
  await expect.poll(() => previewOrder(page)).toBe('acdeb');
  await expect(panel.locator('[data-block-list-item="b"] input[type="checkbox"]')).toBeChecked();
  await expect(panel.locator('[data-block-selection-toolbar] output')).toContainText('moved to the end');

  await panel.locator('[data-block-list-item="c"] input[type="checkbox"]').check();
  await jump('c', 'Move selected blocks to bottom').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => order(page)).toBe('adecb');
  // The jump made its own button unavailable; keyboard focus must stay on it, not fall to the page.
  await expect(jump('c', 'Move selected blocks to bottom')).toBeFocused();
  await expect(jump('c', 'Move selected blocks to bottom')).toHaveAttribute('aria-disabled', 'true');
  await panel.screenshot({ path: info.outputPath('group-bottom.png') });

  await jump('b', 'Move selected blocks to top').click();
  await expect.poll(() => order(page)).toBe('cbade');
  await expect.poll(() => previewOrder(page)).toBe('cbade');

  await page.reload();
  await page.waitForFunction(() => (globalThis as unknown as Store).__ifc_lite_viewer_store__?.getState().documentsStorage.phase === 'ready');
  expect(await order(page)).toBe('cbade');
});
