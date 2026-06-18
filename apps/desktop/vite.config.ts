/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vite';

// Standard Tauri + Vite setup. Tauri controls the dev server port via
// tauri.conf.json (`devUrl`), so we pin it here and keep the screen unmanaged
// so Tauri's CLI output stays visible.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 3001,
    strictPort: true,
  },
  // Tauri uses a fixed target; don't transpile away modern features it supports.
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
});
