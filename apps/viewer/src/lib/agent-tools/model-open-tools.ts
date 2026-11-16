/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `viewer_open_model`: lets a connected agent open a model itself, through
 * the same window-bus loaders the welcome card, tours and palette use
 * (`ifc-lite:load-file` replaces, `ifc-lite:add-model` federates). It waits
 * for the load to settle and returns the new model ids, so the agent can go
 * straight to `query_entities`. Bundled samples need no network; a URL is
 * fetched by the tab without credentials. Replacing models with unexported
 * edits is refused, since the agent cannot answer the confirm a user gets.
 */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { getViewerStoreApi, type ViewerState } from '@/store';
import { isFeatureEnabled } from '@/lib/features';
import { collectChangedModels, totalChangeCount } from '@/lib/export/model-changes';
import { isSupportedModelFile } from '@/services/supported-model-files';
import { EVENT_ADD_MODEL, EVENT_LOAD_FILE } from '@/lib/tours/events';
import { assertDispatchActive } from './cancellation';
import type { AgentInputSchema, AgentTool, ToolCallContext, ToolOutput } from './types';

/** Samples shipped with the viewer under `/samples`. `layers-demo` is the composed .ifcx stack. */
export const OPEN_MODEL_SAMPLES = {
  demo: { path: '/samples/building-architecture.ifc', about: 'small house, IFC4, 444 entities' },
  'demo-rev-b': { path: '/samples/building-architecture-rev-b.ifc', about: 'revision B of demo with a clash, for compare' },
  'hello-wall': { path: '/samples/hello-wall.ifc', about: 'one wall, minimal IFC' },
  'infra-bridge': { path: '/samples/infra-bridge.ifc', about: 'IFC4X3 bridge with alignment' },
  'layers-demo': { path: null, about: 'stacked .ifcx layers (replaces the current models)' },
} as const;
type SampleId = keyof typeof OPEN_MODEL_SAMPLES;

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
      sample: { type: 'string', enum: Object.keys(OPEN_MODEL_SAMPLES) },
      url: { type: 'string', maxLength: 2048 },
      mode: { type: 'string', enum: ['replace', 'add'] },
    } } satisfies AgentInputSchema,
    readOnly: false,
  },
} as const;

function fail(code: (typeof ToolErrorCode)[keyof typeof ToolErrorCode], message: string): never {
  throw new ToolExecutionError({ code, message });
}
const invalid = (message: string): never => fail(ToolErrorCode.INVALID_INPUT, message);

function assertGranted(ctx: ToolCallContext): void {
  assertDispatchActive(ctx.signal);
  if (!ctx.canEdit?.()) fail(ToolErrorCode.READ_ONLY,
    'The tab has not allowed palette commands and edits. The user must enable them in the local agent connection panel.');
}

interface OpenRequest { sample?: SampleId; url?: URL; mode: 'replace' | 'add' }

function parseArgs(args: Record<string, unknown>, state: ViewerState): OpenRequest {
  if (Object.keys(args).some((key) => !['sample', 'url', 'mode'].includes(key))) invalid('Unknown argument. Use sample, url and mode.');
  const { sample, url, mode } = args;
  if ((sample === undefined) === (url === undefined)) invalid('Pass exactly one of sample or url.');
  if (sample !== undefined && (typeof sample !== 'string' || !Object.hasOwn(OPEN_MODEL_SAMPLES, sample))) {
    invalid(`Unknown sample. Use one of: ${Object.keys(OPEN_MODEL_SAMPLES).join(', ')}.`);
  }
  let parsed: URL | undefined;
  if (url !== undefined) {
    if (typeof url !== 'string' || url.length > 2048) invalid('url must be a string of at most 2048 characters.');
    try { parsed = new URL(url as string, window.location.href); } catch { invalid('url is not a valid URL.'); }
    if (parsed!.protocol !== 'https:' && parsed!.origin !== window.location.origin) invalid('url must be https (or on this viewer\'s own origin).');
    if (parsed!.username || parsed!.password) invalid('url must not carry credentials.');
  }
  if (mode !== undefined && mode !== 'replace' && mode !== 'add') invalid("mode must be 'replace' or 'add'.");
  const loaded = state.models.size > 0 || state.ifcDataStore !== null;
  if (loaded && mode === undefined) invalid("Models are already loaded. Pass mode: 'replace' to close them or 'add' to federate.");
  if (sample === 'layers-demo' && mode === 'add') invalid("layers-demo always replaces the loaded models; use mode: 'replace'.");
  return { sample: sample as SampleId | undefined, url: parsed, mode: (mode as 'replace' | 'add' | undefined) ?? 'replace' };
}

