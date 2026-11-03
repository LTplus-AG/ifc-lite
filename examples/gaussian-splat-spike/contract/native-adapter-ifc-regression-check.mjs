/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 IFC-only regression runner for validate-native-adapter.mjs
// --ifc-regression=<base checkout>: the same page renders through the base and
// the head renderer sources (one Vite server per checkout, each aliasing its own
// renderer/spatial/load-trace) and every frame must match pixel-exactly.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const spike = fileURLToPath(new URL('..', import.meta.url));

async function renderWith(root, allow, browser, openPage) {
  const server = await createServer({
    root: spike, configFile: false, logLevel: 'warn',
    resolve: { alias: {
      'ifc-lite-renderer-under-test': resolve(root, 'packages/renderer/src/index.ts'),
      '@ifc-lite/spatial': resolve(root, 'packages/spatial/src/index.ts'),
      '@ifc-lite/load-trace': resolve(root, 'packages/load-trace/src/index.ts'),
    } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, fs: { allow } },
  });
  await server.listen();
  const { context, page, log } = await openPage(browser);
  try {
    await page.goto(`${server.resolvedUrls.local[0]}contract/native-adapter-ifc-regression.html`);
    await page.waitForFunction(() => Boolean(window.ifcRegression), undefined, { timeout: 120000 });
    const outcome = await page.evaluate(() => window.ifcRegression);
    if (outcome.error) throw new Error(`IFC regression page failed for ${root}: ${outcome.error}`);
    return { ...outcome.result, browserLog: log };
  } finally {
    await context.close();
    await server.close();
  }
}

export async function runIfcRegression({ browser, openPage, output, backend, stamp, repo, baseRoot }) {
  const baseCommit = execFileSync('git', ['-C', baseRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const allow = [repo, baseRoot];
  const runs = { base: await renderWith(baseRoot, allow, browser, openPage), head: await renderWith(repo, allow, browser, openPage) };
  const checks = [], frames = {};
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), ...(pass ? {} : { detail }) });
  for (const name of Object.keys(runs.head.frames)) {
    const [a, b] = [runs.base.frames[name], runs.head.frames[name]];
    const pixelsA = Buffer.from(a.rgba, 'base64'), pixelsB = Buffer.from(b.rgba, 'base64');
    let changed = 0;
    for (let i = 0; i < pixelsA.length; i += 4) if (pixelsA.compare(pixelsB, i, i + 4, i, i + 4) !== 0) changed++;
    const files = {};
    for (const [label, frame] of [['base', a], ['head', b]]) {
      files[label] = `native-adapter-ifc-regression-${backend}-${stamp}-${label}-${name}.png`;
      await writeFile(resolve(output, files[label]), Buffer.from(frame.png, 'base64'));
    }
    frames[name] = { size: [b.width, b.height], baseSha256: a.sha256, headSha256: b.sha256, changedPixels: changed, stable: [a.stable, b.stable], files };
    check(`ifc regression: ${name} identical at base and head`, a.width === b.width && a.height === b.height && changed === 0 && a.sha256 === b.sha256, frames[name]);
    check(`ifc regression: ${name} captures stable`, a.stable && b.stable, frames[name].stable);
  }
  check('ifc regression: selection highlight changes the frame (sensitivity)', frames.selectedBatched.headSha256 !== frames.plain.headSha256
    && frames.selectedAuthored.headSha256 !== frames.plain.headSha256, frames);
  check('ifc regression: authored mesh drawn and frames repeatable', frames.plainAgain.headSha256 === frames.plain.headSha256, frames);
  check('ifc regression: transparent cases change the frame (sensitivity)', ['glassPartial', 'selectedGlass', 'xray', 'orthographic']
    .every(name => frames[name] && frames[name].headSha256 !== frames.plain.headSha256), frames);
  for (const [label, run] of Object.entries(runs)) {
    check(`ifc regression: ${label} renderer clean`, run.errors.length === 0 && run.diagnostics.gpuErrors === 0 && run.diagnostics.renderErrors === 0,
      { errors: run.errors, diagnostics: run.diagnostics });
    check(`ifc regression: ${label} browser clean`, run.browserLog.pageErrors.length === 0 && run.browserLog.consoleErrors.length === 0, run.browserLog);
  }
  const failed = checks.filter(c => !c.pass);
  return {
    status: failed.length ? 'fail' : 'pass', baseCommit, headCommit: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    adapterInfo: runs.head.adapterInfo, frames, verdict: { pass: failed.length === 0, total: checks.length, failed },
    checks: checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}`),
    note: 'IFC-only: the page imports no Gaussian API. Base renderer sources are served from a detached worktree with this checkout\'s node_modules.',
  };
}
