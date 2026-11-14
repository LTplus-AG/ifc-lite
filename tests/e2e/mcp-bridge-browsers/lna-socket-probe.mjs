/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Chromium Local Network Access probe for #9523, without the viewer: a page on https://<host>:<frontPort>
// opens ws://127.0.0.1:<bridgePort>/ under several permission states, once with the front treated as
// loopback (no override: the control) and once marked public with --ip-address-space-overrides.
// Usage: node lna-socket-probe.mjs <repo> <host> <frontPort> <bridgePort> <outDir>
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const [repo, host, frontPort, bridgePort, out] = process.argv.slice(2);
const { chromium } = createRequire(`${repo}/package.json`)('@playwright/test');
const origin = `https://${host}:${frontPort}`;
const pageUrl = `${origin}/__probe/probe.html`;
const base = ['--ignore-certificate-errors', `--host-resolver-rules=MAP ${host} 127.0.0.1`];
const report = { pageUrl, bridgePort: Number(bridgePort), runs: [] };

async function scenario(browser, label, setup) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text().slice(0, 400)}`));
  const cdp = await browser.newBrowserCDPSession();
  // Permissions are per browser context: find this page's context id.
  const { targetInfo } = await (await context.newCDPSession(page)).send('Target.getTargetInfo');
  // Chromium refusing a permission name is what the scenario observes, so it is recorded, not a failure.
  if (setup) {
    try { await setup(cdp, targetInfo.browserContextId); } catch (err) {
      report.runs.push({ label, setupRefused: err.message });
      await context.close();
      return;
    }
  }
  await page.goto(pageUrl);
  const permissionsBefore = await page.evaluate(() => globalThis.queryPermissions());
  const socket = await page.evaluate(([p]) => globalThis.probeSocket(p, 8000), [Number(bridgePort)]);
  if (!socket || typeof socket !== 'object') throw new Error(`${label}: probeSocket returned no result: ${JSON.stringify(socket)}`);
  const permissionsAfter = await page.evaluate(() => globalThis.queryPermissions());
  const run = { label, permissionsBefore, socket, permissionsAfter, console: consoleLines };
  console.log(JSON.stringify(run));
  report.runs.push(run);
  await context.close();
}

const setPermission = (name, setting) => async (cdp, browserContextId) => {
  await cdp.send('Browser.setPermission', { origin, permission: { name }, setting, browserContextId });
};
const grant = (types) => async (cdp, browserContextId) => {
  await cdp.send('Browser.grantPermissions', { origin, permissions: types, browserContextId });
};

// A page or probe failure (no socket result) fails the run; the report is still written.
try {
  for (const [mode, extra] of [['control: front is loopback (no override)', []],
    ['front marked public', [`--ip-address-space-overrides=127.0.0.1:${frontPort}=public`]]]) {
    const browser = await chromium.launch({ channel: 'chromium', headless: true, args: [...base, ...extra] });
    report.chromeVersion = browser.version();
    console.log(`== ${mode} (Chromium ${browser.version()})`);
    await scenario(browser, `${mode}: default`);
    if (extra.length) {
      for (const name of ['loopback-network', 'local-network', 'local-network-access']) {
        await scenario(browser, `${mode}: setPermission ${name}=granted`, setPermission(name, 'granted'));
      }
      for (const type of ['loopbackNetwork', 'localNetworkAccess', 'localNetwork']) {
        await scenario(browser, `${mode}: grantPermissions [${type}]`, grant([type]));
      }
      await scenario(browser, `${mode}: setPermission loopback-network=denied`, setPermission('loopback-network', 'denied'));
    }
    await browser.close();
  }
} catch (err) {
  report.error = String(err?.stack ?? err);
  console.error(`lna-socket-probe: ${report.error}`);
}
writeFileSync(`${out}/lna-socket-probe.json`, JSON.stringify(report, null, 2));
if (report.error) process.exit(1);
