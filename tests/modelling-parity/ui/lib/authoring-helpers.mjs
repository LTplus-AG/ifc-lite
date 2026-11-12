/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9296 U4. Real input only; unsupported sub-tasks remain explicit failed checks.
import { task, downloadCount, nextDownload } from './driver.mjs';
import { escape, tool, typeFields, oracleModel, openStoreyManager } from './model-ui.mjs';

const check = (name, ok, detail) => ({ name, ok: !!ok, detail });
async function field(s, locator, value) {
  await s.ui.click(locator);
  await s.ui.key('Control+A');
  await s.ui.type(String(value));
  await s.ui.key('Enter', { settle: 500 });
}
async function wall(s, y = 0, x = 0) {
  await tool(s, 'wall.place');
  await s.ui.clickWorld([x, y, 0]);
  await typeFields(s, [5, 0]);
  await escape(s);
}
async function selectWall(s, y = 0) {
  await escape(s);
  await s.ui.clickWorld([2.5, y, 1.5]);
  await inspector(s);
}
async function inspector(s) {
  if (await s.page.locator('[data-model-inspector]').isVisible()) return;
  const button = s.page.getByRole('button', { name: 'Model inspector', exact: true });
  if (await button.isVisible()) await s.ui.click(button);
  else {
    await s.ui.click(s.page.getByRole('button', { name: /^More panels/ }));
    await s.ui.click(s.page.locator('[role=menuitem][data-panel-id=model]'));
  }
}
async function typeScope(s) {
  await s.ui.click(s.page.getByRole('radiogroup', { name: 'Apply to', exact: true }).getByText('Type', { exact: true }));
}
async function newType(s, name) {
  await s.ui.click(s.page.locator('[data-inspector-type]'));
  await s.ui.click(s.page.getByRole('option', { name: 'New type…', exact: true }));
  await field(s, s.page.getByLabel('Type name', { exact: true }), name);
}
async function layer(s, n, thickness, material) {
  await field(s, s.page.getByLabel(`Layer ${n} thickness in metres`, { exact: true }), thickness);
  await s.ui.click(s.page.getByLabel(`Layer ${n} material`, { exact: true }));
  await s.ui.click(s.page.getByRole('option', { name: 'New material…', exact: true }));
  await field(s, s.page.getByLabel('Material name', { exact: true }).last(), material);
}
const applyLayers = (s) => s.ui.click(s.page.locator('[data-inspector-apply-layers]'), { settle: 800 });
const body = (step, e) => (step.get(e?.args[6])?.args[2] ?? []).map(step.get).find((r) => r?.args[1] === 'Body');
export function wallSize(step, e) {
  const solid = step.get(body(step, e)?.args[3]?.[0]);
  const profile = step.get(solid?.args[0]);
  return { height: solid?.args[3], thickness: profile?.type === 'IFCRECTANGLEPROFILEDEF' ? profile.args[4] : null };
}
export function layerThicknesses(step) {
  return step.of('IFCMATERIALLAYERSET').map((set) => (set.args[0] ?? []).map((r) => step.get(r)?.args[1]));
}
// RFC4180 cell walk: commas inside quoted names must not shift the Length column.
export function scheduleLengths(text) {
  const rows = [[]]; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i+1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === ',' || ch === '\n')) {
      rows.at(-1).push(cell.replace(/\r$/, '')); cell = '';
      if (ch === '\n') rows.push([]);
    } else cell += ch;
  }
  rows.at(-1).push(cell.replace(/\r$/, ''));
  const index = rows[0].findIndex((v) => /^Length(?:\s|$)/.test(v));
  return index < 0 ? [] : rows.slice(1).filter((r) => r.length > 1).map((r) => Number(r[index]));
}
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.001;
const finish = async (s, tasks, checks, notes = []) => ({ tasks, checks, notes, evidence: [await s.shot('result')] });


export { check, field, wall, selectWall, inspector, typeScope, newType, layer, applyLayers, body, near, finish };
