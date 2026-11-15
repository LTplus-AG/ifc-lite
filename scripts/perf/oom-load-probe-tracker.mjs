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
 * @param {number} [env.minBytes]   unattributed-read threshold (default 1 MiB, a documented limit)
 * @param {number} [env.keepEvents] detailed log keeps this many first and last events per kind (default 100)
 */
export function installSourceTracker(env) {
  const minBytes = env.minBytes ?? 1 << 20;
  const largeBytes = 1 << 20;
  const keep = env.keepEvents ?? 100; // detailed log keeps the first `keep` and last `keep` events
  const sources = new WeakSet(), derived = new WeakSet(), workerUrls = new WeakMap();
  // Event log with a bounded head and tail; totals and verdict facts never depend on it.
  const log = () => ({ head: [], tail: [], dropped: 0 });
  const add = (l, e) => {
    if (l.head.length < keep) { l.head.push(e); return; }
    l.tail.push(e);
    if (l.tail.length > keep) { l.tail.shift(); l.dropped++; }
  };
  const state = {
    installed: true, sourcesMarked: 0, sourceBytes: null,
    // Uncapped counters, incremented for every event.
    counts: { sourceReads: 0, sourceReadBytes: 0, largeSourceReads: 0, unattributedReads: 0, unattributedBytes: 0, sourcePosts: 0, otherPosts: 0 },
    // Facts the verdicts depend on, kept regardless of the log.
    facts: { firstSourceRead: null, firstLargeSourceRead: null, largestSourceRead: null, firstUnattributedRead: null, firstSourcePost: null, firstOtherPost: null },
    logs: { sourceReads: log(), unattributedReads: log(), workerPosts: log() },
  };
  const isSource = (b) => b != null && (sources.has(b) || derived.has(b));
  const markSource = (file) => {
    if (file && !sources.has(file)) { sources.add(file); state.sourcesMarked++; state.sourceBytes = file.size; }
  };
  const read = (b, via) => {
    if (!b || typeof b.size !== 'number') return;
    const c = state.counts, f = state.facts;
    if (isSource(b)) {
      const whole = sources.has(b);
      const e = { t: env.now(), bytes: b.size, via, whole, large: whole || b.size >= largeBytes };
      c.sourceReads++; c.sourceReadBytes += b.size;
      f.firstSourceRead ??= e;
      if (e.large) { c.largeSourceReads++; f.firstLargeSourceRead ??= e; }
      if (!f.largestSourceRead || e.bytes > f.largestSourceRead.bytes) f.largestSourceRead = e;
      add(state.logs.sourceReads, e);
    } else if (b.size >= minBytes) {
      const e = { t: env.now(), bytes: b.size, via };
      c.unattributedReads++; c.unattributedBytes += b.size;
      f.firstUnattributedRead ??= e;
      add(state.logs.unattributedReads, e);
    }
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
        const source = isSource(b);
        if (!source && b.size < minBytes) continue;
        const e = { t: env.now(), worker: workerUrls.get(this) ?? 'unknown worker', bytes: b.size, source };
        if (source) { state.counts.sourcePosts++; state.facts.firstSourcePost ??= e; } else { state.counts.otherPosts++; state.facts.firstOtherPost ??= e; }
        add(state.logs.workerPosts, e);
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
  const flat = (l) => ({ events: l.head.concat(l.tail), dropped: l.dropped });
  env.target.__oomProbeTracker = {
    markSource,
    report: () => JSON.parse(JSON.stringify({ ...state, logs: { sourceReads: flat(state.logs.sourceReads), unattributedReads: flat(state.logs.unattributedReads), workerPosts: flat(state.logs.workerPosts) } })),
  };
  return env.target.__oomProbeTracker;
}

/**
 * Turn a tracker report into counts, verdict facts and timeline events relative to the
 * file pick. Counts and facts come from the uncapped counters, never from the event log;
 * `truncated`/`dropped` say whether the detailed log lost events. `report` null means the
 * instrumentation did not report: every count and fact is null.
 */
export function trackerSummary(report, pickAt) {
  if (!report?.installed) {
    return { reported: false, sourceMarked: null, sourceReads: null, sourceReadBytes: null, largeSourceReads: null, unattributedReads: null, unattributedBytes: null,
      sourcePosts: null, otherPosts: null, facts: null, truncated: null, dropped: null, events: [] };
  }
  const ms = (t) => t - pickAt;
  const at = (e, extra = {}) => (e ? { ms: ms(e.t), bytes: e.bytes, ...extra } : null);
  const f = report.facts, c = report.counts, L = report.logs;
  const dropped = L.sourceReads.dropped + L.unattributedReads.dropped + L.workerPosts.dropped;
  return {
    reported: true,
    sourceMarked: report.sourcesMarked > 0,
    ...c,
    facts: {
      firstSourceRead: at(f.firstSourceRead, { whole: f.firstSourceRead?.whole }),
      firstLargeSourceRead: at(f.firstLargeSourceRead, { whole: f.firstLargeSourceRead?.whole }),
      largestSourceRead: at(f.largestSourceRead, { whole: f.largestSourceRead?.whole }),
      firstUnattributedRead: at(f.firstUnattributedRead),
      firstSourcePost: at(f.firstSourcePost, { worker: f.firstSourcePost?.worker }),
      firstOtherPost: at(f.firstOtherPost, { worker: f.firstOtherPost?.worker }),
    },
    truncated: dropped > 0,
    dropped,
    events: [
      ...L.sourceReads.events.map((r) => ({ ms: ms(r.t), event: 'source-read', bytes: r.bytes, via: r.via, whole: r.whole, large: r.large })),
      ...L.unattributedReads.events.map((r) => ({ ms: ms(r.t), event: 'unattributed-read', bytes: r.bytes, via: r.via })),
      ...L.workerPosts.events.map((p) => ({ ms: ms(p.t), event: 'worker-post', worker: p.worker, bytes: p.bytes, source: p.source })),
    ],
  };
}
