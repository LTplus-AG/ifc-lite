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
/**
 * How long the call waits for the load after starting it. The tab answers
 * every call within 60 s (`CALL_LIMITS.callTimeoutMs`), so a longer load is
 * reported as still running, never as a failure: it has already replaced or
 * joined the models and must not be retried.
 */
export const OPEN_MODEL_WAIT_MS = 45_000;

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

/** The file name: Content-Disposition's, else the URL's last path segment. */
function fileNameOf(url: URL, res: Response): string {
  const disposition = res.headers.get('content-disposition') ?? '';
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
  const raw = named ?? url.pathname.split('/').filter(Boolean).pop() ?? '';
  let name = raw;
  try { name = decodeURIComponent(raw); } catch { /* keep the raw segment */ }
  return name.split(/[\\/]/).pop() || 'model.ifc';
}

/** The body, refusing once it passes the limit rather than after buffering all of it (chunked or compressed bodies have no usable length). */
async function readLimited(res: Response, url: URL): Promise<Blob> {
  const tooBig = () => fail(ToolErrorCode.INVALID_INPUT, `${url.href} is larger than ${OPEN_MODEL_MAX_BYTES} bytes, the limit for an agent download.`);
  if (Number(res.headers.get('content-length')) > OPEN_MODEL_MAX_BYTES) tooBig();
  if (!res.body) return res.blob();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > OPEN_MODEL_MAX_BYTES) { void reader.cancel(); tooBig(); }
    chunks.push(value);
  }
  return new Blob(chunks as BlobPart[]);
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
  const file = new File([await readLimited(res, url)], fileNameOf(url, res));
  if (!isSupportedModelFile(file)) {
    invalid(`${file.name} is not a model file the viewer opens (IFC, IFCX, glTF/GLB, point clouds, splats). The URL path or its Content-Disposition must end in the file's extension.`);
  }
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
  const name = files.length > 1 ? 'the layer stack' : files[0].name;
  // From here the load changes the session whatever happens to this call: it is not cancellable.
  if (ctx.commitState) ctx.commitState.committing = true;
  const deadline = Date.now() + OPEN_MODEL_WAIT_MS;
  const load: Promise<string | null | void> = request.mode === 'add' ? loader.addModel(files[0])
    : files.length > 1 ? loader.loadStack(files) : loader.loadFile(files[0]);
  const loaded = await Promise.race([load.then((id) => ({ id })), wait(OPEN_MODEL_WAIT_MS).then(() => null)]);
  if (loaded) {
    const after = store.getState();
    if (after.error && after.loadErrorSeq !== state.loadErrorSeq) fail(ToolErrorCode.INTERNAL_ERROR, `The viewer could not load ${name}: ${after.error}`);
    if (loaded.id === null) fail(ToolErrorCode.INTERNAL_ERROR, `The viewer could not add ${name}. See the viewer for details.`);
  }
  const settled = loaded !== null && await waitForModelSettled(Math.max(0, deadline - Date.now())).then(() => true, () => false);
  const models = [...store.getState().models.values()].map((m) => ({
    model_id: m.id, name: m.name, schema: m.schemaVersion ?? null, new: !before.has(m.id),
  }));
  const added = models.filter((m) => m.new);
  if (loaded && added.length === 0) {
    // loadFile can return without an error and without opening a model (an underlay drape, a geometry-kernel refusal).
    fail(ToolErrorCode.UNSUPPORTED_OPERATION, `The viewer did not open ${name} as a model. See the viewer for why.`);
  }
  const phase = !loaded ? 'loading' : settled ? 'loaded' : 'streaming';
  const text = phase === 'loading'
    ? `${name} is still loading after ${OPEN_MODEL_WAIT_MS / 1000} s; it continues in the tab. Do not retry: call model_list until it appears.`
    : [`Loaded ${added.map((m) => `${m.name} (model_id ${m.model_id})`).join(', ')}${phase === 'streaming' ? '; geometry is still streaming' : ''}.`,
      `${models.length} model(s) now open. Next: query_entities with a model_id, or viewer_screenshot to look at the view.`].join(' ');
  return { text, structured: { mode: request.mode, state: phase, models } };
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export const modelOpenTools: Record<keyof typeof MODEL_OPEN_SPECS, AgentTool> = {
  viewer_open_model: { needs: 'none', run: (_host, args, ctx) => openModel(args, ctx) },
};
