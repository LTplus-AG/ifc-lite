/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shared fail-closed render acceptance for #8743 / #8564 witnesses.
export function browserClean(log) {
  return Boolean(log && log.pageErrors?.length === 0 && log.consoleErrors?.length === 0);
}

export function renderClean({ browserLog, errors, diagnostics }, exactReports = []) {
  return browserClean(browserLog) && errors?.length === 0
    && diagnostics?.renderErrors === 0 && diagnostics?.gpuErrors === 0
    && exactReports.every(report => report && report.fallback === null
      && (report.composition === 'nearest-glass-split' || report.status === 'layers-covered'));
}

// Real browser negative control: this must fail even with clean GPU diagnostics.
export async function consoleErrorSelfCheck(browser, openPage) {
  const { context, page, log } = await openPage(browser);
  try {
    const run = { browserLog: log, errors: [], diagnostics: { renderErrors: 0, gpuErrors: 0 } };
    if (!renderClean(run)) throw new Error('negative control did not start clean');
    const message = page.waitForEvent('console', { predicate: m => m.type() === 'error' });
    await page.evaluate(() => console.error('injected #8743 witness negative control'));
    await message;
    if (renderClean(run)) throw new Error('console.error escaped clean-render predicate');
    // Silent status failures must also fail, independently of browser errors.
    const clean = { ...run, browserLog: { pageErrors: [], consoleErrors: [] } };
    for (const report of [{ status: 'failed', fallback: null },
      { composition: 'split-failed', fallback: 'split-failed' },
      { status: 'coverage-pending', fallback: null },
      { composition: 'over-transparent-approximate', fallback: 'pipelines-compiling' }]) {
      if (renderClean(clean, [report])) throw new Error('non-exact report escaped predicate');
    }
    return { pass: true, injectedConsoleErrors: log.consoleErrors, silentFailuresRejected: 4 };
  } finally { await context.close(); }
}
