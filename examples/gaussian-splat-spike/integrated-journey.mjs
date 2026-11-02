/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567 integrated-viewer journey for record-integrated.mjs: canonical picker load,
// auto-frame, zoom, orbit, centre clipping, then inspect / hide / remove when the
// build offers those controls. A missing control is recorded as a skip, never faked.
// Options: { collapseSidebar, inspect, remove } via --journey-options.
const removeLabel = name => `Remove model ${name}`;

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
  if (ctx.options.inspect) {
    await ctx.step('inspect', 'Inspect the loaded capture', async () => {
      await page.getByRole('button', { name: /Expand sidebar|Show sidebar/ }).first().click().catch(() => {});
      await ctx.hold(3500);
    });
  } else ctx.skip('inspect', 'not requested for this build');
  const remove = page.getByRole('button', { name: removeLabel(ctx.asset) });
  if (ctx.options.remove && await remove.isVisible().catch(() => false)) {
    await ctx.step('remove', 'Remove frees the capture', async () => {
      await remove.click();
      const confirm = page.getByRole('button', { name: /^Remove/ }).last();
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      await remove.waitFor({ state: 'detached', timeout: 30_000 });
      await ctx.hold(2500);
    });
  } else {
    ctx.skip('remove', ctx.options.remove ? 'build shows no remove control for this model' : 'not requested for this build');
    await ctx.step('orbit2', 'Orbit', () => ctx.drag([c[0] + 120, c[1] + 40], [c[0] - 120, c[1] + 40], 4000));
  }
  await ctx.step('end', '', () => ctx.hold(1500));
}
