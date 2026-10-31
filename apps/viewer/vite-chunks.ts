/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The viewer's original `manualChunks` function. */
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
  // three.js + addons — only the /mcp landing imports them, keep
  // the main viewer / pages off the hook.
  if (id.includes('/node_modules/three/') || id.includes('/node_modules/.pnpm/three@')) return 'three';
  return undefined;
}

/**
 * tslib's helpers are shared by eager code (Radix's scroll lock) and by lazy
 * vendors (cesium via @swc/helpers, apache-arrow). Left unclaimed, the
 * recursive `legacyManualChunk` group puts tslib in whichever vendor chunk
 * reaches it first, and that whole chunk becomes eager: a react bump that
 * re-resolved Radix onto cesium's tslib copy put all of cesium (~4.9 MB) on the
 * eager path. A higher-priority, non-recursive group claims tslib first, so no
 * vendor rides along with it.
 */
export const tslibChunkGroup = {
  name: 'tslib',
  priority: 50,
  includeDependenciesRecursively: false,
  test: /\/node_modules\/tslib\//,
};
