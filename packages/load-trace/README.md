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

On the main thread, `enableWorkerTrace(worker, trace, 'geom-0')` turns
recording on (it sends nothing when tracing is off), and `isTraceSpansMessage`
recognises the replies to pass to `trace.merge`.
