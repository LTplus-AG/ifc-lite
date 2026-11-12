/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { closeContrastBrowser, warmContrastBrowser, withThemedPage } from '@/test/contrast/render-harness.js';
import { Toaster, toast } from '@/components/ui/toast';
import { ExportChangesReviewDialog } from './ExportChangesReviewDialog';

before(warmContrastBrowser);
after(closeContrastBrowser);
afterEach(() => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss notification"]')) {
    act(() => button.click());
  }
  cleanup();
});

for (const variant of ['fixed', 'absolute'] as const) {
  it(`#9849 ${variant} action toasts cannot intercept review Export or the modal scrim`, async () => {
    render(<>
      <Toaster variant={variant} />
      <ExportChangesReviewDialog open onOpenChange={() => {}} groups={[
        { modelId: 'm', modelName: 'Blank.ifc', entities: [], unitemizedCount: 2 },
      ]} totalCount={2} isExporting={false} onConfirm={() => {}} />
    </>);
    act(() => {
      toast.success('Level 3 added at +7.00 m', { label: 'Draw on', onClick: () => {} });
      toast.success('Level 3 deleted', { label: 'Undo', onClick: () => {} });
    });
    // Lay out the mounted production markup with the compiled app stylesheet.
    // Happy DOM alone cannot observe stacking or pointer interception.
    await withThemedPage('light', document.body.innerHTML, async (page) => {
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
      const button = page.getByRole('dialog').getByRole('button', { name: /^Export/ }).last();
      await button.waitFor({ state: 'visible' });
      const bounds = await button.boundingBox();
      assert.ok(bounds);
      // Guarantee overlap rather than rely on particular review row counts.
      // Only position changes: the toast keeps its production stacking rules.
      await page.getByRole('status').evaluate((region, point) => {
        const stack = region.parentElement!;
        stack.style.left = `${point.x}px`;
        stack.style.top = `${point.y}px`;
        stack.style.bottom = 'auto';
        stack.style.right = 'auto';
      }, bounds);
      await button.click({ timeout: 2000 });
      const exportReceivesPointer = await button.evaluate((element) => {
        const r = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      });
      assert.equal(exportReceivesPointer, true, 'Export must receive the pointer through overlapping toasts');
      // Outside the panel, the modal scrim must also intercept toast actions.
      await page.getByRole('status').evaluate((region) => {
        region.parentElement!.style.left = '0';
        region.parentElement!.style.top = '0';
      });
      const action = page.getByRole('button', { name: 'Draw on', exact: true });
      const actionIsCovered = () => action.evaluate((element) => {
        const r = element.getBoundingClientRect();
        return !element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      });
      assert.equal(await actionIsCovered(), true, 'modal scrim must cover toast actions');
      // Radix portals overlay then content into the same portal wrapper.
      await page.getByRole('dialog').evaluate((dialog) => {
        dialog.previousElementSibling?.remove();
        dialog.remove();
      });
      assert.equal(await actionIsCovered(), false, 'toast actions remain available after the modal closes');
      await action.click({ timeout: 2000 });
    });
  });
}
