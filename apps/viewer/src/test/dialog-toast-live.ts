/* SPDX-License-Identifier: MPL-2.0 */
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import type { Page } from 'playwright-core';
import type * as Fixture from './dialog-toast-live.fixture';

export type FixtureWindow = Window & { DialogToastFixture: typeof Fixture };
let bundle: Promise<string> | undefined;

/** Bundle the real React components for the browser; no server or product mocks. */
export function liveDialogBundle(): Promise<string> {
  return bundle ??= (async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      configFile: false, root, logLevel: 'silent',
      resolve: { alias: { '@': `${root}/src` } },
      define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': JSON.stringify('production') },
      build: { write: false, minify: false,
        lib: { entry: fileURLToPath(new URL('./dialog-toast-live.fixture.tsx', import.meta.url)),
          formats: ['iife'], name: 'DialogToastFixture' } },
    });
    const chunks = (Array.isArray(result) ? result : [result]).flatMap(item => 'output' in item ? item.output : []);
    const entry = chunks.find(item => item.type === 'chunk' && item.isEntry);
    if (!entry || entry.type !== 'chunk') throw new Error('Missing live dialog fixture bundle');
    return entry.code;
  })();
}

export async function paintDialog(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
