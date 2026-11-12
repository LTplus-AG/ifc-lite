/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Firefox counterpart of lna-socket-probe.mjs (#9523): a page on https://<host>:<frontPort> opens
// ws://127.0.0.1:<bridgePort>/ under several pref sets. <host> resolves to loopback through
// network.dns.localDomains; network.lna.address_space.public.override marks the front public.
// Usage: node ff-socket-probe.mjs <repo> <host> <frontPort> <bridgePort> <outDir>
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [repo, host, frontPort, bridgePort, out] = process.argv.slice(2);
const { firefox } = createRequire(`${repo}/package.json`)('@playwright/test');
const pageUrl = `https://${host}:${frontPort}/__probe/probe.html`;
const base = { 'network.dns.localDomains': host };
const pub = { 'network.lna.address_space.public.override': `127.0.0.1:${frontPort}` };
const lnaOn = { 'network.lna.enabled': true, 'network.lna.blocking': true, 'network.lna.websocket.enabled': true };
const strict = { 'browser.contentblocking.category': 'strict' };
/** A profile whose permissions.sqlite already allows `types` for the front's origin (what "Allow" stores). */
function grantedProfile(types) {
  const dir = mkdtempSync(join(tmpdir(), 'ff-lna-'));
  const origin = `https://${host}:${frontPort}`;
  const rows = types.map((t, i) => `(${i + 1}, '${origin}', '${t}', 1, 0, 0, ${Date.now()})`).join(',');
  execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE moz_perms (id INTEGER PRIMARY KEY,origin TEXT,type TEXT,permission INTEGER,expireType INTEGER,expireTime INTEGER,modificationTime INTEGER)')
c.execute('INSERT INTO moz_perms VALUES ' + sys.argv[2]); c.execute('PRAGMA user_version = 12'); c.commit()`, join(dir, 'permissions.sqlite'), rows]);
  return dir;
}
const PREF_SETS = [
  ['defaults, front loopback', {}],
  ['defaults, front marked public', pub],
  ['ETP strict, front marked public', { ...pub, ...strict }],
  ['LNA prefs forced on, front marked public', { ...pub, ...lnaOn }],
  ['LNA prefs forced on, front loopback', lnaOn],
  ['defaults, front marked public, prompt timeout 3 s', { ...pub, 'network.lna.prompt.timeout': 3000 }],
  ['defaults, front marked public, profile allows loopback-network', pub, ['loopback-network']],
  ['defaults, front marked public, profile allows local-network', pub, ['local-network']],
];
const report = { pageUrl, runs: [] };
for (const [label, prefs, granted] of PREF_SETS) {
  let browser, context;
  if (granted) {
    context = await firefox.launchPersistentContext(grantedProfile(granted), { headless: true, ignoreHTTPSErrors: true, firefoxUserPrefs: { ...base, ...prefs } });
    browser = { version: () => context.browser()?.version() ?? report.firefoxVersion, close: () => context.close() };
  } else {
    browser = await firefox.launch({ headless: true, firefoxUserPrefs: { ...base, ...prefs } });
    context = await browser.newContext({ ignoreHTTPSErrors: true });
  }
  report.firefoxVersion = browser.version();
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text().slice(0, 400)}`));
  let run;
  try {
    await page.goto(pageUrl);
    const permissionsBefore = await page.evaluate(() => globalThis.queryPermissions());
    const socket = await page.evaluate(([p]) => globalThis.probeSocket(p, 8000), [Number(bridgePort)]);
    const permissionsAfter = await page.evaluate(() => globalThis.queryPermissions());
    run = { label, prefs, isSecureContext: await page.evaluate(() => isSecureContext), permissionsBefore, socket, permissionsAfter, console: consoleLines };
  } catch (err) { run = { label, prefs, error: String(err), console: consoleLines }; }
  console.log(JSON.stringify(run));
  report.runs.push(run);
  await browser.close();
}
writeFileSync(`${out}/ff-socket-probe.json`, JSON.stringify(report, null, 2));
