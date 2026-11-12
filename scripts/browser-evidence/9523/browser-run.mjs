/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #9523 browser evidence with the built viewer on a public-looking https origin (https://<host>:<frontPort>,
// <host> resolved to 127.0.0.1, the front marked public so Local Network Access applies to ws://127.0.0.1).
// Phase A: no permission -> open the pairing link, Connect, record what the tab shows.
// Phase B: permission granted -> Try again / Connect, pair, let the driver run its calls, Disconnect.
// Chromium: A and B in one tab (grant via CDP Browser.setPermission loopback-network between them).
// Firefox: A in a fresh profile (prompt timeout shortened), B in a profile whose permissions.sqlite allows
// loopback-network for the origin (Playwright's Firefox cannot grant it at run time).
// Usage: node browser-run.mjs <repo> <chromium|firefox> <host> <frontPort> <fixture> <dir>
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [repo, which, host, frontPort, fixture, dir] = process.argv.slice(2);
const pw = createRequire(`${repo}/package.json`)('@playwright/test');
const origin = `https://${host}:${frontPort}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { browser: which, origin, phases: {} };
const say = (s) => console.log(`${which}: ${s}`);
const FF_PROMPT_TIMEOUT_MS = 6000;

async function waitFile(name, ms = 120_000) { for (let k = 0; k < ms / 100 && !existsSync(`${dir}/${name}`); k++) await sleep(100); return existsSync(`${dir}/${name}`); }

async function openViewer(page, phase) {
  const consoleLines = [];
  page.on('console', (m) => { if (/agent-bridge|local network|loopback|LNA|WebSocket|ws:\/\/|establish a connection/i.test(m.text())) consoleLines.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  phase.console = consoleLines;
  await page.goto(`${origin}/`);
  phase.isSecureContext = await page.evaluate(() => isSecureContext);
  phase.renderer = await page.evaluate(async () => ({ webgpu: Boolean(await navigator.gpu?.requestAdapter?.()), webgl2: Boolean(document.createElement('canvas').getContext('webgl2')) }));
  await page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__), null, { timeout: 120_000 });
  await page.locator('#file-input-open').setInputFiles(fixture);
  await page.waitForFunction(() => { const s = globalThis.__ifc_lite_viewer_store__.getState(); return s.models.size > 0 && !s.loading
    && [...s.models.values()].every((m) => m.ifcDataStore); }, null, { timeout: 180_000, polling: 250 });
  phase.modelLoaded = true;
  say('model loaded');
}

const permissions = (page) => page.evaluate(async () => {
  const out = {};
  for (const name of ['loopback-network', 'local-network-access', 'local-network']) {
    try { out[name] = (await navigator.permissions.query({ name })).state; } catch (err) { out[name] = `rejects: ${err.name}`; }
  }
  return out;
});

async function openLinkAndDialog(page, phase, shot) {
  await waitFile('pairing-url.txt');
  const link = readFileSync(`${dir}/pairing-url.txt`, 'utf8').trim();
  await page.goto(link);
  await page.locator('[data-agent-bridge-dialog]').waitFor({ timeout: 20_000 });
  phase.addressBarWhileDialogOpen = page.url();
  phase.dialogTarget = await page.locator('[data-agent-bridge-target]').first().textContent();
  phase.dialogText = (await page.locator('[data-agent-bridge-dialog]').innerText()).replace(/[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}/g, '<code>');
  await page.screenshot({ path: `${dir}/${shot}.png` });
}

/** Click Connect (or Try again) and return the outcome: 'connected' or the failure code, with timing. */
async function connect(page, phase, shotPending) {
  phase.permissionsBeforeConnect = await permissions(page);
  const t0 = Date.now();
  await page.locator('[data-agent-bridge-connect]').click();
  if (shotPending) { await sleep(1500); await page.screenshot({ path: `${dir}/${shotPending}.png` });
    phase.pendingAfter1500ms = await page.locator('[data-agent-bridge-dialog] output').count() > 0; }
  const winner = await Promise.race([
    page.locator('[data-agent-bridge-chip="connected"]').waitFor({ timeout: 60_000 }).then(() => 'connected'),
    page.locator('[data-agent-bridge-outcome]').waitFor({ timeout: 60_000 }).then(() => 'outcome'),
  ]).catch((err) => `timeout: ${err.message.split('\n')[0]}`);
  phase.outcomeAfterMs = Date.now() - t0;
  if (winner === 'outcome') {
    await sleep(1500); // the client may relabel 'unreachable' as 'permission-denied' after querying the permission
    phase.outcome = await page.locator('[data-agent-bridge-outcome]').getAttribute('data-agent-bridge-outcome');
    phase.outcomeText = await page.locator('[data-agent-bridge-outcome]').innerText();
  } else phase.outcome = winner;
  phase.permissionsAfterConnect = await permissions(page);
  say(`outcome ${phase.outcome} after ${phase.outcomeAfterMs} ms`);
  return phase.outcome;
}

async function servePairedCalls(page, phase, shot) {
  await waitFile('calls-done', 180_000);
  await sleep(500);
  await page.locator('[data-agent-bridge-chip]').click();
  await page.locator('[data-agent-bridge-disconnect]').first().waitFor({ timeout: 5000 });
  await sleep(400);
  await page.screenshot({ path: `${dir}/${shot}.png` });
  phase.chipText = await page.locator('[data-agent-bridge-chip]').textContent();
  phase.activityRows = await page.locator('[data-agent-bridge-activity]').allTextContents();
  await page.locator('[data-agent-bridge-disconnect]').first().click();
  await sleep(500);
  phase.chipAfterDisconnect = await page.locator('[data-agent-bridge-chip]').count();
}

function ffGrantedProfile(types) {
  const profile = mkdtempSync(join(tmpdir(), 'ff-lna-'));
  const rows = types.map((t, i) => `(${i + 1}, '${origin}', '${t}', 1, 0, 0, ${Date.now()})`).join(',');
  execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE moz_perms (id INTEGER PRIMARY KEY,origin TEXT,type TEXT,permission INTEGER,expireType INTEGER,expireTime INTEGER,modificationTime INTEGER)')
c.execute('INSERT INTO moz_perms VALUES ' + sys.argv[2]); c.execute('PRAGMA user_version = 12'); c.commit()`, join(profile, 'permissions.sqlite'), rows]);
  return profile;
}