function fileNameOf(url: URL): string {
  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
  return last || 'model.ifc';
}

async function download(url: URL, name: string, signal?: AbortSignal): Promise<File> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'omit', signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return fail(ToolErrorCode.UNSUPPORTED_OPERATION,
      `The tab could not fetch ${url.href}. The server must allow cross-origin requests (CORS) from this viewer.`);
  }
  if (!res.ok) fail(ToolErrorCode.UNSUPPORTED_OPERATION, `Fetching ${url.href} returned HTTP ${res.status}.`);
  const declared = Number(res.headers.get('content-length'));
  if (declared > OPEN_MODEL_MAX_BYTES) fail(ToolErrorCode.INVALID_INPUT, `The file is ${declared} bytes; the limit is ${OPEN_MODEL_MAX_BYTES}.`);
  const blob = await res.blob();
  if (blob.size > OPEN_MODEL_MAX_BYTES) fail(ToolErrorCode.INVALID_INPUT, `The file is ${blob.size} bytes; the limit is ${OPEN_MODEL_MAX_BYTES}.`);
  return new File([blob], name);
}

/** Resolve once a model id not in `before` is present and nothing is loading or streaming; reject on a load error. */
function waitForSettle(before: ReadonlySet<string>, errorSeqBefore: number, signal?: AbortSignal): Promise<void> {
  const store = getViewerStoreApi();
  return new Promise((resolve, reject) => {
    const check = (s: ViewerState): boolean => {
      // A load start clears the error with setError(null), which bumps the seq too: only a set error counts.
      if (s.loadErrorSeq !== errorSeqBefore && s.error) { reject(new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: `The viewer could not load the model: ${s.error}` })); return true; }
      if (s.loading || s.geometryStreamingActive) return false;
      if ([...s.models.keys()].some((id) => !before.has(id))) { resolve(); return true; }
      return false;
    };
    const done = () => { window.clearTimeout(timer); unsub(); signal?.removeEventListener('abort', onAbort); };
    const unsub = store.subscribe((s) => { if (check(s)) done(); });
    const timer = window.setTimeout(() => { done(); reject(new ToolExecutionError({ code: ToolErrorCode.INTERNAL_ERROR, message: 'The model did not finish loading within 3 minutes. Check model_list later.' })); }, SETTLE_TIMEOUT_MS);
    const onAbort = () => { done(); reject(new ToolExecutionError({ code: ToolErrorCode.CANCELLED, message: 'Cancelled while waiting; the load continues in the tab. Check model_list.' })); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (check(store.getState())) done();
  });
}

async function openModel(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutput> {
  assertGranted(ctx);
  const store = getViewerStoreApi();
  const request = parseArgs(args, store.getState());
  if (request.sample && !isFeatureEnabled('files.samples')) fail(ToolErrorCode.UNSUPPORTED_OPERATION, 'Sample models are switched off in this viewer.');
  if (store.getState().loading) fail(ToolErrorCode.STATE_CHANGED, 'A model is already loading. Wait for it, then try again.');

  let file: File | null = null;
  if (request.url) {
    file = await download(request.url, fileNameOf(request.url), ctx.signal);
    if (!isSupportedModelFile(file)) invalid(`${file.name} is not a model file the viewer opens (IFC, IFCX, glTF/GLB, point clouds, splats).`);
  } else if (request.sample !== 'layers-demo') {
    const { path } = OPEN_MODEL_SAMPLES[request.sample!];
    file = await download(new URL(path!, window.location.href), path!.split('/').pop()!, ctx.signal);
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
  const settled = waitForSettle(before, state.loadErrorSeq, ctx.signal);
  if (request.sample === 'layers-demo') {
    const { loadDemoLayerStack } = await import('@/lib/layers/demo-stack');
    await loadDemoLayerStack();
  } else {
    window.dispatchEvent(new CustomEvent(request.mode === 'add' ? EVENT_ADD_MODEL : EVENT_LOAD_FILE, { detail: file }));
  }
  await settled;

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
