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
import { isSupportedModelFile } from '@/services/supported-model-files';
import { DEMO_KIT_PATHS, fetchSampleFile, waitForLoadIdle } from '@/lib/tours/demo-kit';
import { getAgentModelLoader } from '@/lib/agent-bridge/model-loader-host';
import { CALL_LIMITS } from '@/lib/agent-bridge/call-admission';
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
 * How long the call waits for the load: the tab answers every call within
 * `CALL_LIMITS.callTimeoutMs`, so a longer load is reported as still running,
 * never as a failure. It has already replaced or joined the models and must
 * not be retried.
 */
export const OPEN_MODEL_WAIT_MS = CALL_LIMITS.callTimeoutMs - 15_000;

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

/** Percent-decode `text` as UTF-8, or byte-per-character for ISO-8859-1; as given when malformed. */
function percentDecoded(text: string, charset = 'utf-8'): string {
  if (/^iso-8859-1$/i.test(charset)) return text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  try {
    return decodeURIComponent(text);
  } catch (err) {
    console.warn('[viewer_open_model] keeping a malformed percent-escape as is:', text, err);
    return text;
  }
}

/**
 * One parameter (`; name=value`), sticky. A quoted value is a quoted-string; a bare value runs to the next
 * `;` or to a comma that starts another disposition or filename parameter: a repeated header arrives
 * joined with ', ', and only the first header is read.
 */
/** Where a second, comma-joined header starts: another disposition, or a filename parameter. */
const NEXT_HEADER = String.raw`,\s*(?:(?:attachment|inline)\s*(?:;|$)|filename\*?\s*=)`;
const DISPOSITION_PARAM = new RegExp(String.raw`;\s*([^\s=;,]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|((?:(?!${NEXT_HEADER})[^;])*))\s*`, 'iy');

/** `Content-Disposition` parameters by lower-case name, quoted strings unescaped; the first value of a name wins. */
function dispositionParams(header: string): Map<string, string> {
  const trimmed = header.trim();
  // Skip the disposition type; a header without one (`filename="x.ifc"`) starts with its first parameter.
  const text = /^[^;]*=/.test(trimmed) ? `;${trimmed}` : trimmed.slice(Math.max(0, trimmed.indexOf(';')));
  const params = new Map<string, string>();
  for (let at = 0; at < text.length;) {
    DISPOSITION_PARAM.lastIndex = at;
    const m = DISPOSITION_PARAM.exec(text);
    if (m) {
      const [, key, quoted, bare] = m;
      if (!params.has(key.toLowerCase())) params.set(key.toLowerCase(), (quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : bare).trim());
      at = DISPOSITION_PARAM.lastIndex;
      continue;
    }
    // Not a parameter (`; foo`, `;;`, junk after a quoted value): skip to the next ';', unless the next header starts first.
    const next = text.indexOf(';', at + 1);
    const nextHeader = text.slice(at).search(new RegExp(NEXT_HEADER, 'i'));
    if (next === -1 || (nextHeader !== -1 && at + nextHeader < next)) break;
    at = next;
  }
  return params;
}

/**
 * The name from Content-Disposition (RFC 6266: `filename*`, `charset'lang'value`,
 * wins over `filename`), else the URL's last path segment; empty when neither
 * names a file, so the extension check refuses it. Cross-origin, the header is
 * only readable when the server exposes it (Access-Control-Expose-Headers).
 */
function fileNameOf(url: URL, res: Response): string {
  const params = dispositionParams(res.headers.get('content-disposition') ?? '');
  const extended = /^([^']*)'[^']*'(.+)$/.exec(params.get('filename*') ?? '');
  const lastSegment = (path: string) => path.split(/[\\/]/).pop() ?? '';
  const declared = lastSegment(extended ? percentDecoded(extended[2], extended[1]) : params.get('filename') ?? '');
  const fromPath = lastSegment(percentDecoded(url.pathname.split('/').filter(Boolean).pop() ?? ''));
  // A declared name with an extension wins, even when it is not a model file: a server labelling the body
  // `error.html` is refused rather than replacing the user's models with it. One without (`house`, parse junk)
  // says nothing about the type, so the URL path names the file.
  return /\.[a-z0-9]+$/i.test(declared) ? declared : fromPath || declared;
}

/**
 * The body as a File, refusing once it passes the limit rather than after
 * buffering all of it (chunked or compressed bodies have no usable length).
 * Bytes are counted as they stream; the browser holds the body once.
 */
async function readLimited(res: Response, url: URL, name: string): Promise<File> {
  const tooBig = () => fail(ToolErrorCode.INVALID_INPUT, `${url.href} is larger than ${OPEN_MODEL_MAX_BYTES} bytes, the limit for an agent download.`);
  if (Number(res.headers.get('content-length')) > OPEN_MODEL_MAX_BYTES) tooBig();
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
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'omit', signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return fail(ToolErrorCode.UNSUPPORTED_OPERATION,
      `The tab could not fetch ${url.href}. The server must allow cross-origin requests (CORS) from this viewer.`);
  }
  if (!res.ok) fail(ToolErrorCode.UNSUPPORTED_OPERATION, `Fetching ${url.href} returned HTTP ${res.status}.`);
  const file = await readLimited(res, url, fileNameOf(url, res));
  // Refused here, before a replace could close the open models for nothing.
  if (file.size === 0) fail(ToolErrorCode.UNSUPPORTED_OPERATION, `${url.href} returned an empty body (HTTP ${res.status}). Nothing was loaded.`);
  if (!isSupportedModelFile(file)) {
    invalid(`${file.name || 'The download'} is not a model file the viewer opens (IFC, IFCX, glTF/GLB, point clouds, splats). `
      + (res.headers.get('content-disposition') ? 'The name comes from the server\'s Content-Disposition header.' : 'Use a URL whose path ends in the file\'s extension.'));
  }
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
    if (err instanceof ToolExecutionError) throw err;
    // The loader's own reason (onError) is more specific than the exception that ended it.
    return fail(ToolErrorCode.INTERNAL_ERROR, `The viewer could not load ${name}: ${loadError ?? (err instanceof Error ? err.message : String(err))}`);
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
  const stackFailure = () => {
    const { error, loadErrorSeq } = store.getState();
    return stack && error && loadErrorSeq !== state.loadErrorSeq && /federated IFCX loading failed|federated loading|is not an IFCX file/i.test(error) ? error : null;
  };
  const stackError = stackFailure();
  if (stackError) fail(ToolErrorCode.INTERNAL_ERROR, `The viewer could not load ${name}: ${stackError}`);

  // Models can register just after the loader resolves: wait until the pipeline is idle, which needs no model.
  const settled = await waitForLoadIdle(deadline - Date.now());
  let mine = snapshot().filter(isMine);
  if (mine.length === 0 && settled && !loadError) {
    // Rare path: give a registration queued behind the loader one task before concluding.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    mine = snapshot().filter(isMine);
  }
  if (mine.length === 0) {
    if (loadError) fail(ToolErrorCode.INTERNAL_ERROR, `The viewer could not load ${name}: ${loadError}`);
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
    fail(ToolErrorCode.INTERNAL_ERROR, `The viewer could not load ${name}: ${loadError ?? failed[0].error ?? 'see the viewer for details'}`);
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
