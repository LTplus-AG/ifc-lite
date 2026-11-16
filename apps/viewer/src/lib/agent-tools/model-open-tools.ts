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

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { getViewerStoreApi, type ViewerState } from '@/store';
import { isFeatureEnabled } from '@/lib/features';
import { collectChangedModels, totalChangeCount } from '@/lib/export/model-changes';
import { isSupportedModelFile, PICKER_FILE_EXTENSIONS } from '@/services/supported-model-files';
import { DEMO_KIT_PATHS, fetchSampleFile, waitForLoadIdle } from '@/lib/tours/demo-kit';
import { getAgentModelLoader } from '@/lib/agent-bridge/model-loader-host';
import { nonModelContentReason } from '@/hooks/ingest/nonModelContent';
import { NON_MODEL_REASONS } from '@/lib/non-model-reasons';
import { CALL_LIMITS } from '@/lib/agent-bridge/call-admission';
import { assertGranted, fail, invalid, keys, oneOf, type ToolErrorCodeValue } from './tool-args';
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
 * How long the call waits for the load: the tab answers every call within
 * `CALL_LIMITS.callTimeoutMs`, so a longer load is reported as still running,
 * never as a failure. It has already replaced or joined the models and must
 * not be retried.
 */
export const OPEN_MODEL_WAIT_MS = CALL_LIMITS.callTimeoutMs - 15_000;

