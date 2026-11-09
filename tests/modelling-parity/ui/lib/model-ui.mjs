/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model workspace moves a modeller makes, expressed as real UI input (#9296).
 *
 * Every helper here goes through `session.ui`, so it counts actions, except
 * the `read*` and `export*ForOracle` helpers, which are the harness looking at
 * the result. Labels are the viewer's English strings; when a redesign
 * renames one, the probe fails loudly at that step instead of passing quietly.
 */

import { downloadCount, nextDownload } from './driver.mjs';
import { readStep } from './step.mjs';

/** Tool shortcuts as the rail menus show them. */
export const TOOL_KEYS = {
  'wall.place': 'w',
  'slab.place': 'Shift+S',
  'column.place': 'Shift+C',
  'beam.place': 'Shift+B',
  'room.place': 'Shift+O',
  'curtainwall.place': 'Shift+U',
  'grid.place': 'Shift+G',
  'opening.place': 'Shift+H',
  'door.place': 'Shift+D',
  'window.place': 'Shift+W',
  'stair.place': 'Shift+T',
  'railing.place': 'Shift+L',
};

/** Welcome screen -> Start blank. Waits for the Model workspace and its auto-started wall tool. */
export async function startBlank(s, { count = true } = {}) {
  const { page } = s;
  await page.getByRole('button', { name: 'Dismiss tour invite' }).click({ timeout: 1500 }).catch(() => {});
  const button = page.getByRole('button', { name: 'Start blank' });
  if (count) await s.ui.click(button, { timeout: 30000 });
  else await button.click({ timeout: 30000 });
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().session?.activeCommandId, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  await s.harness.dismissToasts();
}

/** Store facts a probe reads after acting. */
export const readSession = (s) => s.state(() => {
  const st = globalThis.__ifc_lite_viewer_store__.getState();
  return {
    command: st.session?.activeCommandId ?? null,
    phase: st.session?.phase ?? null,
    storeyId: st.session?.storeyId ?? null,
    modelId: st.session?.modelId ?? null,
    selected: Math.max([...(st.selectedEntityIds ?? [])].length, st.selectedEntityId != null ? 1 : 0),
    layout: st.modelLayout ?? null,
  };
});

export const hudText = (s) => s.state(() => document.querySelector('[data-testid=model-3d-panel]')?.innerText.replace(/\n/g, ' | ').slice(0, 400) ?? '');
export const toasts = (s) => s.state(() => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.innerText.replace(/\n/g, ' ')).slice(-3));

/** Leave any command and clear selection: two Escapes, as a modeller would. */
export async function escape(s, times = 2) {
  for (let i = 0; i < times; i++) await s.ui.key('Escape', { settle: 80 });
}

/** Start a tool by its keyboard shortcut (one action). Focus goes to the canvas first. */
export async function tool(s, commandId) {
  const key = TOOL_KEYS[commandId];
  if (!key) throw new Error(`no shortcut known for ${commandId}`);
  await s.ui.key(key, { settle: 300 });
  const got = (await readSession(s)).command;
  if (got !== commandId) throw new Error(`shortcut ${key} started ${got ?? 'nothing'}, expected ${commandId}`);
}

/** Open a rail group and pick an item by its visible name (two actions). */
export async function railItem(s, group, item) {
  await s.ui.click(s.page.getByRole('button', { name: group, exact: true }));
  await s.ui.click(s.page.getByRole('menuitem', { name: new RegExp(`^${item}\\b`) }).first());
}

/** Type values into the drawing HUD's fields: value, Tab, value ..., then Enter. */
export async function typeFields(s, values, { enter = true } = {}) {
  for (let i = 0; i < values.length; i++) {
    await s.ui.type(String(values[i]));
    if (i < values.length - 1) await s.ui.key('Tab', { settle: 100 });
  }
  if (enter) await s.ui.key('Enter', { settle: 300 });
}

/** The storey chip -> "Manage storeys…" (two actions). */
export async function openStoreyManager(s) {
  const { page } = s;
  if (await page.locator('[data-storey-manager]').isVisible().catch(() => false)) return;
  await s.ui.click(page.getByTitle('Choose the storey to draw on').first());
  await s.ui.click(page.getByText('Manage storeys…'));
  await page.locator('[data-storey-manager]').waitFor({ timeout: 5000 });
}

/**
 * The storey chip -> pick a storey by name (two actions). The list stays open
 * after the pick and swallows shortcuts such as Ctrl+Shift+V, so a modeller
 * closes it with Escape (a third action); that is recorded as a finding.
 */
export async function switchStorey(s, name) {
  const { page } = s;
  await s.ui.click(page.getByTitle('Choose the storey to draw on').first());
  await s.ui.click(page.locator('ul[aria-label=Storeys]').getByRole('button', { name: new RegExp(`^${name}\\s`) }).first());
  if (await page.locator('ul[aria-label=Storeys]').isVisible().catch(() => false)) {
    s.findings.add('Picking a storey from the storey chip leaves the list open, and shortcuts such as Ctrl+Shift+V do nothing until Escape closes it.');
    await s.ui.key('Escape');
  }
}

/** Storey rows as the manager shows them (harness read). */
export const readStoreyManager = (s) => s.state(() => document.querySelector('[data-storey-manager]')?.innerText ?? null);

/**
 * Export the model through File -> Export modified IFC and return the text.
 * `count: false` is the oracle's own export: same clicks, not counted.
 */
export async function exportIfc(s, { count = true, schema } = {}) {
  const { page } = s;
  const click = async (loc) => (count ? s.ui.click(loc) : loc.click({ timeout: 5000 }));
  const before = await downloadCount(page);
  await click(page.getByRole('tab', { name: 'File' }));
  await click(page.getByRole('button', { name: /Export modified IFC/ }).first());
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 8000 });
  if (schema) await click(dialog.getByRole('radio', { name: schema }).or(dialog.getByRole('button', { name: schema, exact: true })).first());
  await click(dialog.getByRole('button', { name: /^Export/ }).last());
  const dl = await nextDownload(page, before);
  // Back to the Author tab so the next step sees the Model workspace chrome.
  await page.getByRole('tab', { name: 'Author' }).click({ timeout: 3000 }).catch(() => {});
  return dl;
}

/** Export without counting and parse it. */
export async function oracleModel(s) {
  const dl = await exportIfc(s, { count: false });
  s.lastExport = dl;
  return { name: dl.name, text: dl.text, step: readStep(dl.text) };
}
