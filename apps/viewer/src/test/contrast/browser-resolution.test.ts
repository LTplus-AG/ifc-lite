/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Contrast-harness browser resolution. Hosts without Google Chrome failed
 * every harness suite with "Chromium distribution 'chrome' is not found" and
 * read as a regression of whatever change was under test; CI must still fail
 * that way rather than go green by skipping.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRAST_BROWSER_MISSING,
  contrastLaunchOptions,
  contrastSkipReason,
  isCi,
  resolveContrastBrowser,
  systemChromePaths,
  type ResolutionInput,
} from './browser-resolution';

const LINUX_CHROME = '/opt/google/chrome/chrome';
const BUNDLED = '/home/u/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const CUSTOM = '/opt/chrome-for-testing/chrome';

function resolve(present: string[], env: ResolutionInput['env'] = {}, bundled: string | undefined = BUNDLED) {
  return resolveContrastBrowser({ env, platform: 'linux', isPresent: (p) => present.includes(p), bundledChromiumPath: () => bundled });
}

describe('contrast browser resolution order', () => {
  it('IFCLITE_TEST_CHROME_EXECUTABLE wins over system Chrome and bundled Chromium', () => {
    const browser = resolve([LINUX_CHROME, BUNDLED, CUSTOM], { IFCLITE_TEST_CHROME_EXECUTABLE: CUSTOM });
    assert.deepEqual(browser, { source: 'env', executablePath: CUSTOM });
    assert.deepEqual(contrastLaunchOptions(browser), { executablePath: CUSTOM });
  });

  it('an explicit path that does not exist is still used, so the launch fails instead of switching browsers', () => {
    const browser = resolve([LINUX_CHROME, BUNDLED], { IFCLITE_TEST_CHROME_EXECUTABLE: CUSTOM });
    assert.deepEqual(browser, { source: 'env', executablePath: CUSTOM });
    assert.equal(contrastSkipReason(browser, {}), false);
  });

  it('an empty IFCLITE_TEST_CHROME_EXECUTABLE counts as unset', () => {
    assert.equal(resolve([LINUX_CHROME], { IFCLITE_TEST_CHROME_EXECUTABLE: '' }).source, 'system-chrome');
  });

  it('system Chrome comes before bundled Chromium and launches through the chrome channel, as CI does', () => {
    const browser = resolve([LINUX_CHROME, BUNDLED]);
    assert.deepEqual(browser, { source: 'system-chrome' });
    assert.deepEqual(contrastLaunchOptions(browser), { channel: 'chrome' });
  });

  it('bundled Chromium is used only when it is already on disk', () => {
    const installed = resolve([BUNDLED]);
    assert.deepEqual(installed, { source: 'bundled-chromium', executablePath: BUNDLED });
    assert.deepEqual(contrastLaunchOptions(installed), { executablePath: BUNDLED });
    assert.equal(resolve([]).source, 'missing');
    assert.equal(resolve([], {}, undefined).source, 'missing');
  });

  it('CI never switches to bundled Chromium: with no Chrome it stays on the chrome channel and fails', () => {
    for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
      const browser = resolve([BUNDLED], env);
      assert.equal(browser.source, 'missing');
      assert.deepEqual(contrastLaunchOptions(browser), { channel: 'chrome' });
      assert.equal(contrastSkipReason(browser, env), false);
    }
  });

  it('asks playwright-core for the bundled path only when nothing earlier matched', () => {
    const bundledChromiumPath = () => { throw new Error('Browser is not supported on current platform'); };
    const isPresent = (p: string) => p === LINUX_CHROME;
    assert.equal(resolveContrastBrowser({ env: {}, platform: 'linux', isPresent, bundledChromiumPath }).source, 'system-chrome');
    assert.equal(resolveContrastBrowser({ env: { IFCLITE_TEST_CHROME_EXECUTABLE: CUSTOM }, platform: 'linux', isPresent, bundledChromiumPath }).source, 'env');
  });
});