export const MODEL_OPEN_SPECS = {
  viewer_open_model: {
    description: 'Open a model in the viewer tab and wait until it has loaded. Pass `sample` for a bundled model '
      + `(${Object.entries(OPEN_MODEL_SAMPLES).map(([id, s]) => `${id}: ${s.about}`).join('; ')}) or \`url\` for an https model file whose path ends in its extension (not .gltf: its buffers cannot come along), fetched by the tab (CORS, no credentials, redirects followed; HTML pages refused). `
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

/** The file name: the URL path's last segment, percent-decoded, never carrying an encoded path separator. */
function fileNameOf(url: URL): string {
  const segment = url.pathname.split('/').filter(Boolean).pop() ?? '';
  let name = segment;
  try {
    name = decodeURIComponent(segment);
  } catch (err) {
    console.warn('[viewer_open_model] keeping a malformed percent-escape as is:', segment, err);
  }
  return name.split(/[\\/]/).pop() ?? '';
}

/**
 * Whether a URL may name this file: what the viewer opens from one file (the shared format list, so a build
 * without splats refuses them), except `.gltf`, whose external buffers and textures do not come along.
 */
const isUrlModelName = (name: string) => !/\.gltf$/i.test(name) && isSupportedModelFile(new File([], name));
/** The extensions a URL may name, for messages. */
const URL_MODEL_EXTENSIONS = () => PICKER_FILE_EXTENSIONS.filter((ext) => isUrlModelName(`model${ext}`)).join(', ');

/** A URL in messages: never its query or fragment, which can carry signed-URL credentials. */
const shown = (url: URL) => `${url.origin}${url.pathname}`;
const tooLarge = (url: URL) => `${shown(url)} is larger than ${OPEN_MODEL_MAX_BYTES} bytes, the limit for an agent download.`;

/**
 * The body as a File, refusing once it passes the limit rather than after
 * buffering all of it (chunked or compressed bodies have no usable length).
 * Bytes are counted as they stream; the browser holds the body once.
 */
async function readLimited(res: Response, url: URL, name: string): Promise<File> {
  const tooBig = () => fail(ToolErrorCode.INVALID_INPUT, tooLarge(url));
  if (!res.body) return new File([], name); // a null-body response (204, 205, 304)
  let total = 0;
  // Response.blob() wraps a stream error in its own, so the limit is remembered here rather than recognised there.
  let overLimit = false;
  const reader = res.body.getReader();
  const limited = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      total += value.byteLength;
      if (total > OPEN_MODEL_MAX_BYTES) {
        overLimit = true;
        controller.error(new RangeError('download limit'));
        await reader.cancel();
        return;
      }
      controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  try {
    return new File([await new Response(limited).blob()], name);
  } catch (err) {
    if (overLimit) tooBig();
    throw err;
  }
}

async function download(url: URL, signal?: AbortSignal): Promise<File> {
  // The name, and so the format, comes from the URL path: refused before any network or state change.
  const requested = fileNameOf(url);
  if (!isUrlModelName(requested)) {
    invalid(`${requested || shown(url)} is not a model file the viewer opens from a URL (${URL_MODEL_EXTENSIONS()}; not .gltf, `
      + 'whose buffers cannot come along). Use a URL whose path ends in the file\'s extension.');
  }
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'omit', signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return fail(ToolErrorCode.UNSUPPORTED_OPERATION,
      `The tab could not fetch ${shown(url)}. The server must allow cross-origin requests (CORS) from this viewer.`);
  }
  // After redirects the bytes are the final URL's: name the file by it when it names a model (a signed CDN URL
  // often has no extension; then the requested name stands). The byte check below catches a mismatch either way.
  const source = res.url ? new URL(res.url) : url;
  const redirectedName = fileNameOf(source);
  const name = isUrlModelName(redirectedName) ? redirectedName : requested;
  const refuse = (message: string, code: ToolErrorCodeValue = ToolErrorCode.UNSUPPORTED_OPERATION): never => {
    // An unread body is cancelled so it stops downloading; one already read (or being read) has nothing left to stop.
    if (res.body && !res.body.locked) res.body.cancel().catch((err: unknown) => console.warn('[viewer_open_model] cancelling the response body failed:', err));
    return fail(code, message);
  };
  if (!res.ok) refuse(`Fetching ${shown(source)} returned HTTP ${res.status}.`);
  if (/^(?:text\/html|application\/xhtml\+xml)\b/i.test(res.headers.get('content-type') ?? '')) refuse(`${shown(source)} returned ${NON_MODEL_REASONS.html}. Nothing was loaded.`);
  if (Number(res.headers.get('content-length')) > OPEN_MODEL_MAX_BYTES) refuse(tooLarge(source), ToolErrorCode.INVALID_INPUT);
  const file = await readLimited(res, source, name);
  if (file.size === 0) refuse(`${shown(source)} returned an empty body (HTTP ${res.status}). Nothing was loaded.`);
  // The loader's own pre-reset check, run here too so the agent hears which URL served the error before the
  // unexported-edits check and the grant recheck.
  const notAModel = await nonModelContentReason(file);
  if (notAModel) refuse(`${shown(source)} returned ${notAModel}. Nothing was loaded.`);
  return file;
}

/** The files to load: one model file, or the layer stack's .ifcx files. */
async function filesFor(source: Source, signal?: AbortSignal): Promise<File[]> {
  if (source.kind === 'url') return [await download(source.url, signal)];
  const { path } = OPEN_MODEL_SAMPLES[source.id];
  if (path) return [await fetchSampleFile(path, path.split('/').pop()!, signal)];
  if (!isFeatureEnabled('files.samples')) fail(ToolErrorCode.UNSUPPORTED_OPERATION, 'Sample models are switched off in this viewer.');
  const { buildDemoLayerFiles } = await import('@/lib/layers/demo-stack');
  return buildDemoLayerFiles(signal);
}

async function openModel(args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutput> {
  // The tab answers every call within CALL_LIMITS.callTimeoutMs of starting it, download included.
  const deadline = Date.now() + OPEN_MODEL_WAIT_MS;
  assertGranted(ctx);
  const store = getViewerStoreApi();
  const request = parseArgs(args, store.getState());
  const loader = getAgentModelLoader();
  if (!loader) return fail(ToolErrorCode.UNSUPPORTED_OPERATION, 'This viewer page has no file loader mounted. Retry after it has finished loading.');
  if (store.getState().loading) fail(ToolErrorCode.STATE_CHANGED, 'A model is already loading. Wait for it, then try again.');

  // Nothing has changed yet, so a download that outlasts the budget is abandoned.
  const downloadBudget = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
  let files: File[];
  try {
    files = await filesFor(request.source, ctx.signal ? AbortSignal.any([ctx.signal, downloadBudget]) : downloadBudget);
  } catch (err) {
    if (ctx.signal?.aborted || err instanceof ToolExecutionError) throw err;
    if (downloadBudget.aborted) fail(ToolErrorCode.UNSUPPORTED_OPERATION, `The download did not finish within ${OPEN_MODEL_WAIT_MS / 1000} s. Nothing was loaded; try a smaller file or a faster host.`);
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
  const snapshot = () => [...store.getState().models.values()].map((m) => ({
    model_id: m.id, name: m.name, schema: m.schemaVersion ?? null, new: !before.has(m.id),
    failed: m.loadState === 'error', error: m.loadError ?? null,
  }));
  const stack = files.length > 1;
  const name = stack ? 'the layer stack' : files[0].name;
  // A declaration: TypeScript ends control flow at its calls (an unannotated `never` arrow would not).
  function couldNotLoad(reason: string): never { return fail(ToolErrorCode.INTERNAL_ERROR, `The viewer could not load ${name}: ${reason}`); }
  let loadError: string | undefined;
  const onError = (message: string) => { loadError = message; };
  // A replace runs under an id chosen here; an add reports its id.
  const primaryId = request.mode === 'replace' && !stack ? crypto.randomUUID() : null;
  // From here the load changes the session whatever happens to this call: it is not cancellable.
  if (ctx.commitState) ctx.commitState.committing = true;
  const load: Promise<string | null | void> = request.mode === 'add' ? loader.addModel(files[0], onError)
    : stack ? loader.loadStack(files) : loader.loadFile(files[0], primaryId!, onError);
  const stillLoading = (): ToolOutput => ({
    text: `${name} is still loading; it continues in the tab.${request.mode === 'replace' ? ' A replace closes the previous models as it proceeds.' : ''} `
      + 'Do not retry. Call model_list to see what is open; if the model never appears, the load failed: take a viewer_screenshot or ask the user what the viewer reports.',
    // Placeholder records have no data yet, and a replace may be closing the old models: list only models an add keeps.
    structured: { mode: request.mode, state: 'loading', loading: name, models: request.mode === 'add' ? snapshot().filter((m) => !m.new).map(publicModel) : [] },
  });
  const loaded = await within(load.then((id) => ({ id }), (err: unknown) => {
    // The loader's own reason (onError) is more specific than the exception that ended it.
    return couldNotLoad(loadError ?? (err instanceof Error ? err.message : String(err)));
  }), deadline - Date.now());
  if (!loaded) return stillLoading();
  // This call's own records: an add's returned id (none when it failed), a replace's chosen id, and for the
  // stack (no per-call id, layer ids repeat across loads) its exact file names: a stack load clears every
  // model before composing, so after it only this load's layers carry those names.
  const stackNames = new Set(files.map((f) => f.name));
  const isMine = (m: { model_id: string; name: string }) => (request.mode === 'add' ? m.model_id === loaded.id
    : stack ? stackNames.has(m.name) : m.model_id === primaryId);

  // The stack loader reports failures only through the store, before it resolves and sometimes before it
  // clears anything, so an earlier stack's same-named layers may still be open: read its error now. Only
  // errors raised during the load and worded like the loader's count; later ones belong to someone else.
  // TODO(#9523): give loadStack its own onError and layer ids (useIfcFederation is at its size budget).
  const { error: stackError, loadErrorSeq } = store.getState();
  if (stack && stackError && loadErrorSeq !== state.loadErrorSeq && /federated IFCX loading failed|federated loading|is not an IFCX file/i.test(stackError)) couldNotLoad(stackError);

  // Models can register just after the loader resolves: wait until the pipeline is idle, which needs no model.
  const settled = await waitForLoadIdle(deadline - Date.now());
  let mine = snapshot().filter(isMine);
  if (mine.length === 0 && settled && !loadError) {
    // Rare path: give a registration queued behind the loader one task before concluding.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    mine = snapshot().filter(isMine);
  }
  if (mine.length === 0) {
    if (loadError) couldNotLoad(loadError);
    if (typeof loaded.id === 'string') fail(ToolErrorCode.STATE_CHANGED, `${name} was added, then closed by another load in the tab. Check model_list.`);
    if (!settled && loaded.id !== null) return stillLoading();
    // No error and no model of ours: an underlay drape, a cancel, or another load won.
    fail(ToolErrorCode.UNSUPPORTED_OPERATION, `The viewer did not open ${name} as a model. Check model_list and the viewer.`);
  }
  // A failed load can leave its record with loadState 'error': that is a failure, not an opened model.
  const failed = mine.filter((m) => m.failed);
  const good = mine.filter((m) => !m.failed);
  if (good.length === 0) {
    if (failed.some((m) => m.error === 'cancelled')) fail(ToolErrorCode.STATE_CHANGED, `Loading ${name} was cancelled in the viewer.`);
    couldNotLoad(loadError ?? failed[0].error ?? 'see the viewer for details');
  }
  const models = snapshot().filter((m) => !m.failed);
  const text = `Loaded ${good.map((m) => `${m.name} (model_id ${m.model_id})`).join(', ')}${settled ? '' : '; geometry is still streaming'}`
    + `${failed.length ? `; ${failed.map((m) => m.name).join(', ')} failed` : ''}. `
    + `${models.length} model(s) now open. Next: query_entities with a model_id, or viewer_screenshot to look at the view.`;
  return { text, structured: { mode: request.mode, state: settled ? 'loaded' : 'streaming', models: models.map(publicModel) } };
}

/** A model as the agent sees it. */
function publicModel(m: { model_id: string; name: string; schema: string | null; new: boolean }) {
  return { model_id: m.model_id, name: m.name, schema: m.schema, new: m.new };
}

/** `work`'s value, or null once `ms` pass first; the timer is cleared either way. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export const modelOpenTools: Record<keyof typeof MODEL_OPEN_SPECS, AgentTool> = {
  viewer_open_model: { needs: 'none', run: (_host, args, ctx) => openModel(args, ctx) },
};
