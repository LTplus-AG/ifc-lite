# @ifc-lite/sandbox

## 2.1.0

### Minor Changes

- [#2424](https://github.com/LTplus-AG/ifc-lite/pull/2424) [`dae94e2`](https://github.com/LTplus-AG/ifc-lite/commit/dae94e23f7514945ca60f7074f50f196a90dfc5d) Thanks [@louistrue](https://github.com/louistrue)! - Cancel clash detection when the script run that asked for it ends.

  A sandbox run that exceeded `limits.timeoutMs`, or a sandbox disposed mid-run, stopped _waiting_ for `bim.clash.run` / `bim.clash.matrix` but never stopped the engine: it kept intersecting geometry to completion in the background, on the user's machine, for a result that was discarded on arrival. The bridge now hands every call an `AbortSignal` and aborts it on both paths, and the clash namespace forwards it as `ClashSettings.signal`.

  `@ifc-lite/sandbox` is a minor rather than a patch because `BridgeCallContext.hostSignal` is new capability surface for schema authors, reachable through the `@ifc-lite/sandbox/schema` subpath. Nothing was removed or renamed.

  `ClashSettings.signal` also now works the way its name implies. The TypeScript engine checked it periodically but only yielded to the event loop when an `onProgress` callback was supplied — and every realistic canceller (a deadline timer, a cancel button, a host teardown) fires _from_ the event loop, so without `onProgress` the flag could never flip mid-run. A caller that supplies a signal now gets the periodic yields too, the check runs every 256 candidate pairs rather than every 1024, and the signal is rechecked immediately after each yield, since the yield is the window the abort arrives in.

  One bound is worth stating plainly: those handlers can only run during a yield, and the first yield comes after ~50 ms of held thread time, so a run that finishes inside that window completes rather than cancelling. Cancellation is for runs long enough to be worth cancelling.

  No API changed shape: `ClashSettings.signal` already existed, and cancellation stays opt-in for direct engine callers.

- [#2170](https://github.com/LTplus-AG/ifc-lite/pull/2170) [`b57f04c`](https://github.com/LTplus-AG/ifc-lite/commit/b57f04c45082bad7269e7f103f361b0947435cc4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Sandbox: serialize `eval()` per sandbox, and contain the upstream QuickJS teardown abort.

  `Sandbox.eval` no longer runs overlapping calls concurrently. The bridge's log buffer, its byte budget and the `truncated` flag are built once per sandbox and shared by every run, and `eval()` resets them before each script — so two overlapping calls fought over one buffer and either run's `ScriptResult.logs` could come back short, empty, or carrying the other run's entries. Each call now queues behind the one before it on a per-sandbox promise chain. Sequential callers see no change; a caller that fanned out concurrent evals on one sandbox now gets serialized execution and correct per-run logs. A failed run does not block the runs queued behind it.

  `Sandbox.dispose()` now reports the upstream `JS_FreeRuntime` abort as a `SandboxAbortError` naming the condition and the issue, instead of a bare emscripten assertion. That abort is upstream (`quickjs-emscripten`) and still cannot be prevented from here: an out-of-memory inside a drained promise job orphans objects with leaked refcounts, and forcing collection, lifting the memory limit, re-draining the job queue and skipping the context free were each measured — in a fresh process per trial — to abort anyway.

  New exports supporting that:

  - `SandboxAbortError` — thrown by `dispose()` when the runtime free aborts.
  - `isSandboxRuntimeAborted()` — whether an abort has occurred in this process. It matters because emscripten latches its `ABORT` flag: only the _first_ abort throws, so every later broken teardown reports a false clean. A host that cares should reload rather than keep trusting sandbox teardown.
  - `Sandbox.disposed` — a disposed sandbox now rejects `eval()` with "Sandbox disposed" instead of the misleading "Sandbox not initialized. Call init() first." That holds for a `dispose()` arriving _during_ a run too: disposal is re-checked after the TypeScript transpile, which is the run's only suspension point, so a React cleanup firing mid-eval rejects with "Sandbox disposed" rather than `TypeError: Cannot read properties of null (reading 'evalCode')`. Runs queued behind it settle with the same error. `init()` is guarded the same way on both sides of its own suspension point (`await getModule()`): a disposed sandbox — including one disposed while `createSandbox()` was still in flight — now rejects `init()` with "Sandbox disposed" instead of building a QuickJS runtime, context and bridge that nothing will ever run in and nothing will ever free.

- [#2387](https://github.com/LTplus-AG/ifc-lite/pull/2387) [`0671811`](https://github.com/LTplus-AG/ifc-lite/commit/0671811856888b8b930d3068166cff286a21a8c2) Thanks [@louistrue](https://github.com/louistrue)! - Deliver async bridge results into the sandbox as real promises, and validate `ClashElement.tag` at the boundary ([#2305](https://github.com/LTplus-AG/ifc-lite/issues/2305)).

  A schema method whose `call` returns a Promise — `bim.clash.run` and `bim.clash.matrix` — was marshalled as an ordinary object, so the script received `{}` and the host work carried on unobserved. When it failed, the rejection escaped as an unhandled host rejection: a `ClashElement` without its `tag` produced an uncaught `TypeError: Cannot read properties of undefined (reading 'toUpperCase')` that killed the script run.

  Host promises are now handed to the realm via `vm.newPromise()` and settled between QuickJS job drains, bounded by the run's own timeout, so `await bim.clash.run(...)` returns the real result and a host rejection arrives as a catchable `bim.<namespace>.<method>: <message>` script error. `buildBridge` returns an additional `hostWork` queue for that drain. `bim.clash.run` / `bim.clash.matrix` also reject a `ClashElement` without a `tag` up front, naming the element index instead of failing deep inside the engine.

  Behaviour change for fire-and-forget scripts: a script that calls `bim.clash.run(...)` without awaiting it used to return instantly (with `{}`), because the host work was never waited on. `eval()` now waits for in-flight host work before resolving, bounded by the run's `timeoutMs`, so such a script takes as long as the work it started — or reports `interrupted` if that exceeds the budget.

  Also fixed alongside it: disposing a sandbox while a run is parked on host work used to leave the eval-result handle alive, which made `runtime.dispose()` trip the `JS_FreeRuntime` assertion and poison the shared WASM module for the rest of the document (the [#1922](https://github.com/LTplus-AG/ifc-lite/issues/1922) failure mode); a run that gives up waiting no longer makes every later run on the same sandbox wait for the same stalled promise; and an error message that already names its own method is no longer prefixed twice (`bim.clash.run: bim.clash.run: ...`).

  An async method's resolved value is converted by its own declared `returns` type, the same `marshalReturn` treatment the synchronous path applies, so a `returns: 'string'` or `returns: 'void'` method cannot diverge from its schema just because it is asynchronous. The rejection path can no longer strand a guest promise when the rejection value resists description (a throwing `toString` / `Symbol.toPrimitive`), and the `tag` validator describes a rejected value without `JSON.stringify`, which threw on a `bigint` and rendered `symbol`, `function` and `undefined` alike.

- [#2437](https://github.com/LTplus-AG/ifc-lite/pull/2437) [`a803c35`](https://github.com/LTplus-AG/ifc-lite/commit/a803c3599d777669341b69309e7dab20cdf16db0) Thanks [@louistrue](https://github.com/louistrue)! - Give `bim.clash` a real declared type surface, and stop the generated `bim` declarations from needing a hand-maintained copy of another package's types.

  Every `bim.clash` method was declared `Promise<unknown>` / `unknown[]` while the runtime returned a fully structured `ClashResult`. Sandbox scripts could not read `result.clashes` or `result.summary.total` off the declared type without a cast, even though both demonstrably exist — a declaration that lied by omission. `run` and `matrix` are now `Promise<BimClash.ClashResult>`, `group` takes `Pick<BimClash.ClashResult, "clashes"> & Partial<BimClash.ClashResult>` — exactly what the runtime accepts, since the guard requires only a `clashes` array — and returns `BimClash.ClashGroup[]`, `disciplineRules` returns `BimClash.ClashRule[]`, and `presets` returns `BimClash.ClashRulePreset[]` (a preset is the discipline _pair_, not a runnable rule). Narrowing `unknown` breaks nothing: nothing useful could be done with the old type, and `group` already rejected any argument without a `clashes` array.

  Those `BimClash.*` declarations are **extracted** from `packages/clash/src` by `scripts/generate-bim-globals.mjs` rather than transcribed into it, so `pnpm check:bim-globals` goes red when the engine's types change, and a type the surface reaches but the generator cannot resolve is a hard error instead of a silent omission.

  Also adds `SANDBOX_CONSOLE_LEVELS` and the `SandboxConsoleLevel` type as the single source for the console the sandbox installs, the `level` a `LogEntry` carries, and the generated ambient `console` declaration.

  **Why minor and not major** (raised in review on [#2437](https://github.com/LTplus-AG/ifc-lite/issues/2437), for `bim.clash.group`). The narrowed signatures are `tsReturn` / `tsParamTypes` **string values** inside `NAMESPACE_SCHEMAS`, read by a code generator. They are not TypeScript types in this package, and they materialise only in `apps/viewer/.../bim-globals.d.ts` — an unpublished app file of ambient declarations for user-authored sandbox scripts. `MethodSchema` still declares `tsReturn?: string` and `tsParamTypes?: (string | undefined)[]`, unchanged.

  So the published delta for a package consumer is: two additive exports, plus `LogEntry.level` restated as `SandboxConsoleLevel` — which resolves to `'log' | 'warn' | 'error' | 'info'`, the identical union, mutually assignable with what it replaced. Nothing is removed or renamed, which is what the house rule ties `major` to at >=1.0 (this package is 2.0.1).

  On the specific claim: `group` was `unknown[]` before this change, so its return goes `unknown[]` -> `ClashGroup[]`. That is a **narrowing of a return type** — covariant, so existing code holding the result as `unknown[]` still compiles.

  The direction that _would_ break callers is the parameter, since narrowing there is contravariant. Review caught it, and it was fixed rather than argued away: the parameter is `Pick<BimClash.ClashResult, "clashes"> & Partial<BimClash.ClashResult>`, which accepts everything the runtime accepts (the guard requires only a `clashes` array), so there is no contravariant break left to weigh.

### Patch Changes

- [#2334](https://github.com/LTplus-AG/ifc-lite/pull/2334) [`c777cad`](https://github.com/LTplus-AG/ifc-lite/commit/c777cadde939b4bc84b08bc0366d54d34601d66c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `bim.store.addBeam` accepting `storeyExpressId: 0` in a sandboxed script. Every other `bim.store.addX` method (`addColumn`, `addWall`, `addSlab`, `addDoor`, `addWindow`, `addSpace`, `addRoof`, `addPlate`, `addMember`) shares `requireStoreyId`, which rejects `storeyExpressId <= 0` since EXPRESS ids are 1-based and `#0` is never a valid reference. `addBeam` alone duplicated the check inline and only rejected negative values, letting `0` through with a less specific downstream error (`resolveSpatialAnchor: storey #0 has no resolvable IfcLocalPlacement` instead of the bridge's own "storeyExpressId must be a positive integer" message). No entity was ever created either way — `resolveSpatialAnchor` throws before any STEP records are emitted — so this was an error-message inconsistency, not silent data corruption. `addBeam` now uses the same shared `requireStoreyId` helper as its siblings.

- [#2420](https://github.com/LTplus-AG/ifc-lite/pull/2420) [`07d5309`](https://github.com/LTplus-AG/ifc-lite/commit/07d53098b7e9099152300e705d8a41430831f81c) Thanks [@louistrue](https://github.com/louistrue)! - Fix the grammar of the `bim.clash.group` doc string: it now reads "By default, grouping uses `cluster`." The string is user-visible — it feeds the script editor's completions, the generated `bim` type surface, and the LLM system prompt. No API change.

- [#2449](https://github.com/LTplus-AG/ifc-lite/pull/2449) [`5d763d6`](https://github.com/LTplus-AG/ifc-lite/commit/5d763d6bde10c0232cbf28e7d8e4e956ebaf4ff1) Thanks [@louistrue](https://github.com/louistrue)! - Record why `EntityRelationshipsData`'s field names and the sandbox's dual-cased entity fields are not IFC-fidelity violations, so they stop being re-litigated.

  `voids` / `fills` / `groups` / `connections` hold the related **objects**, never the `IfcRel*` entities: `voids` is the `IfcOpeningElement`s that void a host, `fills` the `IfcOpeningElement` a filler sits in. Renaming them to `IfcRelVoidsElement` / `IfcRelFillsElement` would name each field after a type none of its members has, and IFC's own names for these traversals (`HasOpenings`, `FillsVoids`, `HasAssignments`, `ConnectedTo`) are inverse attributes holding the `IfcRel*` entity — so "use the exact EXPRESS name" has no name to offer. `openings` fails too, because `voids` **and** `fills` both hold `IfcOpeningElement`s and only the voids/fills pair distinguishes the two directions. `EntityRelationshipsData` now carries that reasoning, pinned by a parser test.

  `withAliases` keeps emitting every entity attribute under both spellings; its doc now names PascalCase as the canonical form (it is the EXPRESS spelling of `GlobalId`, `Name`, `Description` and `ObjectType`) and states why the camelCase half is kept rather than deprecated: sandbox scripts are user-authored with no version channel, and the script editor is CodeMirror with no TypeScript service, so a `@deprecated` tag would reach no one while a removal would break saved scripts silently at runtime. A new test pins the two spellings as symmetric — every attribute present under both, carrying one value — which an exact-shape assertion alone does not guarantee once a seventh attribute is added.

  **Scope for these two packages: documentation and tests only** — no runtime, signature or shape change in `@ifc-lite/sdk` or `@ifc-lite/sandbox`.

  The PR does migrate runtime code, but not in a published package. `apps/viewer`'s built-in template `construction-schedule.ts` moves from `e.type` / `e.globalId` to the canonical `e.Type` / `e.GlobalId` (identical values; it was the only shipped template still reading a `BimEntity` under the camelCase spelling). `@ifc-lite/viewer` is `"private": true` and carries no changeset for the same reason `apps/viewer/.../bim-globals.d.ts`, regenerated here, carries none: nothing in it is published to a registry.

- Updated dependencies [[`8d1972d`](https://github.com/LTplus-AG/ifc-lite/commit/8d1972d059fe5e8725fffbf661cc56bb6a23767b), [`5d763d6`](https://github.com/LTplus-AG/ifc-lite/commit/5d763d6bde10c0232cbf28e7d8e4e956ebaf4ff1)]:
  - @ifc-lite/sdk@2.0.3

## 2.0.1

### Patch Changes

- [#2062](https://github.com/LTplus-AG/ifc-lite/pull/2062) [`996f50f`](https://github.com/LTplus-AG/ifc-lite/commit/996f50f6749182f3eb3465bd390ce75fe68e549c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a double-free in `Sandbox.dispose()` when QuickJS teardown fails.

  An out-of-memory or CPU-timeout exception raised inside a drained promise job — an `async function run()` entry point that allocates, for example — leaves QuickJS holding objects with leaked refcounts. Upstream `JS_FreeRuntime` then trips `assert(list_empty(&rt->gc_obj_list))` and throws out of `runtime.dispose()` part-way through freeing the runtime (that abort is upstream in quickjs-emscripten and is not fixed here). `dispose()` left its `runtime` field set afterwards, so every later call — a React cleanup, an extension unload, a defensive re-dispose — re-entered `JS_FreeRuntime` on the same half-freed runtime.

  `dispose()` now clears each field before freeing it, so a step that throws is never retried. The failure is still reported to the caller.

- [#2081](https://github.com/LTplus-AG/ifc-lite/pull/2081) [`5befec5`](https://github.com/LTplus-AG/ifc-lite/commit/5befec5b6b73d2293f058b3c010c8553429f6178) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Derive the `esbuild.wasm` CDN fallback URL from the loaded `esbuild-wasm` host version instead of a hard-coded one.

  `transpile.ts` asked unpkg for `esbuild-wasm@0.27.3/esbuild.wasm` under a comment claiming it was "version-pinned to match installed package", while the package depended on `^0.28.1` and resolved 0.28.1. `esbuild.initialize()` rejects a host/binary version mismatch outright ("Host version does not match binary version"), so that fallback could not start: every embedder reaching it dropped to the regex transpiler instead of esbuild. A hard-coded literal and a `^` range cannot stay in step by construction, so the URL now interpolates `esbuild.version` from the module that was just imported — the same host whose version `initialize()` checks — and there is nothing left to keep in sync. The dependency range is unchanged.

  The CDN branch is only reached under bundlers that do not implement Vite's `?url` asset hint; the first-party viewer builds with Vite and takes the bundled-asset path, so it was never affected.

  Covered by `transpile-wasm-url.test.ts`, which mocks `esbuild-wasm` with a fabricated version and asserts the URL follows it, so a re-introduced literal fails CI.

- [#2063](https://github.com/LTplus-AG/ifc-lite/pull/2063) [`1dade49`](https://github.com/LTplus-AG/ifc-lite/commit/1dade49f39833b1d95eb8c5b78297f77bbddca15) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Report a sandbox CPU timeout that hits an `async` script body instead of returning a stale value.

  QuickJS surfaces an interrupted top-level body as an eval error, so a script that spins in its main body already failed with `interrupted`. But an `async` function body runs as a promise job, and `executePendingJobs()` reports no error when the CPU deadline cuts one short — so `eval()` returned the value the main body had produced before the job ran and reported success. A script whose real work happened inside `async function run()` could therefore time out and still look like it had completed.

  The sandbox now records whether its interrupt handler actually fired and, after draining the job queue, raises the same `ScriptError: interrupted` the main-body path already raises. Scripts whose jobs complete normally are unaffected and still return the main-body value.

- [#2096](https://github.com/LTplus-AG/ifc-lite/pull/2096) [`9b53852`](https://github.com/LTplus-AG/ifc-lite/commit/9b53852464b1329733cd954754923b16abf9060d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop captured log entries that cannot be sized from escaping the sandbox's host-memory budget.

  The bridge caps captured console output twice: by entry count (1000) and by cumulative serialized size (4 MB), because `vm.dump` copies sandbox values onto the host heap, which the QuickJS memory limit does not bound. The size charge came from `JSON.stringify`, and when that threw the entry was charged zero bytes and retained anyway. A top-level `BigInt` is the value that reaches the host in that state — it survives `vm.dump` intact but has no JSON form, and QuickJS will allocate one of a million bits — so a script could park up to 1000 such values, tens of megabytes, that the byte budget never saw. (An object the VM cannot serialize never got that far: `vm.dump` already flattens it to the string `"[object Object]"`.)

  The bridge now refuses to retain what it cannot size. When sizing an entry fails, each argument is sized on its own: arguments that serialize are kept untouched, and only those that do not are replaced by bounded text, charged at exactly the length of that text. Retained memory is therefore always what the budget can see. Serializable logs are sized and capped exactly as before.

  **Embedder-visible:** `LogEntry.args` no longer contains `BigInt` values. A small BigInt is retained as its literal text (`42n`), a very large one as `[BigInt too large to retain]`; other arguments on the same line are unaffected, so the log still shows which script logged what. The failure is reported to the host console once per sandbox context — not once per entry, since the trigger is script-supplied.

- [#2118](https://github.com/LTplus-AG/ifc-lite/pull/2118) [`b47928f`](https://github.com/LTplus-AG/ifc-lite/commit/b47928f9c684413a8762330320c6ebaf02ffbbeb) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Make the captured-log byte budget an actual ceiling.

  The bridge caps captured console output by cumulative serialized size (4 MB), because `vm.dump` copies sandbox values onto the host heap, which the QuickJS memory limit does not bound. The check ran _before_ an entry was sized: it compared the running total against the budget, then retained the entry unconditionally, so a single oversized argument (e.g. one `console.log` of a 40 MB string) was retained in full — the check only caught up on the next call, by which point the overshoot was already on the host heap and bounded only by whatever the script chose to log.

  The check now runs against the entry about to be added, before it is retained: an entry that would push the cumulative total over the 4 MB budget is refused and replaced by the truncation marker instead of being kept. This is a deliberate behavior change — a script logging one very large payload now sees truncation on that call rather than after it, and the existing boundary test's expectations moved accordingly (three full 1 MB entries plus a marker, not four).

  The entry-count cap (1000 entries) is unchanged: it increments by exactly one per call, so its overshoot was already bounded to a single entry and does not have the same unbounded-overshoot shape.

- [#2103](https://github.com/LTplus-AG/ifc-lite/pull/2103) [`d1d82aa`](https://github.com/LTplus-AG/ifc-lite/commit/d1d82aae99386505917a68551f033299ed8b4924) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Reset the captured-log budget on every `eval()`, so one log-heavy script no longer silences every later script on the same sandbox.

  The bridge caps captured console output twice — by entry count (1000) and by cumulative serialized size (4 MB) — because `vm.dump` copies sandbox values onto the host heap, which the QuickJS memory limit does not bound. `eval()` clears the log buffer in place at the start of every run and hands each result its own copy, so the caps bound one run's output; but `totalBytes` and the `truncated` latch were closed over at construction and never reset. Once a script tripped either cap, `truncated` stayed `true` for the life of the sandbox and the console handlers returned immediately, so every subsequent `eval()` on that sandbox produced **no log entries at all** — not even the truncation marker, which is pushed only on the run that trips the cap.

  This affects embedders that reuse a sandbox across evals, which is the normal path for two of them: `bim.sandbox.eval()` keeps one `activeSandbox` alive across calls, and the extension host holds one sandbox per activated extension and re-enters it for every command and exporter invocation. (The viewer's script editor creates a fresh sandbox per run and was never affected.) The observable symptom was a script whose `console.log` calls appeared not to fire, with nothing to indicate the limit belonged to an earlier run.

  `buildConsole` now owns the reset: it returns a `resetLogs()` that empties the buffer _and_ zeroes both counters, and `eval()` calls only that instead of clearing the array itself — the two can no longer drift apart. A single script that genuinely exceeds either cap is truncated exactly as before.

  **Embedder-visible:** captured output is now bounded per eval rather than per sandbox, so a long-lived sandbox can hand back up to 4 MB of logs per run instead of 4 MB in total. Embedders that retain every `ScriptResult` across many runs hold correspondingly more. `buildBridge()`, exported for advanced embedders, gains a `resetLogs` property on its return value; existing callers are unaffected.

- [#2078](https://github.com/LTplus-AG/ifc-lite/pull/2078) [`1303515`](https://github.com/LTplus-AG/ifc-lite/commit/1303515b8aa87cd6e8215ecf88fdf5a406b545d8) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Report a script that hands back a rejected promise as a failure instead of a successful run ([#2077](https://github.com/LTplus-AG/ifc-lite/issues/2077)).

  The extension host wraps an entry file as `return activate(ctx)`, so when the entry is `async` the eval result IS the promise. A throw after its first `await` settles that promise as _rejected_ without ever touching `result.error` — the main body succeeded, so `eval()` reported success and `vm.dump` rendered the rejection as ordinary data (`{ type: 'rejected', error: … }`) in `ScriptResult.value`. A script whose async entry point threw therefore looked like a clean pass.

  Draining the job queue cannot close this: `executePendingJobs()` documents that it does not return errors thrown inside `async` functions or rejected promises — QuickJS captures those in the promise itself — so the promise's own state is the only signal. After draining, the sandbox now reads that state and raises the same `ScriptError` (with the rejection reason as the message, plus logs and `durationMs`) the main-body error path already raises, freeing the settled-value and rejection handles on every exit so teardown stays clean.

  The check runs _after_ the interrupt flag added for the CPU-timeout case, so a job cut short by the deadline still reports as `interrupted` rather than as a generic rejection. Scripts whose promises fulfil, and scripts that return a non-promise value, are unaffected and still report success with the same value.

  **Behaviour change for embedders.** An `eval()` that previously _resolved_ — carrying the rejection as data in `value` — now throws a `ScriptError`. Code that relied on it resolving, and so caught nothing, will start seeing that error propagate. That is the point of the fix, but it lands on a patch bump, so it is worth knowing before upgrading.

  Not covered: a rejection in a promise the script never hands back (`run(); 'started'`) remains invisible — quickjs-emscripten 0.32 exposes no host promise-rejection tracker (`RuntimeOptions.promiseRejectionHandler` is unimplemented), so there is no handle to inspect.

- [#2095](https://github.com/LTplus-AG/ifc-lite/pull/2095) [`e03d879`](https://github.com/LTplus-AG/ifc-lite/commit/e03d879a96ba9a5818a7264d713237833e201ba3) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop a caught `ScriptError`'s `logs` from being emptied by the next `eval()` ([#2092](https://github.com/LTplus-AG/ifc-lite/issues/2092)).

  `ScriptError` stored the constructor's `logs` argument by reference, and every `ScriptError` is constructed with the sandbox's single log buffer — the same array `Sandbox.eval()` clears in place (`this.logs.length = 0`) at the start of each run. An embedder that caught an error, kept it for a retry or a report, and then ran another script found the error's logs empty, after having already inspected them. `ScriptError` now copies the array at construction, so a caught error keeps the console output of the run that failed for as long as the error is held.

  Only the error path was affected: the success path already returned `logs: [...this.logs]`, and the two are now consistent. Sandboxes that never retain an error across evals see no change.

- [#2080](https://github.com/LTplus-AG/ifc-lite/pull/2080) [`a2787fa`](https://github.com/LTplus-AG/ifc-lite/commit/a2787fab292e50d60ed0081fd3d458e7555c5cb2) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Make the swallowed failures in the sandbox's transpile and console paths report their cause.

  `getEsbuild()` swallowed both the `esbuild.wasm?url` asset resolution and the `esbuild.initialize()` call. The first silently swaps a bundled asset for a `unpkg.com` network fetch — a change of behaviour a host embedding the sandbox has no other way to notice — and the second is the only place that still holds the reason esbuild is unavailable, which the caller's existing "using fallback transpiler" warning does not carry. Both now `console.warn` with the error; the fallback still happens exactly as before. The outer `transpileTypeScript` catch now passes its error to the warning it was already emitting.

  The bridge's per-entry log sizing (`JSON.stringify` against the host memory budget) swallowed serialization failures. A `BigInt` argument reaches it — `console.log(1n)` survives `vm.dump` but not `JSON.stringify` — and the entry was then silently charged zero bytes. It now warns, but at most once per sandbox context: the trigger is script-supplied, so a per-entry warning would let `for(;;) console.log(1n)` flood the host console. The entry is still captured and still charged zero, so the log output itself is unchanged. Covered by `bridge-console.test.ts`.

  No control flow changed at any of these sites — every fallback still falls back and every swallow still swallows, it just says so.

- Updated dependencies [[`6cbf69a`](https://github.com/LTplus-AG/ifc-lite/commit/6cbf69acb2163ab671c41df36878f4d4e490e244)]:
  - @ifc-lite/sdk@2.0.2

## 2.0.0

### Major Changes

- [#1979](https://github.com/LTplus-AG/ifc-lite/pull/1979) [`8f139a8`](https://github.com/LTplus-AG/ifc-lite/commit/8f139a8ef44235b68c2f97c032419fa586111b62) Thanks [@louistrue](https://github.com/louistrue)! - **BREAKING:** every `IfcCreator` element constructor now places its product relative to the storey it is added to. Element coordinates are storey-relative across the whole API.

  ## What was wrong

  `IfcCreator` chained the product's `IfcLocalPlacement` to a different parent depending on which method you called. Seven methods — `addIfcWall`, `addIfcSlab`, `addIfcColumn`, `addIfcBeam`, `addIfcStair`, `addIfcRoof`, `addIfcGableRoof` — chained to the storey placement, which carries `[0, 0, Elevation]`. The other 21 — `addIfcDoor`, `addIfcWindow`, `addIfcRamp`, `addIfcRailing`, `addIfcPlate`, `addIfcMember`, `addIfcFooting`, `addIfcPile`, `addIfcSpace`, `addIfcCurtainWall`, `addIfcFurnishingElement`, `addIfcBuildingElementProxy`, `addIfcCircularColumn`, `addIfcIShapeBeam`, `addIfcLShapeMember`, `addIfcTShapeMember`, `addIfcUShapeMember`, `addIfcHollowCircularColumn`, `addIfcRectangleHollowBeam`, `addElement`, `addAxisElement` — chained to the world.

  On a storey with a non-zero `Elevation`, a caller mixing the two families got two datums in one model, with no error and nothing downstream to notice. Measured on a real scan-to-IFC run: the storey and its spaces at −1.368653 m, the walls at −2.737307 m — exactly 2 × the elevation, standing 1.37 m below the spaces they bounded.

  Every one of these methods already took the storey as its first argument and already emitted an `IfcRelContainedInSpatialStructure` into it. Only the placement disagreed.

  ## Why storey-relative, and not world-relative

  The placement hierarchy has to agree with the containment hierarchy. A product contained in a storey whose placement chains past that storey to the world is not a coherent IFC product: moving the storey leaves its own contents behind, and `IfcBuildingStorey.Elevation` and the storey's `ObjectPlacement` become decoration that no geometry honours. The world-relative alternative would have meant deleting the storey's `[0, 0, Elevation]` placement or leaving it as a transform nothing chains to — the wrong half of the schema to surrender.

  It is also what the rest of this package already did: the `*ToStore` builders (`addWallToStore`, `addSpaceToStore`, `addDoorToStore`, …) have always chained from `anchor.storeyPlacementId`. Choosing world would have split `@ifc-lite/create` against itself.

  ## Migrating

  If your storeys all have `Elevation: 0`, nothing moves — the storey placement is the identity and the two parents were already the same point.

  Otherwise, for the 21 methods listed above: **stop adding the storey elevation to element coordinates.** Pass the height above that storey's floor.

  ```ts
  const storey = creator.addIfcBuildingStorey({
    Name: "Level 1",
    Elevation: 3.2,
  });

  // before — absolute Z, because addIfcSpace ignored the storey
  creator.addIfcSpace(storey, {
    Position: [0, 0, 3.2],
    Width: 4,
    Depth: 4,
    Height: 2.6,
  });

  // after — storey-relative Z, like addIfcWall always was
  creator.addIfcSpace(storey, {
    Position: [0, 0, 0],
    Width: 4,
    Depth: 4,
    Height: 2.6,
  });
  ```

  If you compensated for the asymmetry — passing absolute Z to the world-parented methods and storey-relative Z to the storey-parented ones, so the two families lined up — remove the compensation from the world-parented calls only. The storey-parented calls were already correct and must not change. A caller that had settled on `Z = 0` for walls and `Z = elevation` for spaces now passes `Z = 0` to both.

  `addIfcWallDoor` and `addIfcWallWindow` are unaffected: they were and remain wall-local, and inherit the storey datum through their host.

  Also in this release: `getStoreyPlacement` throws `Unknown storeyId #N` instead of silently falling back to the world placement. This is a strictly earlier version of the error `trackElement` already threw a few lines later, so no working call changes — it just means a bogus storey id no longer emits orphan placement entities before failing.

  ## `@ifc-lite/sandbox`

  The `llmSemantics.placement` metadata in `NAMESPACE_SCHEMAS` is corrected to match: the seven methods previously tagged `'world'` (`addIfcMember`, `addIfcPlate`, `addIfcCurtainWall`, `addIfcRailing`, `addIfcDoor`, `addIfcWindow`, `addAxisElement`) are now `'storey-relative'`, and the `useWhen`/`cautions` prose that described them as world-placement is rewritten. The `MethodPlacementKind` union is unchanged and no export was added or removed. Consumers that read `placement` to generate guidance will see different values for those seven methods — which is the point: the old values now describe behaviour that no longer exists.

  Thirteen constructors that carried no `llmSemantics` at all — `addIfcRamp`, `addIfcFooting`, `addIfcPile`, `addIfcSpace`, `addIfcFurnishingElement`, `addIfcBuildingElementProxy`, `addIfcCircularColumn`, `addIfcHollowCircularColumn`, `addIfcIShapeBeam`, `addIfcLShapeMember`, `addIfcTShapeMember`, `addIfcUShapeMember`, `addIfcRectangleHollowBeam` — now declare `placement: 'storey-relative'` with their coordinate keys. They were invisible to every consumer that groups methods by placement frame, so nothing generated from this schema said which datum their coordinates were in. `NAMESPACE_SCHEMAS.create` now tags all 30 coordinate-taking constructors (27 storey-relative, `addElement` explicit-placement, and the two wall-local hosted inserts).

  ## Downstream packages carrying the break

  The behaviour change is not confined to `@ifc-lite/create`: four packages re-expose `IfcCreator` and therefore ship it to their own consumers. Each is versioned to say so, rather than letting a caller pick the change up through a range they believed was compatible.

  - **`@ifc-lite/sdk` (major)** — re-exports the class directly (`packages/sdk/src/index.ts`: `export { IfcCreator } from '@ifc-lite/create'`). Without a major, a consumer on `^1.21` accepts the release and gets storey-relative placement with no signal.
  - **`@ifc-lite/sandbox` (major, was minor)** — `buildCreateMethods()` auto-discovers `IfcCreator.prototype` and dispatches to it, so every affected constructor is reachable from sandbox scripts. A script passing absolute coordinates against a non-zero-elevation storey now emits geometry one elevation off. That is breaking for the script author even though the sandbox's own surface is unchanged.
  - **`@ifc-lite/cli` (minor)** — `create` constructs `IfcCreator` and passes `--elevation` straight through, so the same shift reaches CLI users following the previous absolute-coordinate convention. Minor rather than major because the package is pre-1.0, where the house rule maps a breaking change to a minor bump.
  - **`@ifc-lite/mcp` (minor)** — exposure is indirect but real: `loadIfcModel()` (`src/index.ts`) returns a `LoadedModel` carrying `bim: BimContext` (`src/loader.ts`), whose `create` namespace constructs the class (`@ifc-lite/sdk` `namespaces/create.ts`: `project()` returns `new IfcCreator(params)`, `building()` takes a `StoreyElevation`). A library consumer calling `model.bim.create.building({ StoreyElevation })` gets the new datum. Minor for the same pre-1.0 reason as the CLI.

  `@ifc-lite/wasm` is unaffected — it neither constructs nor re-exports `IfcCreator`, directly or through a namespace. The viewer apps are private and unpublished.

### Patch Changes

- Updated dependencies [[`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275), [`8f139a8`](https://github.com/LTplus-AG/ifc-lite/commit/8f139a8ef44235b68c2f97c032419fa586111b62)]:
  - @ifc-lite/sdk@2.0.0

## 1.16.4

### Patch Changes

- [#1918](https://github.com/LTplus-AG/ifc-lite/pull/1918) [`d7065f9`](https://github.com/LTplus-AG/ifc-lite/commit/d7065f9bd08cd12d8b17c9f11f0adcd38e0ee1f3) Thanks [@louistrue](https://github.com/louistrue)! - Fix `sandbox.dispose()` aborting the whole QuickJS WASM module when a `bim.*` result could not be marshalled. Handles created through a QuickJS context are unmanaged lifetimes — `context.dispose()` does not free them — so a container handle orphaned by a mid-marshal exception (a throwing getter, a revoked `Proxy`, any host error raised while a result was being converted) kept a JSObject on the runtime's GC list and made `JS_FreeRuntime` assert `list_empty(&rt->gc_obj_list)`. Emscripten then `abort()`ed, leaving the sandbox unusable until a page reload. The bridge now owns every handle it creates across throws (`marshalValue`, namespace registration, the `bim` and `console` globals), and the disposable result of `executePendingJobs()` is freed instead of dropped. Script errors surface unchanged; only the abort is gone.

- Updated dependencies []:
  - @ifc-lite/sdk@1.21.3

## 1.16.3

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- Updated dependencies [[`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a)]:
  - @ifc-lite/sdk@1.21.2

## 1.16.2

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39)]:
  - @ifc-lite/sdk@1.21.1

## 1.16.1

### Patch Changes

- [#1548](https://github.com/LTplus-AG/ifc-lite/pull/1548) [`ec89d3f`](https://github.com/LTplus-AG/ifc-lite/commit/ec89d3f871f54b58fbfe32915ac6304505de1174) Thanks [@louistrue](https://github.com/louistrue)! - Fix `naiveTypeStrip` mangling namespace imports on the esbuild-free fallback path. The `as`-cast removal regex only protected the `import { Foo as Bar }` alias form, so `import * as utils from 'x'` was rewritten to the invalid `import * from 'x'`, which then survived module-syntax stripping and reached QuickJS verbatim. The negative lookbehind now also excludes `* as name`, so namespace imports are stripped correctly.

## 1.16.0

### Minor Changes

- [#1152](https://github.com/LTplus-AG/ifc-lite/pull/1152) [`ca8a856`](https://github.com/LTplus-AG/ifc-lite/commit/ca8a856308e5a6df1bb84d0c28f0c1e5059da19a) Thanks [@louistrue](https://github.com/louistrue)! - Add `bim.query.matchingActiveFilter()` — returns the entities matching the host's active advanced filter (or `null` when no filter is set). Backed by a new `QueryBackendMethods.entitiesMatchingActiveFilter()`. Lets scripted exports (e.g. the CSV quantity take-off) honour the current filtered view instead of always exporting the whole model (issue [#1107](https://github.com/LTplus-AG/ifc-lite/issues/1107)).

### Patch Changes

- Updated dependencies [[`ca8a856`](https://github.com/LTplus-AG/ifc-lite/commit/ca8a856308e5a6df1bb84d0c28f0c1e5059da19a)]:
  - @ifc-lite/sdk@1.19.0

## 1.15.2

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/sdk@1.18.1

## 1.15.1

### Patch Changes

- [#946](https://github.com/LTplus-AG/ifc-lite/pull/946) [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0) Thanks [@louistrue](https://github.com/louistrue)! - Fix a batch of verified findings from a full-codebase review (security, correctness,
  data-loss, and resource/memory leaks). Highlights:

  **Security**

  - collab-server: a malformed WebSocket frame no longer crashes the whole process
    (decode is wrapped; a bad frame is rejected/audited instead of throwing).
  - mcp: the local HTTP transport now validates `Host`/`Origin` and no longer sends a
    wildcard `Access-Control-Allow-Origin`, closing a DNS-rebinding/CSRF hole; the
    `AuthScope.modelIds` allowlist is now enforced at model resolution.
  - server-bin: `extractZip` uses `execFileSync` (argv, no shell), removing command
    injection via archive/destination paths.
  - export / sdk / cli / mcp / lists / viewer CSV exporters now neutralize spreadsheet
    formula injection (CWE-1236) consistently.
  - create-ifc-lite: validates the project name (no path traversal) and drops the
    unused `execSync`-based downloader.
  - embed-sdk: inbound `postMessage` now validates `event.origin`.

  **Correctness / data-loss**

  - parser: `lengthUnitScale` survives the worker transport; the nested STEP list
    parser is string-aware (commas/parens inside quoted values no longer mis-split).
  - mutations: deleting a property from a session-created pset and replaying
    `UPDATE_ATTRIBUTE` / `CREATE_PROPERTY_SET` mutations now work.
  - export: merged-export ID remapping no longer rewrites `#N` inside quoted strings.
  - drawing-2d: GPU section cutter triangle upload/readback use correct WGSL std-layout
    offsets and strides.
  - ifcx: cyclic children no longer abort the parse; spatial children round-trip; the
    mesh transform guards a zero/non-finite homogeneous `w`.
  - data / cache: a `NULL` string property value stays `null` instead of becoming `""`.
  - pointcloud, bcf, server-client, query, viewer-core, viewer store/federation: assorted
    decoding, federation-id, and selection-state fixes.

  **Resource / memory leaks**

  - geometry, query (DuckDB), renderer (GPU buffers), collab (federation presence),
    sandbox (host log capture + runtime), mcp (clash mesh cache), server-bin (signal
    listeners), and the viewer renderer on unmount now release resources deterministically.

  **Hardening (apps, not published)**

  - server: a dedicated `server-release` Cargo profile (`panic = "unwind"`) plus a
    `CatchPanicLayer` contain a malformed-IFC parse panic to the offending request
    instead of aborting the whole server.
  - desktop (Tauri): a Content-Security-Policy is set, and unused `shell:*` /
    `fs:allow-write|mkdir|remove` capabilities (and the unused shell plugin) are removed.

  **Second pass** (additional verified findings)

  - collab-server: S3 log load now follows `ListObjectsV2` pagination (no dropped frames);
    awareness frames are size-capped + rate-limited; path-lock verify runs after role/rate-limit;
    the blob route requires auth and `/metrics` can be token-gated.
  - server-bin: downloaded binaries are SHA-256 verified against a release sidecar (fail-closed on
    mismatch, warn-if-absent for older releases).
  - extensions: inner-ring capability check fails _closed_ for unknown namespaces; signing
    canonicalization is now injective (length-prefixed).
  - correctness/leaks: mutations quantity type+unit preserved on replay; `findByProperty` boolean
    comparisons; Parquet REAL columns kept as Float64; blob GC fail-safe on missing `uploadedAt`;
    spatial-hierarchy + codegen cycle guards; BVH NaN edge; bSDD/playground caches bounded;
    point-cloud GPU asset freed on federation error; mcp `parseColor` rejects non-hex; bcf/SVG/STEP
    output escaping; and more.

- Updated dependencies [[`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0)]:
  - @ifc-lite/sdk@1.17.1

## 1.15.0

### Minor Changes

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Add the `bim.store.*` namespace — high-level editing of an already-parsed
  `IfcDataStore` via the existing mutation overlay. Closes the merge-roundtrip
  gap from #592 (you can edit `IfcRectangleProfileDef.XDim` or drop a fresh
  `IfcColumn` into a model without round-tripping through a script + re-parse).

  **`@ifc-lite/mutations`** — new `StoreEditor` facade plus four
  `MutablePropertyView` extensions: positional-attribute mutations, overlay
  entity creation/deletion (with watermark seeding), and three helpers used by
  the viewer's undo/redo (`removePositionalMutation`, `restoreFromTombstone`,
  `restoreNewEntity`).

  **`@ifc-lite/create`** — new `in-store/` module: `addColumnToStore` builds a
  12-entity IfcColumn sub-graph (placement, profile, extruded solid,
  representation, product shape, rel-contained-in-spatial-structure) anchored
  to a target `IfcBuildingStorey`. `resolveSpatialAnchor` walks the parsed
  store to find the IfcOwnerHistory, the 'Body' representation context, and
  the storey's local placement.

  **`@ifc-lite/sdk`** — new `StoreNamespace` exposed as `bim.store` on
  `BimContext`. Methods: `addEntity`, `removeEntity`, `setPositionalAttribute`,
  `addColumn`. Backed by `StoreBackendMethods` on `BimBackend`; the
  `RemoteBackend` proxy round-trips them through the transport.

  **`@ifc-lite/sandbox`** — `bim.store.*` is bridged into the QuickJS sandbox
  with full TypeScript types via `bim-globals.d.ts` and an LLM cheat sheet in
  the system prompt. Gated on a new `store: true` permission (default
  `false`, mirrors the existing `mutate` permission pattern).

  **`@ifc-lite/cli`** — `HeadlessBackend.store` is now functional (was a
  no-op before). Scripts run via the CLI can edit a parsed model and export it
  with mutations applied.

  **`@ifc-lite/viewer`** — three new UI surfaces:

  - Raw STEP tab in `PropertiesPanel` — lists every positional STEP argument
    with an inline pen-icon editor for scalar values (numbers, refs, enums,
    null). Mutated rows show a purple dot and tinted background.
  - `EntityContextMenu` gains "Delete entity" (red, calls `removeEntity`
    with toast + undo support) and "Add column here…" (emerald, only enabled
    when the right-clicked entity is an `IfcBuildingStorey`).
  - `AddColumnDialog` modal — storey picker sorted by elevation, position
    (storey-local metres), cross-section, height, name, optional collapsible
    for Description/ObjectType/Tag. Anchor-resolution failures surface
    inline, not as thrown exceptions.

  Plus four new actions on `mutationSlice` (`setPositionalAttribute`,
  `removeEntity`, `addColumn`, dialog open/close) backed by per-model
  `StoreEditor` caches, with undo/redo wired for `UPDATE_POSITIONAL_ATTRIBUTE`,
  `CREATE_ENTITY`, and `DELETE_ENTITY`.

  **`@ifc-lite/parser`** — `package.json` `exports` re-ordered to put `types`
  before `import` so downstream consumers using TS5 `nodenext` resolution
  pick up the type declarations.

  **`@ifc-lite/geometry`** — re-exports `MetadataBootstrapEntitySummary` and
  `MetadataBootstrapSpatialNode` from the package index (used by viewer
  desktop services).

  **`@ifc-lite/renderer`** — `GPUBufferDescriptor` ambient declaration gains
  `mappedAtCreation?: boolean`. Internal change; the renderer was already
  using it at runtime to skip a Mojo IPC round-trip on Chrome/Dawn.

- [#576](https://github.com/louistrue/ifc-lite/pull/576) [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742) Thanks [@louistrue](https://github.com/louistrue)! - Add IFC scheduling entity support across the scripting SDK, LLM assistant, and
  CLI headless backend.

  **Create API** — `IfcCreator` gains `addIfcWorkSchedule`, `addIfcWorkPlan`,
  `addIfcTask` (with inline `IfcTaskTime`), `addIfcRelSequence` (with
  `IfcLagTime`), `assignTasksToWorkSchedule` (`IfcRelAssignsToControl`),
  `assignProductsToTask` (`IfcRelAssignsToProcess`), and `nestTasks`
  (`IfcRelNests`).

  **SDK** — new `bim.schedule` read namespace (`data()`, `tasks()`,
  `workSchedules()`, `sequences()`) backed by the parser's
  `extractScheduleOnDemand`. New `ScheduleBackendMethods` is now part of
  `BimBackend`; the viewer's `LocalBackend`, the `RemoteBackend` proxy, and the
  CLI `HeadlessBackend` all implement it.

  **Sandbox** — new `bim.schedule.*` QuickJS namespace plus schedule methods on
  `bim.create.*`, all carrying LLM semantic contracts so the auto-generated
  system prompt teaches the assistant when to use them. Autocomplete types
  (`bim-globals.d.ts`) regenerated.

### Patch Changes

- [#598](https://github.com/louistrue/ifc-lite/pull/598) [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c) Thanks [@louistrue](https://github.com/louistrue)! - Auto Spaces — diagnostics, broader wall coverage, and a sweep of
  review feedback.

  **Auto Spaces detection.** The "no enclosed regions detected"
  failure mode now surfaces actionable counts — both in devtools
  and in the panel itself.

  - `extract-walls.ts` now tries the standard `Axis` representation
    (`IfcShapeRepresentation` with `RepresentationIdentifier='Axis'`,
    `IfcPolyline` items) **before** falling back to the
    `addWallToStore` rectangle-profile convention. That covers
    walls authored by Revit / ArchiCAD / IfcOpenShell — the previous
    extractor only handled walls placed via the Add Element tool.
    The placement chain is read once and the polyline endpoints are
    transformed through it, so rotated walls work.
  - Every wall that gets dropped is recorded with a typed reason
    (`no-axis-or-rect-profile`, `placement-not-resolvable`,
    `zero-length-axis`, …) — the panel summarises them as
    `"3× no-axis-or-rect-profile, 1× zero-length-axis"`.
  - `detectEnclosedAreas` exposes a
    `detectEnclosedAreasWithStats(...)` companion that returns
    per-stage counts (vertices, edges-after-split, faces total,
    outer / below-min-area drops, largest area). The intersection
    splitter's iteration cap now scales with input size
    (`max(100, segments * 10)`) so dense floor plans don't bail
    out early.
  - `generateSpacesFromWalls` always logs a `console.info`
    one-liner and threads a new `debug?: boolean` flag down to the
    extractor + detector for verbose tracing. The viewer's Auto
    Spaces panel exposes a "Verbose console logging" checkbox.
  - The Auto Spaces diagnostic block now shows the graph stats
    (`123v / 456e / 78f`), the drop counts, and per-reason wall
    skips. Two amber hints fire automatically when walls were
    extracted but no faces formed (likely snap tolerance), or
    when nothing extracted (likely an unsupported geometry shape).

  **Review-feedback sweep (PR #598).**

  - `addElementMeshes.linearBox()` and the SVG `linearBoxCorners`
    helper honour each endpoint's Y so a sloped beam previews as
    a sloped prism instead of being flattened to the start.
  - `bridge-store.requireStoreyId` rejects `0` (EXPRESS ids are
    1-based, `#0` is never valid).
  - `addWindow` / `addDoor` `tsParamTypes` include
    `UserDefinedPartitioningType` / `UserDefinedOperationType`
    so typed sandbox callers can hit the IFC4 round-trip without
    casts.
  - `AnnotationLayer.resolveEntityType` no longer falls back to
    `ifcDataStore` when the annotation's `modelId` is missing
    from a federated `models` map (would resolve the wrong
    entity in multi-model sessions). Single-model sessions keep
    the fallback.
  - `addDoorToStore` / `addWindowToStore` validate
    `OperationType` / `PartitioningType` against the IFC4 enum
    and re-route unknown values through
    `.USERDEFINED.` + `User-defined…Type` so custom labels
    round-trip cleanly.
  - `addWallToStore` defaults `PredefinedType` to `.NOTDEFINED.`
    (was `.STANDARD.`) to match the rest of the in-store
    builders.
  - `duplicateInStore` / `resolveDuplicateSource` allow
    `OwnerHistory` to be `null` (IFC4 made it optional). The
    duplicate emits a bare `$` token instead of `#null` for the
    omitted case.
  - `StoreEditor.addEntity` accepts an injected schema-aware
    normalizer (`setEntityTypeNormalizer`); `@ifc-lite/sdk`
    registers `normalizeIfcTypeName` + `isKnownType` at load
    time so direct callers — CLI scripts, sandbox bridge,
    unit tests — see registry-grade rejection of typos like
    `IfcWal`, plus canonical PascalCase on `EntityRef.type`.

- Updated dependencies [[`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`25c9877`](https://github.com/louistrue/ifc-lite/commit/25c9877969d2dcccb9c4e61f57b188cbf5fbbc3c), [`1309f8c`](https://github.com/louistrue/ifc-lite/commit/1309f8cba128b3b6237ebfb9831bf359c426a742)]:
  - @ifc-lite/sdk@1.15.0

## 1.14.6

### Patch Changes

- [#513](https://github.com/louistrue/ifc-lite/pull/513) [`082eadd`](https://github.com/louistrue/ifc-lite/commit/082eaddd10b158d1b3fe6067f9abf949596a0162) Thanks [@louistrue](https://github.com/louistrue)! - Add CesiumJS 3D Tiles integration with synchronized camera controls, and expose renderer camera state for external consumers.

## 1.14.5

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

- Updated dependencies [[`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5)]:
  - @ifc-lite/sdk@1.14.6

## 1.14.4

### Patch Changes

- [#392](https://github.com/louistrue/ifc-lite/pull/392) [`6cbcf90`](https://github.com/louistrue/ifc-lite/commit/6cbcf904c99b17e4095424ba087c903fb4c82061) Thanks [@louistrue](https://github.com/louistrue)! - Fix "Invalid string length" error when exporting large merged IFC models by using chunked Uint8Array assembly instead of string concatenation. Add async export methods with progress callbacks to StepExporter and MergedExporter. ExportDialog now shows a progress bar with phase indicator and entity counts during export, matching the BulkPropertyEditor feedback pattern.

## 1.14.3

### Patch Changes

- [#309](https://github.com/louistrue/ifc-lite/pull/309) [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0) Thanks [@louistrue](https://github.com/louistrue)! - Add `addIfcGableRoof`, `addIfcWallDoor`, and `addIfcWallWindow` to the creation API and expose them through the sandbox bridge.

  Add richer IFC-aware query access in the sandbox for selection, containment, spatial paths, storeys, and single property/quantity lookups.

  Harden geometry generation guidance and validation so scripts use the correct roof and wall-hosted opening helpers, and improve prompt context around hierarchy, selection, and storey structure for multi-level generation.

- [#309](https://github.com/louistrue/ifc-lite/pull/309) [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0) Thanks [@louistrue](https://github.com/louistrue)! - Fix sandbox creator/session isolation, sandbox lifecycle races, and geometry crash recovery messaging.

- [#309](https://github.com/louistrue/ifc-lite/pull/309) [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0) Thanks [@louistrue](https://github.com/louistrue)! - Expose uploaded chat attachments to sandbox scripts through `bim.files.*`, teach the LLM prompt to reuse those files instead of `fetch()`, and add first-class root attribute mutation support for script/export workflows.

- Updated dependencies [[`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/sdk@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/sdk@1.14.2

## 1.14.1

### Patch Changes

- [#283](https://github.com/louistrue/ifc-lite/pull/283) [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607) Thanks [@louistrue](https://github.com/louistrue)! - fix: support large IFC files (700MB+) in geometry streaming

  - Add error handling to `collectInstancedGeometryStreaming()` to prevent infinite hang when WASM fails
  - Add adaptive batch sizing for large files in `processInstancedStreaming()`
  - Add 0-result detection warnings when WASM returns no geometry
  - Replace `content.clone()` with `Option::take()` in all async WASM methods to halve peak memory usage

- Updated dependencies []:
  - @ifc-lite/sdk@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies [[`060eced`](https://github.com/louistrue/ifc-lite/commit/060eced467e67f249822ce0303686083a2d9199c), [`7b81970`](https://github.com/louistrue/ifc-lite/commit/7b81970ea12ba0416651315963c7c6db924657a3)]:
  - @ifc-lite/sdk@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/sdk@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/sdk@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/sdk@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/sdk@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/sdk@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/sdk@1.10.0

## 1.9.0

### Minor Changes

- [#227](https://github.com/louistrue/ifc-lite/pull/227) [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d) Thanks [@louistrue](https://github.com/louistrue)! - Add scripting platform with sandboxed TypeScript execution and full BIM SDK.

  New packages:

  - `@ifc-lite/sandbox` — sandboxed script runner that transpiles and executes user TypeScript in a Web Worker with BIM globals (`bim.query`, `bim.select`, `bim.viewer`, etc.) isolated from the host page.
  - `@ifc-lite/sdk` — BIM SDK defining the full host↔sandbox message protocol and all namespaces: `query`, `mutate`, `viewer`, `spatial`, `export`, `lens`, `bcf`, `ids`, `drawing`, `list`, `events`.

  New viewer features:

  - **Command Palette** — `Cmd/Ctrl+K` fuzzy-search launcher for viewer actions and scripts.
  - **Script Panel** — full-screen code editor (CodeMirror) with run/stop controls, output log, and CSV download.
  - **6 built-in script templates** — quantity takeoff, fire-safety check, MEP equipment schedule, envelope check, space validation, federation compare.
  - **Recent files** — persisted list of previously opened IFC files.

### Patch Changes

- Updated dependencies [[`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d), [`67c0064`](https://github.com/louistrue/ifc-lite/commit/67c00640a0ca344337e5e79d80888d329df9130d)]:
  - @ifc-lite/sdk@1.9.0
