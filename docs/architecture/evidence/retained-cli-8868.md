# Retained CLI crash investigation (#8868)

## Definition of done

- Preserve the process identity, exit status, signal, engine/source/fixture
  identities and diagnostics for every reproduction attempt. Distinguish a
  signal from an explicit exit code of 139.
- Identify the failing process with a debugger or equivalent diagnostic.
  The CLI runs Rust WASM and SMLib WASM in Node and `worker_threads`; it does
  not use the native SMLib executable. Native ASAN findings alone cannot
  explain a Node crash.
- Repair the root cause or establish process containment with a typed failure,
  no partial OBJ/report publication, no automatic retry and no exact fallback.
  Report containment separately from root-cause repair; an unresolved cause
  remains unresolved even if a repeated cohort succeeds.
- Exercise a real signal, explicit exit 139, ordinary errors, cancellation,
  late failure after staged output, existing destination files, and stdout
  publication. Verify child cleanup and successful artifact identity.
- Run 20 fresh real `advanced_model.ifc` CLI exports with the frozen engine,
  checking 4802 published / 6650 candidate products and output identity, plus
  a diagnostic run. These are correctness runs, not performance measurements.
- Pass relevant repository gates and an adversarial review; publish source,
  compact evidence and a PR. Release generated workspaces after evidence
  publication, preserving original evidence and fixtures.

## Original evidence

- Issue: https://github.com/LTplus-AG/ifc-lite/issues/8868
- Cohort source: `7a7051cafa1dc458ec87862534f7559cc55ac324`, Node 24.22.0,
  Pop. One of seven CLI exports exited 139 with empty stderr.
- Engine manifest SHA-256:
  `c620168a43808a7aeda1fade0260d5c3202baef70dd10d45a41935ef361ec856`.
- Fixture SHA-256:
  `3c822eed72ab588697f3f4d4c2b074d1bb888802f877218c769845180f2b7ad2`.
- The original runner discarded GNU time's termination diagnosis. Its
  persisted exit code cannot distinguish SIGSEGV from explicit exit 139.
  No original core is available. The cohort records and engine inventory are
  preserved, but the generated engine binaries were released. Reproduction
  requires rebuilding the frozen engine and comparing its asset identities.

## Adversarial review findings

The first review rejected treating a `worker_threads` exit test as SIGSEGV
containment: all threads share the CLI process. It also required retaining
GNU time's termination diagnosis before scratch cleanup, checking a real
signal against explicit exit 139, and separating containment from proof of
the underlying cause. Twenty successful attempts alone are not that proof.

The next review found that one-shot signal listeners allowed a second Ctrl-C
to escape cleanup. Listeners now remain installed until the child is reaped.
Cancellation tests wait until the child has staged artifacts and installed its
handler, then distinguish a successful exit on SIGTERM from forced SIGKILL.
A further review identified lost explicit Node heap limits; selected heap and
fatal-report flags now reach the child, with a runtime heap observation test.
Another review caught signal handlers ending at child closure, leaving an
unprotected publication/cleanup interval. The export now owns signals through
cleanup: cancellation before the publication commit point rejects without
writing destinations; after that point it is deferred until output finishes.
Boundary tests deliver repeated parent signal events during real filesystem
validation and copying, and check destination contents and staging cleanup.

### Fatal Node/V8 reproduction and mitigation experiment

The corrected frozen-source rebuild (`b132066a-b05c-412c-95ef-fcc09185392b`)
completed successfully with unchanged source. Its manifest SHA-256 is
`117ba5a46c350cda1b36824a490003b3d5e4936b339db885c2789c2c26c3ae04`.
Only `pkg-retained/ifc-lite_bg.wasm` and `smlib/asset-manifest.json` differ
from the archived inventory; the SMLib executable assets match. This is
not a byte-identical reconstruction of the original engine.

GDB job `46e24032-938b-48c6-ac28-edb7b1e2a6d6`, using Node 24.22.0 and
baseline CLI `828740c6b05b9ebcbe0db25619a324c7abc00f11`, reproduced fatal
SIGSEGV while exporting the real `advanced_model.ifc`. The captured stack was:

```text
v8::base::RecursiveMutex::Lock
v8::internal::wasm::NativeModule::FreeCode
v8::internal::wasm::WasmEngine::FreeDeadCodeLocked
v8::internal::wasm::WasmEngine::FreeDeadCode
v8::internal::wasm::WasmCode::DecrementRefCount
v8::internal::wasm::WasmCodeRefScope::~WasmCodeRefScope
v8::internal::Runtime_TierUpWasmToJSWrapper
```

GDB continued signal delivery and reported `Program terminated with signal
SIGSEGV`; this was not classified from an initial V8 trap alone. GDB itself
returned zero, which is **not** a successful export verdict.

This matches the independently reported stack in
[Node #66366](https://github.com/nodejs/node/issues/66366). Inspection of
[Node 24.22.0's wrapper cache](https://github.com/nodejs/node/blob/v24.22.0/deps/v8/src/wasm/wasm-import-wrapper-cache.cc)
confirmed `MaybeGet` adds a reference before testing `is_dying()`, the order
addressed by [V8's fix](https://github.com/v8/v8/commit/9b8ca54d5a).
This supports the V8 wrapper-code reclamation race diagnosis for the rebuilt
engine reproduction; the unavailable original binary limits attribution of
the archived incident.

A 20-export baseline cohort and a separate 20-export cohort with
`--no-wasm-code-gc` are pending. The proposed mitigation applies this flag
only to the isolated retained child on Node 24. Generated code stays alive
until that child exits; this is not a general-purpose long-lived-process
recommendation. No successful mitigation-cohort verdict is claimed yet.
