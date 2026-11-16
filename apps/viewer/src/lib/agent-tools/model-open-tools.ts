/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `viewer_open_model`: lets a connected agent open a model itself, through
 * the loaders the mounted file commands register (the same `loadFile` /
 * `addModel` / layer-stack paths as the welcome card and palette). It awaits
 * the load, waits for geometry to settle, and returns the model ids, so the
 * agent can go straight to `query_entities`. Bundled samples need no network;
 * a URL is fetched by the tab without credentials. Replacing models with
 * unexported edits is refused, since the agent cannot answer the confirm a
 * user gets.
 */

import { ToolErrorCode } from '@ifc-lite/mcp/browser';
import { getViewerStoreApi, type ViewerState } from '@/store';
import { isFeatureEnabled } from '@/lib/features';
import { collectChangedModels, totalChangeCount } from '@/lib/export/model-changes';
import { isSupportedModelFile } from '@/services/supported-model-files';
import { DEMO_KIT_PATHS, fetchSampleFile, waitForModelSettled } from '@/lib/tours/demo-kit';
import { getAgentModelLoader } from '@/lib/agent-bridge/model-loader-host';
import { assertGranted, fail, invalid, keys, oneOf } from './tool-args';
import type { AgentInputSchema, AgentTool, ToolCallContext, ToolOutput } from './types';

/** Samples shipped with the viewer. `layers-demo` is the composed .ifcx stack. */
export const OPEN_MODEL_SAMPLES = {
  demo: { path: DEMO_KIT_PATHS.base, about: 'small house, IFC4, 444 entities' },
  'demo-rev-b': { path: DEMO_KIT_PATHS.revB, about: 'revision B of demo with a clash, for compare' },
  'hello-wall': { path: '/samples/hello-wall.ifc', about: 'one wall, minimal IFC' },
  'infra-bridge': { path: '/samples/infra-bridge.ifc', about: 'IFC4X3 bridge with alignment' },
  'layers-demo': { path: null, about: 'stacked .ifcx layers (replaces the current models)' },
} as const;
type SampleId = keyof typeof OPEN_MODEL_SAMPLES;
const SAMPLE_IDS = Object.keys(OPEN_MODEL_SAMPLES) as SampleId[];
const MODES = ['replace', 'add'] as const;

/** Largest file the tab downloads for an agent. */
export const OPEN_MODEL_MAX_BYTES = 512 * 1024 * 1024;
const SETTLE_TIMEOUT_MS = 180_000;

export const MODEL_OPEN_SPECS = {
  viewer_open_model: {
    description: 'Open a model in the viewer tab and wait until it has loaded. Pass `sample` for a bundled model '
      + `(${Object.entries(OPEN_MODEL_SAMPLES).map(([id, s]) => `${id}: ${s.about}`).join('; ')}) or \`url\` for an https IFC/IFCX/GLB/point-cloud file the tab can fetch (CORS, no credentials). `
      + '`mode` is `replace` (default when nothing is loaded) or `add` to federate with the loaded models; it is required while models are loaded. '
      + 'Replacing models with unexported edits is refused. Returns the loaded models with their model_id. Requires the commands and edits permission.',
    inputSchema: { type: 'object', properties: {
      sample: { type: 'string', enum: SAMPLE_IDS },
      url: { type: 'string', maxLength: 2048 },
      mode: { type: 'string', enum: [...MODES] },
    } } satisfies AgentInputSchema,
    readOnly: false,
  },
} as const;

type Source = { kind: 'sample'; id: SampleId } | { kind: 'url'; url: URL };
interface OpenRequest { source: Source; mode: 'replace' | 'add' }

function parseUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 2048) invalid('url must be a string of at most 2048 characters.');
  let url: URL;
  try { url = new URL(raw as string, window.location.href); } catch { return invalid('url is not a valid URL.'); }
  if (url.protocol !== 'https:' && url.origin !== window.location.origin) invalid('url must be https (or on this viewer\'s own origin).');
  if (url.username || url.password) invalid('url must not carry credentials.');
  return url;
}

function parseArgs(args: Record<string, unknown>, state: ViewerState): OpenRequest {
  keys(args, ['sample', 'url', 'mode']);
  if ((args.sample === undefined) === (args.url === undefined)) invalid('Pass exactly one of sample or url.');
  const source: Source = args.url !== undefined ? { kind: 'url', url: parseUrl(args.url) } : { kind: 'sample', id: oneOf(args, 'sample', SAMPLE_IDS)! };
  const mode = oneOf(args, 'mode', MODES);
  const loaded = state.models.size > 0 || state.ifcDataStore !== null;
  if (loaded && mode === undefined) invalid("Models are already loaded. Pass mode: 'replace' to close them or 'add' to federate.");
  if (source.kind === 'sample' && source.id === 'layers-demo' && mode === 'add') invalid("layers-demo always replaces the loaded models; use mode: 'replace'.");
  return { source, mode: mode ?? 'replace' };
}

function fileNameOf(url: URL): string {
  return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '') || 'model.ifc';
}

