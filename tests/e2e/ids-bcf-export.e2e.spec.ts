/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { readFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBCF } from '../../packages/bcf/src/index.js';
import type { RuleSetFile } from '@ifc-lite/rules';
import { startViewerDevServer, type ViewerDevServer } from './viewer-dev-server';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL = join(ROOT, 'tests/models/ara3d/AC20-FZK-Haus.ifc');
let server: ViewerDevServer | undefined;
let url: string;
test.beforeAll(async () => {
  if (process.env.IDS_BCF_VIEWER_URL) url = process.env.IDS_BCF_VIEWER_URL;
  else { server = await startViewerDevServer('ids-bcf-export'); url = server.url; }
});
test.afterAll(async () => { await server?.close(); });

test('#7974 actual validation exports cameras and snapshots for physical and spatial failures', async ({ page }, info) => {
  test.skip(!existsSync(MODEL), 'Real Archicad fixture absent; run pnpm fixtures ara3d/AC20-FZK-Haus.ifc');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(url);
  const loaded = page.waitForEvent('console', { predicate: message => message.text().includes('[ifc-lite] Added model AC20-FZK-Haus.ifc'), timeout: 120000 });
  await page.locator('#file-input-add').setInputFiles(MODEL);
  await loaded;
  const file: RuleSetFile = { version: 1, name: '7974 BCF viewpoints', rules: ['IfcWallStandardCase', 'IfcBuilding'].map((type, index) => ({
    id: `bcf-7974-${index}`, name: type,
    applicability: { authoredAs: 'chips', groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: [type] }] }] },
    requirement: { kind: 'element', block: { authoredAs: 'chips', groups: [{ combinator: 'AND', rules: [{ kind: 'name', op: 'contains', value: 'NONEXISTENT-7974' }] }] } },
  })) };
  await page.evaluate(file => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setValidationRuleSetDraft(file);
    state.setValidationRuleSetEditing(true);
    state.showWorkspacePanel('validation');
    state.setSidebarActivePanel('validation');
  }, file);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().idsValidationReport?.specificationResults.length === 2);
  const failures = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().idsValidationReport!.specificationResults.map(spec => ({
    count: spec.entityResults.filter(entity => !entity.passed).length,
  })));
  expect(failures.map(spec => spec.count)).toEqual([expect.any(Number), expect.any(Number)]);
  for (const spec of failures) expect(spec.count).toBeGreaterThan(0);
  await page.getByRole('button', { name: /choose.*format/i }).click();
  await page.getByRole('menuitem', { name: /BCF/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('#grouping')).toContainText(/specification/i);
  await expect(dialog.locator('#include-camera')).toBeChecked();
  await dialog.locator('#include-snapshots').click();
  const downloaded = page.waitForEvent('download', { timeout: 120000 });
  await dialog.getByRole('button', { name: 'Export BCF', exact: true }).click();
  const download = await downloaded;
  const path = info.outputPath('7974-validation.bcfzip');
  await download.saveAs(path);
  const bytes = await readFile(path);
  const project = await readBCF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  expect(project.topics.size).toBe(2);
  for (const topic of project.topics.values()) {
    expect(topic.viewpoints.length).toBeGreaterThan(0);
    const viewpoint = topic.viewpoints[0]!;
    expect(viewpoint.perspectiveCamera ?? viewpoint.orthogonalCamera, topic.title).toBeTruthy();
    expect(viewpoint.components?.selection?.length, topic.title).toBeGreaterThan(0);
    expect(viewpoint.snapshotData?.length, topic.title).toBeGreaterThan(1000);
  }
  await page.screenshot({ path: info.outputPath('7974-validation-export.png') });
  if (process.env.IDS_BCF_EVIDENCE_DIR) {
    await copyFile(path, join(process.env.IDS_BCF_EVIDENCE_DIR, 'ifc7974-corrected.bcfzip'));
    await page.screenshot({ path: join(process.env.IDS_BCF_EVIDENCE_DIR, 'ifc7974-validation-export.png') });
  }
});
