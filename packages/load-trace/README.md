# @ifc-lite/load-trace

Dependency-free load tracing for the ifc-lite viewer. A load gets one span
tree that spans the main thread and its workers, every finished span is
mirrored into the browser's User Timing buffer as an `ifc:<name>` measure, and
the whole tree exports as Chrome-trace JSON (DevTools, Perfetto,
chrome://tracing).

Tracing is opt-in. A disabled tracer hands out a trace whose methods are empty
functions (`milestone` and `finish` still return elapsed milliseconds), so
instrumented call sites cost one no-op call when tracing is off.

## Main thread

```ts
import { createLoadTracer } from '@ifc-lite/load-trace';

const tracer = createLoadTracer({ enabled: true });
const trace = tracer.startLoad('model-1', { journey: 'J1', modelKind: 'primary' });

const bytes = await trace.span('file.read', () => fetch('/model.ifc').then((r) => r.arrayBuffer()));
const firstPaintMs = trace.milestone('geometry.firstVisible'); // span from load start
trace.finish({ loadPath: 'wasm' });

console.log(bytes.byteLength, firstPaintMs, tracer.latest());
```

- `begin(name)` / `end(token)` open and close a span; `span(name, fn)` times a
  function and, when it returns a promise, ends the span when the promise
  settles.
- `record(name, start, end)` stores an interval the caller already measured.
- `milestone(name, atMs?)` records a span from the load start, so its measure
  duration is the time-to-milestone. Only the first call per name is recorded.
- `setAttrs` / `finish(attrs)` set load attributes (`journey`, `modelKind`,
  `cacheTier`, `loadPath`, `workerCount`).
- `snapshots()` / `latest()` return JSON-safe copies; `buildSpanTree` nests a
  snapshot by parent, `toChromeTrace` renders snapshots as Chrome-trace JSON.

## Workers

A worker's `performance.now()` counts from the worker's creation, not the
page's. Spans recorded in a worker therefore travel with the worker's
`performance.timeOrigin`, and `trace.merge(payload)` shifts them onto the main
thread's clock.

```ts
import { createWorkerTraceHost } from '@ifc-lite/load-trace';

const traced = createWorkerTraceHost({
  spanNames: { 'scan-shard': 'shard.scan' },
  post: (message) => self.postMessage(message),
});
self.onmessage = (e) => { void traced(e.data, async () => { /* handle e.data */ }); };
```

For phases inside one long handler, `createWorkerPhaseTrace` records spans
the handler opens itself (`begin`/`end`, `span`, and `step` for sequential
phases such as a parser's progress callback) and posts them on `flush()`. Call
`flush()` before any message the main thread answers with `terminate()`:
spans posted after it die with the worker.

```ts
import { createWorkerPhaseTrace } from '@ifc-lite/load-trace';

const phases = createWorkerPhaseTrace({ post: (message) => self.postMessage(message) });
self.onmessage = (e) => {
  if (phases.accept(e.data)) return; // the enable request
  const whole = phases.begin('parse');
  phases.step('scan');
  phases.step('index');
  phases.step(null);
  phases.end(whole);
  phases.flush(); // before posting `complete`
};
```

On the main thread, `enableWorkerTrace(worker, trace, 'geom-0')` turns
recording on (it sends nothing when tracing is off), and `isTraceSpansMessage`
recognises the replies to pass to `trace.merge`.

## Structural counters and main-thread health (#6957)

`perfCounters` is one counter registry per JS realm (kept on `globalThis`, so
two bundled copies of the package share it). It is off until a recording
tracer switches it on; until then `perfCount(name, n)` is one boolean test.
Each load's snapshot carries `counters`: what moved from its start until the
next load started (or the snapshot was taken), plus everything its workers
posted back (`workerCounters`, per worker thread).

```ts
import { accountWorkerMessages, countCopy, createLoadTracer, meterTypedArrayArgs, perfTally, startFrameMonitor } from '@ifc-lite/load-trace';

declare const url: URL;        // the worker script
declare const vertices: number; // merged vertex count
const tracer = createLoadTracer({ enabled: true, frames: startFrameMonitor() });
const worker = accountWorkerMessages(new Worker(url), 'geometry'); // msg.geometry.{out,in}.*
const copy = countCopy('source.zip', bytes.slice().buffer);           // copy.source.zip.{count,bytes}
const api = meterTypedArrayArgs(new IfcAPI(), 'wasm');                // wasm.<method>.{calls,bytes}
perfTally('render.mergeGeometry', vertices, 'vertices');              // render.mergeGeometry.{count,vertices}
```

- `accountWorkerMessages` patches `postMessage` and listens for replies:
  message counts, estimated structured-clone bytes, transferred bytes
  (outbound), received ArrayBuffer bytes (inbound: the receiver cannot tell a
  transfer from a clone) and SharedArrayBuffer bytes, per direction.
- In a worker, `createWorkerTraceHost` switches the worker's registry on with
  tracing and posts its increments after every handler; `host.flush()` posts
  them early when the main thread is about to terminate the worker.
- `startFrameMonitor` observes `long-animation-frame` and `longtask`
  (feature-detected). `snapshot().mainThread` sums each type over the load
  window and attributes LoAF blocking time to the innermost main-thread span
  open when each frame started.
- With counters off, every wrapper returns its target unchanged.
