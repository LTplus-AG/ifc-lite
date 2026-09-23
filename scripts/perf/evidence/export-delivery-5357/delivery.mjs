// SPDX-License-Identifier: MPL-2.0
// #5357 portable replay. Historical observer/settings are retained in delivery-original.mjs.txt.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'browser-executable': { type: 'string' },
  output: { type: 'string' },
  'wasm-url': { type: 'string' },
} });
if (!values.output) throw new Error('Usage: node delivery.mjs --output <new.json> [--browser-executable <Chrome>] [--wasm-url <URL>]');
const output = resolve(values.output);
if (existsSync(output)) throw new Error(`Refusing to overwrite ${output}`);
mkdirSync(dirname(output), { recursive: true });
const url = values['wasm-url'] ?? readFileSync(new URL('./wasm-url.txt', import.meta.url), 'utf8').trim();
const browser = await chromium.launch({
  executablePath: values['browser-executable'], headless: true, chromiumSandbox: true,
});
try {
  const page = await browser.newPage();
  await page.goto(new URL('/', url).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const result = await page.evaluate(async wasmUrl => {
    const start = performance.now();
    const response = await fetch(wasmUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`WASM fetch: HTTP ${response.status}`);
    const headers = Object.fromEntries(response.headers);
    const copy = response.clone();
    const compiled = await WebAssembly.compileStreaming(response);
    const elapsed = performance.now() - start;
    const bytes = await copy.arrayBuffer();
    return { url: wasmUrl, status: response.status, headers, decodedBytes: bytes.byteLength,
      fetch_compile_ms: elapsed, exports: WebAssembly.Module.exports(compiled).length,
      resources: performance.getEntriesByName(wasmUrl).map(r => r.toJSON()), userAgent: navigator.userAgent,
      chromiumSandbox: true,
      caveat: 'Single delivery/compile observation; not a completed model-load benchmark or an A/B comparison.' };
  }, url);
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(result.decodedBytes, result.fetch_compile_ms);
} finally {
  await browser.close();
}
