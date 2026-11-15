/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In-page source tracking for `oom-load-probe.mjs` (#10264, #10353 proofs).
 *
 * `installSourceTracker` is injected into the page as an init script, so it
 * must stay self-contained: no imports, no references to module scope. The
 * unit tests run the same function in Node against fake `FileReader`/`Worker`
 * classes.
 *
 * The picked source is identified by OBJECT IDENTITY, never by size: every
 * `File` that a file `<input>` delivers is tagged, and so is every `Blob.slice`
 * derived from a tagged object. A read counts as a source read only for a
 * tagged object. A large read (>= `minBytes`) of anything else is reported
 * separately as an unattributed read, because it might be a cache entry or a
 * copy. Every worker `postMessage` that carries or transfers a Blob is
 * recorded with its time, the worker's script URL and whether it was the
 * source.
 *
 * @param {object} env
 * @param {typeof Blob} env.Blob
 * @param {any} [env.FileReader]
 * @param {any} [env.Worker]        constructor; replaced on `env.target` by a URL-recording proxy
 * @param {object} env.target       where to install `Worker` and `__oomProbeTracker` (globalThis in the page)
 * @param {any} [env.document]      to hook file `<input>` changes
 * @param {() => number} env.now    wall clock (Date.now in the page)
 * @param {number} [env.minBytes]   unattributed-read threshold (default 1 MiB)
 */
export function installSourceTracker(env) {
  const minBytes = env.minBytes ?? 1 << 20;
  const sources = new WeakSet(), derived = new WeakSet(), workerUrls = new WeakMap();
  const state = { installed: true, sourcesMarked: 0, sourceBytes: null, sourceReads: [], unattributedReads: [], workerPosts: [] };
  const CAP = 200;
  const isSource = (b) => b != null && (sources.has(b) || derived.has(b));
  const push = (list, entry) => { if (list.length < CAP) list.push(entry); };
  const markSource = (file) => {
    if (file && !sources.has(file)) { sources.add(file); state.sourcesMarked++; state.sourceBytes = file.size; }
  };
  const read = (b, via) => {
    if (!b || typeof b.size !== 'number') return;
    if (isSource(b)) push(state.sourceReads, { t: env.now(), bytes: b.size, via, whole: sources.has(b) });
    else if (b.size >= minBytes) push(state.unattributedReads, { t: env.now(), bytes: b.size, via });
  };
  const proto = env.Blob.prototype;
  for (const m of ['arrayBuffer', 'text', 'bytes', 'stream']) {
    const orig = proto[m];
    if (orig) proto[m] = function (...a) { read(this, m); return orig.apply(this, a); };
  }
  const slice = proto.slice;
  proto.slice = function (...a) {
    const part = slice.apply(this, a);
    if (isSource(this)) derived.add(part);
    return part;
  };
  if (env.FileReader) {
    for (const m of ['readAsArrayBuffer', 'readAsText', 'readAsBinaryString', 'readAsDataURL']) {
      const orig = env.FileReader.prototype[m];
      if (orig) env.FileReader.prototype[m] = function (b, ...a) { read(b, m); return orig.call(this, b, ...a); };
    }
  }
  if (env.Worker) {
    const W = env.Worker;
    env.target.Worker = new Proxy(W, {
      construct(T, args, newTarget) {
        const w = Reflect.construct(T, args, newTarget);
        workerUrls.set(w, args[1]?.name ? `${String(args[0])} (${args[1].name})` : String(args[0]));
        return w;
      },
    });
    const post = W.prototype.postMessage;
    W.prototype.postMessage = function (msg, ...rest) {
      const blobs = new Set();
      const look = (v) => { if (v instanceof env.Blob) blobs.add(v); };
      look(msg);
      if (msg && typeof msg === 'object' && !(msg instanceof env.Blob)) {
        for (const v of Array.isArray(msg) ? msg : Object.values(msg)) { look(v); if (Array.isArray(v)) v.forEach(look); }
      }
      const transfer = Array.isArray(rest[0]) ? rest[0] : rest[0]?.transfer;
      if (Array.isArray(transfer)) transfer.forEach(look);
      for (const b of blobs) {
        if (isSource(b) || b.size >= minBytes) push(state.workerPosts, { t: env.now(), worker: workerUrls.get(this) ?? 'unknown worker', bytes: b.size, source: isSource(b) });
      }
      return post.call(this, msg, ...rest);
    };
  }
  if (env.document) {
    env.document.addEventListener('change', (e) => {
      const files = e.target?.files;
      if (e.target?.type === 'file' && files) for (const f of files) markSource(f);
    }, { capture: true });
  }
  env.target.__oomProbeTracker = { markSource, report: () => JSON.parse(JSON.stringify(state)) };
  return env.target.__oomProbeTracker;
}

/**
 * Turn a tracker report into counts and timeline events relative to the file pick.
 * `report` null means the instrumentation did not report: every count is null.
 */
export function trackerSummary(report, pickAt) {
  if (!report?.installed) {
    return { reported: false, sourceReads: null, sourceReadBytes: null, largeSourceReads: null, unattributedReads: null, unattributedBytes: null, sourcePosts: null, otherPosts: null, events: [] };
  }
  const large = report.sourceReads.filter((r) => r.whole || r.bytes >= (1 << 20));
  const ms = (t) => t - pickAt;
  return {
    reported: true,
    sourceMarked: report.sourcesMarked > 0,
    sourceReads: report.sourceReads.length,
    sourceReadBytes: report.sourceReads.reduce((n, r) => n + r.bytes, 0),
    largeSourceReads: large.length,
    unattributedReads: report.unattributedReads.length,
    unattributedBytes: report.unattributedReads.reduce((n, r) => n + r.bytes, 0),
    sourcePosts: report.workerPosts.filter((p) => p.source).length,
    otherPosts: report.workerPosts.filter((p) => !p.source).length,
    events: [
      ...report.sourceReads.map((r) => ({ ms: ms(r.t), event: 'source-read', bytes: r.bytes, via: r.via, whole: r.whole, large: r.whole || r.bytes >= (1 << 20) })),
      ...report.unattributedReads.map((r) => ({ ms: ms(r.t), event: 'unattributed-read', bytes: r.bytes, via: r.via })),
      ...report.workerPosts.map((p) => ({ ms: ms(p.t), event: 'worker-post', worker: p.worker, bytes: p.bytes, source: p.source })),
    ],
  };
}
