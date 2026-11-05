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
