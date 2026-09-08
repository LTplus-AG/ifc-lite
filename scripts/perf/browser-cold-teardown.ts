/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Browser, BrowserContext } from '@playwright/test';

/** #4116: Playwright's close() can hang indefinitely — observed on both arms
 * of two independent large-fixture (1.26 GB) experiments — when the underlying
 * browser process does not exit cleanly. `await x.close().catch(...)` only
 * handles a *rejection*; an unresolved promise is neither resolved nor
 * rejected, so a hang there blocked the whole harness forever with no
 * diagnosis. Race close() against a deadline instead: on timeout, report it
 * as a loud, named failure and move on, rather than waiting indefinitely.
 * (Playwright's public `Browser`/`BrowserContext` API exposes no handle to
 * the underlying OS process from `chromium.launch()`, so this cannot also
 * force-kill it; the harness's own final `process.exit()` still terminates
 * the run itself even if a stuck browser process is left behind.) */

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not resolve within ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Returns null on a clean close, or a message describing why it was not clean. */
export async function closeContextWithTimeout(context: BrowserContext | undefined, timeoutMs: number): Promise<string | null> {
  if (!context) return null;
  try {
    await raceWithTimeout(context.close(), timeoutMs, 'context.close()');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Returns null on a clean close, or a message describing why it was not clean. */
export async function closeBrowserWithTimeout(browser: Browser | undefined, timeoutMs: number): Promise<string | null> {
  if (!browser) return null;
  try {
    await raceWithTimeout(browser.close(), timeoutMs, 'browser.close()');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
