/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567 integrated-viewer journey for record-integrated.mjs: canonical picker load,
// auto-frame, zoom, orbit, centre clipping, then the capture row's inspect, hide/show,
// fit and remove when the build offers them. A missing control is recorded as a
// skip, never faked; a requested action that fails ends the take instead of
// reading as success. Options: { collapseSidebar, inspect, visibility, remove }.
const CAPTURE_ROW = '[data-testid="capture-model-row"]';
const CAPTURE_DETAILS = '[data-testid="gaussian-capture-metadata"]';

export async function prepare(ctx) {
  const { page } = ctx;
  await page.waitForSelector('#file-input-open', { state: 'attached', timeout: 120_000 });
  // First-run privacy notice: acknowledged through its own button, as a user would.
  const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
  await dismiss.waitFor({ state: 'visible', timeout: 10_000 }).then(() => dismiss.click(), () => {});
  // A requested collapse must happen: an open sidebar measurably slows camera motion.
  if (ctx.options.collapseSidebar) await page.getByRole('button', { name: 'Collapse sidebar to icons' }).click({ timeout: 10_000 });
  await page.waitForTimeout(1500);
}

export async function journey(ctx) {
  const { page } = ctx;
  await ctx.step('intro', 'ifc-lite viewer · internal Gaussian build', () => ctx.hold(2000));
  await ctx.step('load', 'File picker → canonical useIfcLoader.loadFile', async () => {
    await ctx.uploadToInput('#file-input-open');
    // Durable ready state: the capture's own model row. The "Complete" phase text is transient.
    await page.locator(CAPTURE_ROW).waitFor({ state: 'visible', timeout: 300_000 });
    ctx.observe('loadedRow', (await page.locator(CAPTURE_ROW).innerText()).replace(/\s+/g, ' ').trim());
  });
  // The viewport canvas mounts with the first model.
  const box = await page.locator('canvas:visible').first().boundingBox();
  const c = [box.x + box.width / 2, box.y + box.height / 2];
  await ctx.step('fit', 'Auto-framed on splat centres', () => ctx.hold(2500));
  await ctx.step('zoom', 'Zoom', () => ctx.wheel(c, -700, 2600));
  await ctx.step('orbit', 'Orbit', () => ctx.drag([c[0] - 300, c[1] + 40], [c[0] + 300, c[1] + 40], 6500));
  await ctx.step('section', 'Section tool: centre clipping (internal demo)', async () => {
    await page.click('[data-tour="tool-section"]'); await ctx.hold(1200);
    await page.getByRole('button', { name: 'Side (X)' }).click(); await ctx.hold(1500);
    const step = name => page.getByRole('button', { name });
    for (let i = 0; i < 14; i++) { await step('Move the plane back by one step').click(); await ctx.hold(170); }
    await ctx.hold(1500);
    for (let i = 0; i < 26; i++) { await step('Move the plane forward by one step').click(); await ctx.hold(170); }
    await ctx.hold(1500);
  });
  await ctx.step('restore', 'Cut off: full capture restored', async () => {
    await page.getByRole('button', { name: /^Cut$/ }).click();
    await ctx.hold(1200);
    await page.getByRole('button', { name: 'Close' }).first().click();
    await ctx.hold(800);
  });
  const row = name => page.getByRole('button', { name, exact: true });
  const offered = async (option, label) => {
    if (!ctx.options[option]) { ctx.skip(option, 'not requested for this build'); return false; }
    if (await row(label).isVisible().catch(() => false)) return true;
    ctx.skip(option, `build shows no "${label}" control`); return false;
  };
  if (await offered('inspect', 'Show capture details')) {
    await ctx.step('inspect', 'Inspect: capture details (uncalibrated, explicit placement)', async () => {
      await row('Show capture details').click();
      // An open sidebar slows camera motion in this build, so it opens only to inspect.
      const expand = row('Expand sidebar');
      const collapsed = await expand.isVisible().catch(() => false);
      if (collapsed) await expand.click();
      const details = page.locator(CAPTURE_DETAILS);
      await details.waitFor({ state: 'visible', timeout: 10_000 });
      const text = (await details.innerText()).replace(/\s+/g, ' ').trim();
      ctx.observe('captureDetails', text);
      for (const expected of ['Resident', 'Uncalibrated', ...(ctx.options.explicitPlacement ? ['Explicitly supplied placement'] : [])]) {
        if (!text.includes(expected)) throw new Error(`capture details panel lacks "${expected}"`);
      }
      await ctx.hold(5000);
      if (collapsed) { await row('Collapse sidebar to icons').click(); await ctx.hold(600); }
    });
  }
  if (await offered('visibility', 'Hide capture')) {
    await ctx.step('visibility', 'Hide and show from the model list', async () => {
      await row('Hide capture').click(); await ctx.hold(1400);
      await row('Show capture').click(); await ctx.hold(1400);
      await row('Fit capture in view').click(); await ctx.hold(2200);
    });
  }
  if (await offered('remove', 'Remove capture')) {
    await ctx.step('remove', 'Remove capture from the model list', async () => {
      await row('Remove capture').click();
      // A confirmation, if the build asks for one, is answered inside its own dialog.
      const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
      if (await dialog.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) {
        await dialog.getByRole('button', { name: /^Remove/ }).click();
      }
      await row('Remove capture').waitFor({ state: 'detached', timeout: 30_000 });
      await page.locator(CAPTURE_ROW).waitFor({ state: 'detached', timeout: 30_000 });
      ctx.observe('afterRemoveCaptureRows', await page.locator(CAPTURE_ROW).count());
      await ctx.hold(2500);
    });
  } else await ctx.step('orbit2', 'Orbit', () => ctx.drag([c[0] + 120, c[1] + 40], [c[0] - 120, c[1] + 40], 4000));
  await ctx.step('end', '', () => ctx.hold(1500));
}
