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

/** A non-recursive group that claims exactly these `apps/viewer/src` modules (`.ts`, no query). */
function allowlistGroup(name: string, modules: readonly string[]) {
  const escaped = modules.map((module) => module.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
  return { name, priority: 40, includeDependenciesRecursively: false, test: new RegExp(`/apps/viewer/src/(?:${escaped.join('|')})\\.ts$`) };
}

/**
 * Agent operation modules (lazy, `lib/agent-tools/operations/generated/loaders.ts`)
 * share small modules with the Drawing and Appearance panels. Left alone,
 * Rolldown gives each shared module its own chunk, and every chunk adds a name
 * to the entry's dynamic-import preload map plus its own import/export glue
 * (#10587). These allowlists keep each family in one chunk.
 *
 * A group claims a module however it is imported, so every member must contain
 * no `import()`, `?worker`/`?url` import or `new URL(...)`: otherwise the group
 * would merge a deferred boundary into every chunk that shares it.
 * src/test/vite-chunks.test.ts checks that each member still exists.
 */
export const drawingSharedModules = [
  // Eager: the Drawing panel's host and DXF/point-cloud ingest.
  'hooks/useDxfUnderlay', 'hooks/dxfUnderlayWorldLines', 'hooks/dxfUnderlayMath', 'hooks/dxfExportGeoref', 'hooks/pdfSectionLayout',
  'hooks/ingest/dxfIngest', 'hooks/ingest/pointCloudScanCache', 'lib/drawing/element-tags', 'lib/drawing/drawing-runtime',
  'lib/drawing2d-markup/dimension-graphics', 'components/viewer/tools/computePolygonArea', 'components/viewer/tools/formatDistance',
  'services/coordination-loader', 'lib/renderer/line-overlay-rte', 'lib/geo/use-projection-kind', 'lib/geo/useAnchorGeoreference',
] as const;
export const drawingSharedChunkGroup = allowlistGroup('drawing-shared', drawingSharedModules);

/** Lazy: small drawing and appearance modules the Drawing panel and operations share. */
export const drawingLeavesModules = [
  'lib/drawing/center-dxf', 'lib/drawing/dxf-text-layout', 'hooks/dxfDrawingBounds',
  'lib/appearance/references/drawing', 'lib/appearance/face-masks', 'lib/appearance/settings',
] as const;
export const drawingLeavesChunkGroup = allowlistGroup('drawing-leaves', drawingLeavesModules);

/**
 * Lazy: capture, scan, transfer and preview workflows the Appearance panel and
 * operations share. The textured-product family stays out because the Drawing
 * panel's reference library imports it, and this group would then ride along.
 */
export const appearanceWorkflowsModules = [
  'lib/appearance/appearance-native-preview', 'lib/appearance/appearance-native-scan', 'lib/appearance/appearance-native-scan-sources',
  'lib/appearance/appearance-native-capture', 'lib/appearance/appearance-native-transfer', 'lib/appearance/raster-payload',
  'lib/appearance/baked-images', 'lib/appearance/create-captured-mesh', 'lib/appearance/snapshot', 'lib/appearance/prepare-native-preview',
  'lib/appearance/pdf/page-preview', 'lib/appearance/capture/region', 'lib/appearance/capture/source', 'lib/appearance/scan/landmarks',
  'lib/appearance/scan/point-source', 'lib/appearance/scan/geometry-proof', 'lib/appearance/scan/session-source', 'lib/appearance/scan/session',
  'lib/appearance/scan/transfer-frame', 'lib/appearance/scan/prepare-transfer', 'components/viewer/appearance/scan-validation-message',
] as const;
export const appearanceWorkflowsChunkGroup = allowlistGroup('appearance-workflows', appearanceWorkflowsModules);
