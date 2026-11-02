/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567 integrated-viewer journey for record-integrated.mjs: canonical picker load,
// auto-frame, zoom, orbit, centre clipping, then the capture row's inspect, hide/show,
// fit and remove when the build offers them. A missing control is recorded as a
// skip, never faked. Options: { collapseSidebar, inspect, visibility, remove }.

export async function prepare(ctx) {
  const { page } = ctx;
  await page.waitForSelector('#file-input-open', { state: 'attached', timeout: 120_000 });
  // First-run privacy notice: acknowledged through its own button, as a user would.
  const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
  await dismiss.waitFor({ state: 'visible', timeout: 10_000 }).then(() => dismiss.click(), () => {});
  if (ctx.options.collapseSidebar) await page.getByRole('button', { name: 'Collapse sidebar to icons' }).click().catch(() => {});
  await page.waitForTimeout(1500);
}

export async function journey(ctx) {
  const { page } = ctx;
  await ctx.step('intro', 'ifc-lite viewer · internal Gaussian build', () => ctx.hold(2000));
  await ctx.step('load', 'File picker → canonical useIfcLoader.loadFile', async () => {
    await ctx.uploadToInput('#file-input-open');
    await page.waitForFunction(() => /Complete/.test(document.body.innerText), undefined, { timeout: 300_000, polling: 100 });
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
      await row('Show capture details').click(); await ctx.hold(5000);
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
      await ctx.hold(2500);
    });
  } else await ctx.step('orbit2', 'Orbit', () => ctx.drag([c[0] + 120, c[1] + 40], [c[0] - 120, c[1] + 40], 4000));
  await ctx.step('end', '', () => ctx.hold(1500));
}
