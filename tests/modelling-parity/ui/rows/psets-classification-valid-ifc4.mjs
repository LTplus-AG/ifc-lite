/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { selectWall } from '../lib/authoring-helpers.mjs';
import { classificationOf } from '../lib/measured-oracles.mjs';
import { wallPropertySets, wallQuantityCoverage } from '../lib/oracles.mjs';
import { downloadCount, nextDownload, task } from '../lib/driver.mjs';

import { readStep } from '../lib/step.mjs';

import { setupRoom } from '../lib/probe-helpers.mjs';

export default {
    id: 'ui.export-ifc4',
    capability: 'psets-classification-valid-ifc4',
    title: 'File > IFC export as IFC4 with base quantities and property sets',
    async run(s) {
      const tasks = [await setupRoom(s)];
      let selectedWall;
      tasks.push(await task(s, 'Properties: add Uniclass classification to the south wall', async () => {
        await selectWall(s);
        selectedWall = await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId);
        await s.ui.click(s.page.locator('[data-model-inspector]').getByRole('button', { name: 'Properties', exact: true }));
        await s.ui.click(s.page.getByRole('button', { name: 'Add classification', exact: true }));
        const dialog = s.page.getByRole('dialog');
        await s.ui.click(dialog.getByLabel('Classification System', { exact: true }));
        await s.ui.click(s.page.getByRole('option', { name: /Uniclass 2015/ }));
        await s.ui.click(dialog.getByLabel('Identification Code', { exact: true }));
        await s.ui.type('EF_25_10');
        await s.ui.click(dialog.getByLabel('Name (optional)', { exact: true }));
        await s.ui.type('Walls');
        await s.ui.click(dialog.getByRole('button', { name: 'Add Classification', exact: true }));
      }));
      let reviewText = null;
      tasks.push(await task(s, 'inspect the actual Review changes dialog in plain language', async () => {
        await s.harness.dismissToasts();
        await s.ui.click(s.page.getByRole('tab', { name: 'File' }));
        await s.ui.click(s.page.getByRole('button', { name: /Export modified IFC/ }).first());
        const review = s.page.getByRole('dialog');
        await review.waitFor({ timeout: 8000 });
        reviewText = await review.innerText();
        await s.ui.key('Escape');
        await review.waitFor({ state: 'hidden', timeout: 5000 });
      }));
      let dl = null;
      tasks.push(await task(s, 'File > Export IFC, schema IFC4, Export', async () => {
        const { page } = s;
        const before = await downloadCount(page);
        await s.ui.click(page.getByRole('tab', { name: 'File' }));
        await s.ui.click(page.locator('[data-export-command="ifc"]'));
        const dialog = page.getByRole('dialog');
        await dialog.waitFor({ timeout: 8000 });
        await s.ui.click(dialog.getByRole('combobox').nth(1));
        await s.ui.click(page.getByRole('option', { name: /^IFC4( \(current\))?$/ }));
        await s.ui.click(dialog.getByRole('button', { name: /^Export$/ }).last());
        dl = await nextDownload(page, before);
      }));
      const step = dl ? readStep(dl.text) : null;
      const q = step ? wallQuantityCoverage(step) : [];
      const psets = step ? wallPropertySets(step) : [];
      const classified = step ? classificationOf(step, selectedWall) : false;
      return {
        tasks, notes: [], evidence: [],
        exportText: dl?.text ?? null,
        checks: [
          { name: 'download is IFC4', ok: step?.schema === 'IFC4', detail: `${dl?.name ?? 'no download'} schema ${step?.schema}` },
          { name: '4 walls in the file', ok: (step?.count('IFCWALL') ?? 0) === 4, detail: `${step?.count('IFCWALL')}` },
          { name: 'base quantities on walls', ok: q.length === 4 && q.every((values) => Number.isFinite(values.Length) && Number.isFinite(values.NetVolume)), detail: JSON.stringify(q) },
          { name: 'a property set on the walls', ok: psets.length === 4 && psets.every((names) => names.length > 0), detail: JSON.stringify(psets) },
          { name: 'export review uses plain language', ok: reviewText !== null && !/#\d+\s*=\s*IFC/i.test(reviewText), detail: reviewText?.slice(0,500) ?? 'no review dialog' },
          { name: 'classification reference present', ok: classified, detail: classified ? 'yes' : 'No classification relationship to the selected wall was exported' },
        ],
      };
    },
  };
