/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The viewer's original `manualChunks` function, unchanged. */
export function legacyManualChunk(id: string): string | undefined {
  // Assistant text edits need ChangeSet, not the lazy CodeMirror editor UI.
  // Keep state separate so sharing it cannot pull the whole editor into startup.
  if (id.includes('/node_modules/@codemirror/state/')) return 'codemirror-state';
  if (id.includes('/packages/sandbox/')) return 'sandbox';
  if (id.includes('/packages/export/')) return 'exporters';
  if (id.includes('/packages/server-client/')) return 'server-client';
  if (id.includes('/packages/bcf-api/')) return 'bcf-api';
  if (id.includes('/packages/bcf/')) return 'bcf';
  if (id.includes('/packages/ids/')) return 'ids';
  if (id.includes('/packages/lens/')) return 'lens';
  if (id.includes('/packages/drawing-2d/')) return 'drawing-2d';
  if (id.includes('/node_modules/jszip/')) return 'zip';
  if (id.includes('/node_modules/apache-arrow/')) return 'arrow';
  if (id.includes('/node_modules/parquet-wasm/')) return 'parquet';
  if (id.includes('/node_modules/cesium/')) return 'cesium';
  // ECharts (+ zrender) and the dashboard grid: reached only through the lazy Charts panel (#3944).
  if (id.includes('/node_modules/echarts/') || id.includes('/node_modules/zrender/')) return 'echarts';
  if (id.includes('/node_modules/react-grid-layout/')) return 'grid-layout';
  // @radix-ui/@floating-ui run synchronous, top-level module-init
  // code (e.g. react-tooltip's `createPopperScope()` at module
  // scope). The default chunker otherwise merges them into whatever
  // chunk also touches @/store, and the store transitively pulls in
  // WASM modules that use real top-level await — vite-plugin-top-level-await
  // then wraps that WHOLE merged chunk's body in a deferred
  // `.then()`, so the synchronous radix init runs late. A sibling
  // chunk that imports the same merged chunk but has no async taint
  // of its own evaluates synchronously and calls into the
  // not-yet-populated binding — "C is not a function" at module
  // scope (issue #2243). Keep radix/floating-ui in their own chunk,
  // clear of the store's async taint, so their module-init always
  // finishes before anything can import from them.
  if (id.includes('/node_modules/@radix-ui/') || id.includes('/node_modules/@floating-ui/')) return 'radix-ui';
  // three.js + addons — only the /mcp landing imports them, keep
  // the main viewer / pages off the hook.
  if (id.includes('/node_modules/three/') || id.includes('/node_modules/.pnpm/three@')) return 'three';
  return undefined;
}
