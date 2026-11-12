/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which browser the contrast harness (`render-harness.ts`) launches, and what
 * happens when there is none.
 *
 * Order, first match wins:
 *  1. `IFCLITE_TEST_CHROME_EXECUTABLE`, used as given. A wrong path fails at
 *     launch; it never falls through, because the caller asked for that binary.
 *  2. System Google Chrome, launched as `channel: 'chrome'` (what CI uses).
 *  3. Playwright's bundled Chromium, if `playwright install chromium` already
 *     put it on disk. Nothing is downloaded here.
 *
 * With none of them: in CI the launch is still `channel: 'chrome'`, so it fails
 * exactly as before and a lane can never go green by skipping. Outside CI the
 * browser tests are skipped with {@link CONTRAST_BROWSER_MISSING}.
 */

import { win32 } from 'node:path';

export type ContrastBrowser =
  | { source: 'env'; executablePath: string }
  | { source: 'system-chrome'; executablePath: string }
  | { source: 'bundled-chromium'; executablePath: string }
  | { source: 'missing' };

export interface ResolutionInput {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
  /** `chromium.executablePath()` from playwright-core: where the bundled
   *  Chromium lives once installed, whether or not it is installed. */
  bundledChromiumPath: string | undefined;
}

export const CONTRAST_BROWSER_MISSING =
  'contrast harness: no Chromium found, browser tests skipped (CI fails instead). Provide one: install Google Chrome, '
  + 'run `pnpm exec playwright install chromium`, or set IFCLITE_TEST_CHROME_EXECUTABLE to a Chromium binary.';

/** Where `channel: 'chrome'` looks, copied from playwright-core 1.64's
 *  registry (`_createChromiumChannel("chrome", ...)`) so "present" here means
 *  what that channel would find. */
export function systemChromePaths(platform: NodeJS.Platform, env: ResolutionInput['env']): string[] {
  switch (platform) {
    case 'linux':
      return ['/opt/google/chrome/chrome'];
    case 'darwin':
      return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
    case 'win32': {
      const prefixes = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']];
      if (env.HOMEDRIVE) prefixes.push(`${env.HOMEDRIVE}\\Program Files`, `${env.HOMEDRIVE}\\Program Files (x86)`);
      return prefixes.filter((p): p is string => !!p).map((p) => win32.join(p, 'Google\\Chrome\\Application\\chrome.exe'));
    }
    default:
      return [];
  }
}

/** Any non-empty `CI`, or GitHub Actions. Errs toward CI: a false "CI" fails
 *  as before, a false "local" would let a lane skip. */
export function isCi(env: ResolutionInput['env']): boolean {
  return !!env.CI || env.GITHUB_ACTIONS === 'true';
}

export function resolveContrastBrowser({ env, platform, exists, bundledChromiumPath }: ResolutionInput): ContrastBrowser {
  const explicit = env.IFCLITE_TEST_CHROME_EXECUTABLE;
  if (explicit) return { source: 'env', executablePath: explicit };
  const chrome = systemChromePaths(platform, env).find(exists);
  if (chrome) return { source: 'system-chrome', executablePath: chrome };
  if (bundledChromiumPath && exists(bundledChromiumPath)) {
    return { source: 'bundled-chromium', executablePath: bundledChromiumPath };
  }
  return { source: 'missing' };
}

/** The `skip` option for every browser-dependent suite: the reason when the
 *  browser is missing outside CI, otherwise `false` (run, and fail if absent). */
export function contrastSkipReason(browser: ContrastBrowser, env: ResolutionInput['env']): string | false {
  return browser.source === 'missing' && !isCi(env) ? CONTRAST_BROWSER_MISSING : false;
}

/** Launch options for `chromium.launch`. System Chrome and "missing" both go
 *  through `channel: 'chrome'`, so CI launches exactly as it always has and a
 *  missing browser fails with Playwright's own error. */
export function contrastLaunchOptions(browser: ContrastBrowser): { channel: 'chrome' } | { executablePath: string } {
  return browser.source === 'env' || browser.source === 'bundled-chromium'
    ? { executablePath: browser.executablePath }
    : { channel: 'chrome' };
}