const closers = [];
try {
  if (which === 'chromium') {
    const browser = await pw.chromium.launch({ channel: 'chromium', headless: true, args: [
      '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader',
      '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu',
      '--ignore-certificate-errors', `--host-resolver-rules=MAP ${host} 127.0.0.1`,
      `--ip-address-space-overrides=127.0.0.1:${frontPort}=public`] });
    closers.push(() => browser.close());
    report.version = `Chromium ${browser.version()} (Playwright, headless, SwiftShader)`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const A = (report.phases.A = {}); const B = (report.phases.B = {});
    await openViewer(page, A);
    await openLinkAndDialog(page, A, 'chromium-1-dialog');
    await connect(page, A);
    await page.screenshot({ path: `${dir}/chromium-2-blocked.png` });
    // The user's "Allow" (or site settings -> allowed) for this origin, applied to this tab's context.
    const cdp = await browser.newBrowserCDPSession();
    const { targetInfo } = await (await context.newCDPSession(page)).send('Target.getTargetInfo');
    await cdp.send('Browser.setPermission', { origin, permission: { name: 'loopback-network' }, setting: 'granted', browserContextId: targetInfo.browserContextId });
    B.granted = 'CDP Browser.setPermission {name: loopback-network} granted, same tab, then Try again';
    B.buttonLabel = await page.locator('[data-agent-bridge-connect]').innerText();
    if (await connect(page, B) === 'connected') await servePairedCalls(page, B, 'chromium-3-connected');
  } else {
    const prefs = { 'network.dns.localDomains': host, 'network.lna.address_space.public.override': `127.0.0.1:${frontPort}` };
    const A = (report.phases.A = {}); const B = (report.phases.B = {});
    {
      const browser = await pw.firefox.launch({ headless: true, firefoxUserPrefs: { ...prefs, 'network.lna.prompt.timeout': FF_PROMPT_TIMEOUT_MS } });
      closers.push(() => browser.close());
      report.version = `Firefox ${browser.version()} (Playwright build, headless)`;
      A.note = `network.lna.prompt.timeout=${FF_PROMPT_TIMEOUT_MS} (default 300000) so the unanswered prompt ends inside the run`;
      const page = await (await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })).newPage();
      await openViewer(page, A);
      await openLinkAndDialog(page, A, 'firefox-1-dialog');
      await connect(page, A, 'firefox-2-pending-prompt');
      await page.screenshot({ path: `${dir}/firefox-3-after-prompt-timeout.png` });
      await browser.close(); closers.pop();
    }
    {
      const context = await pw.firefox.launchPersistentContext(ffGrantedProfile(['loopback-network']),
        { headless: true, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, firefoxUserPrefs: prefs });
      closers.push(() => context.close());
      B.granted = 'profile permissions.sqlite: loopback-network ALLOW for the origin (what "Allow" + remember stores)';
      const page = context.pages()[0] ?? await context.newPage();
      await openViewer(page, B);
      await openLinkAndDialog(page, B, 'firefox-4-dialog-granted');
      if (await connect(page, B) === 'connected') await servePairedCalls(page, B, 'firefox-5-connected');
    }
  }
} catch (err) {
  report.error = String(err?.stack ?? err);
  say(`error ${report.error}`);
} finally {
  writeFileSync(`${dir}/${which}-report.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${dir}/stop`, '1');
  for (const c of closers.reverse()) await c().catch(() => {});
}
if (report.error) process.exit(1);
