/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import path from 'node:path';
import type { PluginOption, InlineConfig } from 'vite';

export function endpointConfig(sourceRoot: string, endpointRoot: string, outputRoot: string,
  wasmPlugin: () => PluginOption, topLevelAwaitPlugin: () => PluginOption): InlineConfig {
  for (const value of [sourceRoot, endpointRoot, outputRoot]) {
    if (!path.isAbsolute(value)) throw new Error('absolute qualified roots required');
  }
  return {
    configFile: false, root: endpointRoot, publicDir: false,
    plugins: [wasmPlugin(), topLevelAwaitPlugin()],
    resolve: { alias: [
      { find: '@ifc-lite/wasm', replacement: path.join(sourceRoot, 'packages/wasm/pkg/ifc-lite.js') },
      ...['geometry', 'data', 'encoding', 'wasm-lifecycle'].map(name => ({
        find: `@ifc-lite/${name}`, replacement: path.join(sourceRoot, `packages/${name}/src`),
      })),
    ] },
    build: { target: 'esnext', outDir: outputRoot, emptyOutDir: false,
      rollupOptions: { external: ['@tauri-apps/api/event'] } },
    worker: { format: 'es', plugins: () => [wasmPlugin(), topLevelAwaitPlugin()] },
  };
}
