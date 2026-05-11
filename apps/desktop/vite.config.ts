import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

// Read version from root package.json
const rootPkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')
);

// https://vitejs.dev/config/
// Tauri expects a fixed port, fail if that port is not available
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __RELEASE_HISTORY__: JSON.stringify([]),
  },
  resolve: {
    alias: {
      // Point to viewer's source for shared components
      '@': path.resolve(__dirname, '../viewer/src'),
      '@ifc-lite/parser': path.resolve(__dirname, '../../packages/parser/src'),
      '@ifc-lite/geometry': path.resolve(__dirname, '../../packages/geometry/src'),
      '@ifc-lite/renderer': path.resolve(__dirname, '../../packages/renderer/src'),
      '@ifc-lite/query': path.resolve(__dirname, '../../packages/query/src'),
      '@ifc-lite/spatial': path.resolve(__dirname, '../../packages/spatial/src'),
      '@ifc-lite/data': path.resolve(__dirname, '../../packages/data/src'),
      '@ifc-lite/export': path.resolve(__dirname, '../../packages/export/src'),
      '@ifc-lite/cache': path.resolve(__dirname, '../../packages/cache/src'),
      '@ifc-lite/ifcx': path.resolve(__dirname, '../../packages/ifcx/src'),
      '@ifc-lite/wasm': path.resolve(__dirname, '../../packages/wasm/pkg/ifc-lite.js'),
      '@ifc-lite/sdk': path.resolve(__dirname, '../../packages/sdk/src'),
      '@ifc-lite/lens': path.resolve(__dirname, '../../packages/lens/src'),
      '@ifc-lite/mutations': path.resolve(__dirname, '../../packages/mutations/src'),
      '@ifc-lite/bcf': path.resolve(__dirname, '../../packages/bcf/src'),
      '@ifc-lite/drawing-2d': path.resolve(__dirname, '../../packages/drawing-2d/src'),
      '@ifc-lite/encoding': path.resolve(__dirname, '../../packages/encoding/src'),
      '@ifc-lite/ids': path.resolve(__dirname, '../../packages/ids/src'),
      '@ifc-lite/lists': path.resolve(__dirname, '../../packages/lists/src'),
      '@ifc-lite/server-client': path.resolve(__dirname, '../../packages/server-client/src'),
      '@ifc-lite/sandbox/schema': path.resolve(__dirname, '../../packages/sandbox/src/bridge-schema.ts'),
      '@ifc-lite/sandbox': path.resolve(__dirname, '../../packages/sandbox/src'),
      '@ifc-lite/create': path.resolve(__dirname, '../../packages/create/src'),
      '@ifc-lite/embed-protocol': path.resolve(__dirname, '../../packages/embed-protocol/src'),
      '@ifc-lite/embed-sdk': path.resolve(__dirname, '../../packages/embed-sdk/src'),
      // The MCP playground (rendered at /mcp/playground in the shared App)
      // imports the browser-safe MCP entry. Subpath alias must come first.
      '@ifc-lite/mcp/browser': path.resolve(__dirname, '../../packages/mcp/src/browser.ts'),
      '@ifc-lite/mcp': path.resolve(__dirname, '../../packages/mcp/src'),
      // Tauri API stubs: the shared viewer uses dynamic imports for native file
      // dialogs. In the real Tauri shell these resolve to @tauri-apps packages;
      // in the monorepo CI build (where those packages are absent) we point to
      // lightweight stubs that return null / throw at runtime.
      '@tauri-apps/api/core': path.resolve(__dirname, '../viewer/src/services/tauri-core-stub.ts'),
      '@tauri-apps/plugin-dialog': path.resolve(__dirname, '../viewer/src/services/tauri-dialog-stub.ts'),
      '@tauri-apps/plugin-fs': path.resolve(__dirname, '../viewer/src/services/tauri-fs-stub.ts'),
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 3001,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
  // 3. to access the Tauri environment variables set by the CLI with information about the current target
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome113' : 'safari15',
    // don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/packages/sandbox/')) return 'sandbox';
          if (id.includes('/packages/export/')) return 'exporters';
          if (id.includes('/packages/server-client/')) return 'server-client';
          if (id.includes('/packages/bcf/')) return 'bcf';
          if (id.includes('/packages/ids/')) return 'ids';
          if (id.includes('/packages/lens/')) return 'lens';
          if (id.includes('/packages/drawing-2d/')) return 'drawing-2d';
          if (id.includes('/node_modules/jszip/')) return 'zip';
          if (id.includes('/node_modules/apache-arrow/')) return 'arrow';
          if (id.includes('/node_modules/parquet-wasm/')) return 'parquet';
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    exclude: [
      '@duckdb/duckdb-wasm',
      '@ifc-lite/wasm',
      'parquet-wasm',
      'quickjs-emscripten',
      '@jitl/quickjs-wasmfile-release-asyncify',
      'esbuild-wasm',
    ],
  },
  assetsInclude: ['**/*.wasm'],
  worker: {
    format: 'es',
    plugins: () => [
      react(),
      {
        name: 'worker-alias-resolver',
        resolveId(id) {
          if (id.startsWith('@ifc-lite/')) {
            const packageName = id.split('/')[1];
            if (packageName === 'wasm') {
              return path.resolve(__dirname, '../../packages/wasm/pkg/ifc-lite.js');
            }
            return path.resolve(__dirname, `../../packages/${packageName}/src`);
          }
        },
      },
    ],
  },
});
