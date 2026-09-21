/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome walkthrough for #5123: load a model, open the IDS panel, load
// an IDS whose audit reports errors (IDS_FILE env, default the bundled sample),
// check the Run button is enabled with the run-anyway hint, run validation and
// confirm a report renders with the audit issues still listed.
//   IDS_FILE=<path> node tests/e2e/ids-audit-gate.manual.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-ids-audit-gate');
mkdirSync(OUT, { recursive: true });
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5311';
const IDS_FILE = process.env.IDS_FILE ?? join(process.cwd(), 'apps/viewer/public/samples/building-architecture.ids');
const log = (...a) => console.log('[walk]', ...a);
const findings = [];
const note = (s) => { findings.push(s); log('FINDING:', s); };

const browser = await chromium.launch({
  headless: false, channel: 'chrome',
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let step = 0;
const shot = async (name) => { step += 1; const p = `${OUT}/${String(step).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: p }); log('shot', p); };
const state = (expr) => page.evaluate(({ k, e }) => new Function('s', `return (${e});`)(globalThis[k].getState()), { k: STORE, e: expr });

await page.goto(`${BASE}/?model=/samples/building-architecture.ifc`);
await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 60000 });
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return s.models.size > 0 && !s.loading && (s.geometryResult?.meshes?.length ?? 0) > 0; }, STORE, { timeout: 120000 });
await page.waitForTimeout(2000);

await page.evaluate((k) => globalThis[k].getState().setIdsPanelVisible(true), STORE);
await page.waitForTimeout(800);
await shot('ids-panel-empty');

const input = page.locator('input[type="file"][accept=".ids,.xml"]');
await input.setInputFiles(IDS_FILE);
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return !!s.idsDocument && !s.idsAuditing && !!s.idsAuditReport; }, STORE, { timeout: 60000 });
await page.waitForTimeout(500);
const audit = await state('({ status: s.idsAuditReport.status, errors: s.idsAuditReport.issues.filter(i => i.severity === "error").length, total: s.idsAuditReport.issues.length, specs: s.idsDocument.specifications.length })');
log('audit', audit);
await shot('ids-loaded-with-audit');

const run = page.getByRole('button', { name: /Run Validation/ });
const disabled = await run.isDisabled();
log('run button disabled =', disabled);
if (disabled) note('Run Validation is disabled although the document parsed');
const hint = await page.getByText(/Validation runs anyway/).count();
log('run-anyway hint count', hint);
if (audit.errors > 0 && hint !== 1) note(`expected the run-anyway hint with ${audit.errors} errors, found ${hint}`);
if (audit.errors === 0 && hint !== 0) note('run-anyway hint shown without audit errors');
if (audit.errors > 0) {
  const text = await page.getByText(/Validation runs anyway/).textContent();
  log('hint text', JSON.stringify(text));
  if (!text.includes(`found ${audit.errors.toLocaleString('en')} error`)) note(`hint count does not match audit error count: ${text}`);
}

await run.click();
await page.waitForFunction((k) => !!globalThis[k].getState().idsValidationReport, STORE, { timeout: 180000 });
await page.waitForTimeout(1000);
const report = await state('({ specs: s.idsValidationReport.summary.totalSpecifications, passed: s.idsValidationReport.summary.passedSpecifications, checked: s.idsValidationReport.summary.totalEntitiesChecked, err: s.idsError })');
log('report', report);
if (report.err) note(`idsError after validation: ${JSON.stringify(report.err)}`);
await shot('ids-report');
// The counts strip renders the number and the label in separate spans.
const strip = await page.locator('body').innerText();
if (audit.errors > 0 && !new RegExp(`${audit.errors}\\s+errors?`).test(strip)) note('audit counts strip not visible on the results view');
else log('audit counts strip still listed on the results view');

log('page errors', errors.length, errors.slice(0, 5));
writeFileSync(join(OUT, 'findings.txt'), [`audit=${JSON.stringify(audit)}`, `report=${JSON.stringify(report)}`, ...findings, ...errors.map((e) => `console: ${e}`)].join('\n'));
log('findings', findings.length, 'out', OUT);
await browser.close();
