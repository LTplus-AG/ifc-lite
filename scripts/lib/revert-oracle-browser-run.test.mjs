/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The spawning half of the browser observer without a browser (#7029):
 * `runBrowserPlan` against a root whose `playwright` package is a stand-in
 * that records the environment it was started with. What is under test is the
 * observer's own plumbing -- here, the private preview port it reserves and
 * hands to Playwright as `PLAYWRIGHT_PORT`. The real-Chrome, whole-dispatcher
 * cases are revert-oracle-browser-observer.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBrowserPlan } from './revert-oracle-browser-run.mjs';

/**
 * A root with `node_modules/playwright` whose bin writes the `PLAYWRIGHT_PORT`
 * it received next to itself. `--version` (which the observer also asks for)
 * carries no port and writes nothing.
 */
function rootWithRecordingPlaywright() {
  const root = mkdtempSync(join(tmpdir(), 'oracle-browser-run-'));
  const pkg = join(root, 'node_modules', 'playwright');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'playwright', version: '0.0.0', bin: { playwright: 'cli.cjs' } }));
  writeFileSync(
    join(pkg, 'cli.cjs'),
    "const { writeFileSync } = require('node:fs');\n" +
      "const { join } = require('node:path');\n" +
      "if (process.env.PLAYWRIGHT_PORT !== undefined) writeFileSync(join(__dirname, 'port.txt'), process.env.PLAYWRIGHT_PORT);\n",
  );
  return { root, portFile: join(pkg, 'port.txt') };
}

const PLAN = {
  file: 'tests/e2e/target.e2e.spec.mjs',
  runner: { family: 'playwright', bin: 'playwright', args: ['test', '--project=probe-ci'], build: null },
};

/** Run `fn` with `name` set to `value` in this process's environment, then put it back. */
function withEnv(name, value, fn) {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

for (const forceColor of ['3', '1', '0']) {
  test(`#7029: Playwright is handed a numeric preview port with FORCE_COLOR=${forceColor} in the inherited environment`, (t) => {
    const { root, portFile } = rootWithRecordingPlaywright();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    // FORCE_COLOR is set by the test, not taken from the developer's shell: a
    // child that prints the port with console.log(<number>) colours it
    // (`\x1b[33m59117\x1b[39m`), and the observer then cannot read it back.
    const result = withEnv('FORCE_COLOR', forceColor, () => runBrowserPlan(PLAN, root, 'probe', () => {}));

    const evidence = (result.evidence ?? []).join('\n');
    assert.doesNotMatch(evidence, /could not reserve a preview port/, 'the port reservation failed');
    assert.equal(existsSync(portFile), true, `Playwright was never started with a port. Evidence:\n${evidence}`);
    const handed = readFileSync(portFile, 'utf8');
    // What the stand-in was handed, read back from the file it recorded it in:
    // it must round-trip through an integer unchanged (no escapes, no prefix).
    const port = Number.parseInt(handed, 10);
    assert.equal(String(port), handed, `PLAYWRIGHT_PORT is not a plain number: ${JSON.stringify(handed)}`);
    assert.equal(port > 0 && port < 65536, true, `PLAYWRIGHT_PORT out of range: ${port}`);
  });
}