async function download(url: URL, signal?: AbortSignal): Promise<File> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'omit', signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return fail(ToolErrorCode.UNSUPPORTED_OPERATION,
      `The tab could not fetch ${url.href}. The server must allow cross-origin requests (CORS) from this viewer.`);
  }
  if (!res.ok) fail(ToolErrorCode.UNSUPPORTED_OPERATION, `Fetching ${url.href} returned HTTP ${res.status}.`);
  const size = Math.max(Number(res.headers.get('content-length')) || 0, 0);
  if (size > OPEN_MODEL_MAX_BYTES) fail(ToolErrorCode.INVALID_INPUT, `The file is ${size} bytes; the limit is ${OPEN_MODEL_MAX_BYTES}.`);
  const blob = await res.blob();
  if (blob.size > OPEN_MODEL_MAX_BYTES) fail(ToolErrorCode.INVALID_INPUT, `The file is ${blob.size} bytes; the limit is ${OPEN_MODEL_MAX_BYTES}.`);
  const file = new File([blob], fileNameOf(url));
  if (!isSupportedModelFile(file)) invalid(`${file.name} is not a model file the viewer opens (IFC, IFCX, glTF/GLB, point clouds, splats).`);
  return file;
}

/** The files to load: one model file, or the layer stack's .ifcx files. */
async function filesFor(source: Source, signal?: AbortSignal): Promise<File[]> {
  if (source.kind === 'url') return [await download(source.url, signal)];
  const { path } = OPEN_MODEL_SAMPLES[source.id];
  if (path) return [await fetchSampleFile(path, path.split('/').pop()!)];
  if (!isFeatureEnabled('files.samples')) fail(ToolErrorCode.UNSUPPORTED_OPERATION, 'Sample models are switched off in this viewer.');
  const { buildDemoLayerFiles } = await import('@/lib/layers/demo-stack');
  return buildDemoLayerFiles();
}

async function openModel(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutput> {
  assertGranted(ctx);
  const store = getViewerStoreApi();
  const request = parseArgs(args, store.getState());
  const loader = getAgentModelLoader();
  if (!loader) return fail(ToolErrorCode.UNSUPPORTED_OPERATION, 'This viewer page has no file loader mounted. Retry after it has finished loading.');
  if (store.getState().loading) fail(ToolErrorCode.STATE_CHANGED, 'A model is already loading. Wait for it, then try again.');

  let files: File[];
  try {
    files = await filesFor(request.source, ctx.signal);
  } catch (err) {
    if (ctx.signal?.aborted || (err as { code?: unknown }).code) throw err;
    return fail(ToolErrorCode.UNSUPPORTED_OPERATION, err instanceof Error ? err.message : String(err));
  }

  // Everything below changes the session: recheck the grant and the edits right before it.
  assertGranted(ctx);
  const state = store.getState();
  if (state.loading) fail(ToolErrorCode.STATE_CHANGED, 'A model started loading meanwhile. Try again when it finishes.');
  if (request.mode === 'replace') {
    const unexported = totalChangeCount(collectChangedModels(state));
    if (unexported > 0) fail(ToolErrorCode.STATE_CHANGED,
      `The loaded models have ${unexported} unexported change(s). Replacing them would discard those edits; ask the user to export or discard them, or use mode: 'add'.`);
  }

  const before = new Set(state.models.keys());
  if (request.mode === 'add') {
    if (await loader.addModel(files[0]) === null) {
      fail(ToolErrorCode.INTERNAL_ERROR, `The viewer could not add ${files[0].name}: ${store.getState().error ?? 'see the viewer for details'}.`);
    }
  } else {
    await (files.length > 1 ? loader.loadStack(files) : loader.loadFile(files[0]));
    // A load start clears the previous error (which bumps the seq too); only a set error is a failure.
    const after = store.getState();
    if (after.error && after.loadErrorSeq !== state.loadErrorSeq) fail(ToolErrorCode.INTERNAL_ERROR, `The viewer could not load the model: ${after.error}`);
  }
  try {
    await waitForModelSettled(SETTLE_TIMEOUT_MS, ctx.signal);
  } catch {
    fail(ctx.signal?.aborted ? ToolErrorCode.CANCELLED : ToolErrorCode.INTERNAL_ERROR,
      'The model is still loading in the tab. Check model_list later.');
  }

  const models = [...store.getState().models.values()].map((m) => ({
    model_id: m.id, name: m.name, schema: m.schemaVersion ?? null, new: !before.has(m.id),
  }));
  const added = models.filter((m) => m.new);
  const text = [`Loaded ${added.map((m) => `${m.name} (model_id ${m.model_id})`).join(', ') || 'the model'}.`,
    `${models.length} model(s) now open. Next: query_entities with a model_id, or viewer_screenshot to look at the view.`].join(' ');
  return { text, structured: { mode: request.mode, models } };
}

export const modelOpenTools: Record<keyof typeof MODEL_OPEN_SPECS, AgentTool> = {
  viewer_open_model: { needs: 'none', run: (_host, args, ctx) => openModel(args, ctx) },
};
