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
 *  3. Outside CI only: Playwright's bundled Chromium, if `playwright install
 *     chromium` already put it on disk. Nothing is downloaded here. CI never
 *     switches binaries, so its measurements always come from the Chrome channel.
 *
 * With none of them: in CI the launch is still `channel: 'chrome'`, so it fails
 * exactly as before and a lane can never go green by skipping. Outside CI the
 * browser tests are skipped with {@link CONTRAST_BROWSER_MISSING}.
 */

import { win32 } from 'node:path';

// The repo's CI rule for detect-and-skip guards. Plain .mjs outside the viewer:
// a computed specifier keeps it out of the typed module graph.
const hostPreconditions = new URL('../../../../../scripts/lib/host-preconditions.mjs', import.meta.url).href;
const { isCI }: { isCI: (env: Record<string, string | undefined>) => boolean } = await import(hostPreconditions);

export type ContrastBrowser =
  | { source: 'env'; executablePath: string }
  | { source: 'system-chrome' }
  | { source: 'bundled-chromium'; executablePath: string }
  | { source: 'missing' };

export interface ResolutionInput {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** Executable by this user: the check the chrome channel makes. */
  isExecutable: (path: string) => boolean;
  /** `chromium.executablePath()` from playwright-core, called only when needed
   *  (it throws on a platform Playwright ships no Chromium for). */
  bundledChromiumPath: () => string | undefined;
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
      const paths = prefixes.filter((p): p is string => !!p).map((p) => win32.join(p, 'Google\\Chrome\\Application\\chrome.exe'));
      return [...new Set(paths)];
    }
    default:
      return [];
  }
}

/** The repo's `isCI` (`CI` set to anything but empty, `0` or `false`), or
 *  GitHub Actions, which always sets `CI` but is named here so an override of
 *  `CI` alone cannot turn an Actions job into a local run. */
export function isCi(env: ResolutionInput['env']): boolean {
  return isCI(env) || env.GITHUB_ACTIONS === 'true';
}

export function resolveContrastBrowser({ env, platform, isExecutable, bundledChromiumPath }: ResolutionInput): ContrastBrowser {
  const explicit = env.IFCLITE_TEST_CHROME_EXECUTABLE;
  if (explicit) return { source: 'env', executablePath: explicit };
  if (systemChromePaths(platform, env).some(isExecutable)) return { source: 'system-chrome' };
  if (isCi(env)) return { source: 'missing' };
  const bundled = bundledChromiumPath();
  return bundled && isExecutable(bundled) ? { source: 'bundled-chromium', executablePath: bundled } : { source: 'missing' };
}

/** The `skip` option for every browser-dependent test: the reason when the
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