describe('contrast browser missing: CI fails, local skips', () => {
  const missing = resolve([]);

  it('outside CI the suites are skipped with one line naming every way to provide a browser', () => {
    const reason = contrastSkipReason(missing, {});
    assert.equal(reason, CONTRAST_BROWSER_MISSING);
    assert.ok(!CONTRAST_BROWSER_MISSING.includes('\n'));
    for (const remedy of ['Google Chrome', 'playwright install chromium', 'IFCLITE_TEST_CHROME_EXECUTABLE', 'CI fails']) {
      assert.ok(CONTRAST_BROWSER_MISSING.includes(remedy), remedy);
    }
  });

  for (const env of [{ CI: 'true' }, { CI: '1' }, { GITHUB_ACTIONS: 'true' }, { CI: 'false', GITHUB_ACTIONS: 'true' }]) {
    it(`under ${JSON.stringify(env)} nothing is skipped and the launch is the chrome channel, which fails as before`, () => {
      assert.equal(contrastSkipReason(missing, env), false);
      assert.deepEqual(contrastLaunchOptions(missing), { channel: 'chrome' });
    });
  }

  for (const env of [{ CI: '' }, { CI: '0' }, { CI: 'false' }]) {
    it(`under ${JSON.stringify(env)} it is a local run and skips`, () => {
      assert.equal(contrastSkipReason(missing, env), CONTRAST_BROWSER_MISSING);
    });
  }

  it('a found browser is never skipped, in or out of CI', () => {
    for (const env of [{}, { CI: 'true' }]) {
      for (const present of [[LINUX_CHROME], [BUNDLED]]) assert.equal(contrastSkipReason(resolve(present), env), false);
    }
  });
});

describe('the skip reason is the one the CI gate and the run summary count', () => {
  it('starts with the marker in scripts/lib/contrast-skips.mjs', async () => {
    // Plain .mjs outside the viewer: a computed specifier keeps it out of the typed module graph.
    const lib = new URL('../../../../../scripts/lib/contrast-skips.mjs', import.meta.url).href;
    // Caught so that, with the module reverted, this assertion goes red instead of the load failing.
    const skips: { CONTRAST_SKIP_MARKER: string } | null = await import(lib).catch(() => null);
    assert.ok(skips, 'scripts/lib/contrast-skips.mjs exists');
    assert.ok(CONTRAST_BROWSER_MISSING.startsWith(skips.CONTRAST_SKIP_MARKER), CONTRAST_BROWSER_MISSING);
  });
});

describe('system Chrome locations match the chrome channel', () => {
  it('uses the fixed Linux and macOS paths and every Windows install prefix', () => {
    assert.deepEqual(systemChromePaths('linux', {}), [LINUX_CHROME]);
    assert.deepEqual(systemChromePaths('darwin', {}), ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
    assert.deepEqual(systemChromePaths('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', HOMEDRIVE: 'C:' }), [
      'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]);
    assert.deepEqual(systemChromePaths('freebsd', {}), []);
  });

  it("agrees with playwright-core's own chrome-channel lookup on this host", async (t) => {
    // Internal module, held in a variable so it types as any: this test exists
    // to notice when a Playwright upgrade moves the table copied above.
    const internal = 'playwright-core/lib/coreBundle';
    const { registry } = await import(internal);
    const found: string | undefined = registry.registry.findExecutable('chrome').executablePath('javascript');
    if (!found) {
      // CI without the override runs the harness on the chrome channel, so it must find Chrome there.
      assert.ok(!isCi(process.env) || !!process.env.IFCLITE_TEST_CHROME_EXECUTABLE, 'CI with no override must have Google Chrome');
      t.skip('no Google Chrome on this host, so there is no channel answer to compare against');
      return;
    }
    assert.ok(systemChromePaths(process.platform, process.env).includes(found), found);
  });
});
