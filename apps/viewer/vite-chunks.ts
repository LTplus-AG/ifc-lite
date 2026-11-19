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

/**
 * The QuickJS runtime core, claimed before the recursive `sandbox` group can
 * pull it in (#9200). Eager code imports a little of the sandbox
 * (`SandboxAbortError`, the bridge schema), so the `sandbox` chunk is eager.
 * The sandbox reaches `quickjs-emscripten-core`, whose index statically
 * imports the ~50 KB runtime file; the recursive group put that file in the
 * eager chunk although only a script run uses it. The index stays with the
 * sandbox (eager code reaches it); the rest of the package and its FFI types
 * load with the first script run.
 */
export const quickjsRuntimeChunkGroup = {
  name: 'quickjs-runtime',
  priority: 50,
  includeDependenciesRecursively: false,
  test: /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:quickjs-emscripten-core\/dist\/(?!index\.mjs$)[^/]+\.mjs$|@jitl\/quickjs-ffi-types\/)/,
};

/**
 * Vite's dynamic-import preload helper, claimed so it does not land in
 * whichever vendor chunk reaches it first. It did: the hosted entry
 * (`main-hosted.tsx`), whose only dynamic import is the viewer itself, pulled
 * the 3 MB `exporters` chunk in statically just for this helper, which held
 * back the configuration request it exists to start early.
 */
export const preloadHelperChunkGroup = {
  name: 'preload-helper',
  priority: 50,
  includeDependenciesRecursively: false,
  test: /vite\/preload-helper/,
};

/**
 * Agent operation modules (lazy, `lib/agent-tools/operations/generated/loaders.ts`)
 * import a handful of eager drawing and ingest helpers. Left alone, Rolldown
 * splits each such helper out of its eager chunk into its own chunk, and every
 * chunk adds a name to the entry's dynamic-import preload map plus its own
 * import/export glue (#10587). This allowlist keeps them in one eager chunk.
 * The lazy groups below are allowlists too: a group claims a module however it
 * is imported, so a broad pattern would merge `import()` boundaries (pdf.js)
 * into every chunk that shares the group.
 */
export const drawingSharedChunkGroup = {
  name: 'drawing-shared',
  priority: 40,
  includeDependenciesRecursively: false,
  test: /\/apps\/viewer\/src\/(?:hooks\/(?:useDxfUnderlay|dxfUnderlayWorldLines|dxfUnderlayMath|dxfExportGeoref|pdfSectionLayout)|hooks\/ingest\/(?:dxfIngest|pointCloudScanCache)|lib\/drawing\/(?:element-tags|drawing-runtime)|lib\/drawing2d-markup\/dimension-graphics|components\/viewer\/tools\/(?:computePolygonArea|formatDistance)|services\/coordination-loader|lib\/renderer\/line-overlay-rte|lib\/geo\/(?:use-projection-kind|useAnchorGeoreference))\.ts$/,
};

/**
 * Small lazy leaves the Drawing and Appearance panels share with agent
 * operations. An explicit allowlist of modules with no `import()` and no vendor
 * dependency, so grouping them cannot move a deferred boundary (#10587).
 */
export const drawingLeavesChunkGroup = {
  name: 'drawing-leaves',
  priority: 40,
  includeDependenciesRecursively: false,
  test: /\/apps\/viewer\/src\/(?:lib\/drawing\/(?:center-dxf|dxf-text-layout)|hooks\/dxfDrawingBounds|lib\/appearance\/(?:references\/drawing|face-masks|settings))\.ts$/,
};

/**
 * Lazy appearance workflows (capture, scan, transfer, preview, reference edit)
 * that the Appearance panels and agent operations both import. Same rule as
 * above: an explicit list of modules with no `import()` and no vendor
 * dependency. `calibration` and `appearance-native-pdf` stay out because they
 * defer pdf.js (#10587).
 */
export const appearanceWorkflowsChunkGroup = {
  name: 'appearance-workflows',
  priority: 40,
  includeDependenciesRecursively: false,
  test: /\/apps\/viewer\/src\/(?:lib\/appearance\/(?:appearance-native-(?:preview|scan|scan-sources|capture|transfer)|raster-payload|baked-images|create-captured-mesh|snapshot|prepare-native-preview|pdf\/page-preview|capture\/(?:region|source)|scan\/(?:landmarks|point-source|geometry-proof|session-source|session|transfer-frame|prepare-transfer))|components\/viewer\/appearance\/scan-validation-message)\.ts$/,
};
