// SPDX-License-Identifier: MPL-2.0
// Page lifecycle helpers for the retained browser comparison (scripts/retained-compare/browser.mjs).

// This API includes nested Workers when available. It does not isolate the
// SMLib linear heap; report that limitation rather than inventing a figure.
export const measureMemory = page => page.evaluate(async () => {
  if (!performance.measureUserAgentSpecificMemory) return { bytes: null, reason: 'measureUserAgentSpecificMemory unavailable' };
  try {
    const measurement = await performance.measureUserAgentSpecificMemory();
    const sdk = measurement.breakdown.filter(entry =>
      entry.attribution.some(owner => owner.url?.includes('/smlib/')));
    return { bytes: measurement.bytes, smlibWorkerBytes: sdk.length ? sdk.reduce((sum, entry) => sum + entry.bytes, 0) : null,
      smlibAttribution: sdk.length ? 'Browser-attributed Worker memory, not isolated SDK linear heap' : 'No separate SDK attribution supplied' };
  }
  catch (error) { return { bytes: null, reason: String(error) }; }
});

/** Corpus mode runs each model in a fresh page: WASM linear memory never
 * shrinks, so one page accumulates every model's heap until the renderer is
 * killed. A crashed page is returned as `{ error }`, never thrown, so one model
 * cannot abort the corpus; the page is always closed. */
export async function runModelInFreshPage(browser, setupPage, model, pageErrors) {
  let page;
  try {
    page = await browser.newPage();
    await setupPage(page);
    const result = await page.evaluate(model => window.harness.runModel(model), model);
    const browserMemory = await measureMemory(page);
    await page.evaluate(() => window.harness.dispose());
    return { result, browserMemory };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await page?.close().catch(error => pageErrors.push(String(error)));
  }
}

/** Corpus-mode browser memory: the largest per-model fresh-page measurement. */
export function corpusBrowserMemory(models) {
  const bytes = models.filter(m => !m.crashed).map(m => m.browserMemory?.bytes).filter(Number.isFinite);
  return { bytes: bytes.length ? Math.max(...bytes) : null, basis: 'max over per-model fresh pages (corpus mode)' };
}
