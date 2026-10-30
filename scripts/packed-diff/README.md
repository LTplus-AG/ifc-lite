# Packed Node 22.13 facade acceptance (#8042)

`scripts/diff-packed-node22.mjs` prepares a new, empty consumer in the OS temp
directory, outside the source workspace, and tests **actual `pnpm pack`
tarballs**. It never builds, installs, downloads, pushes, or edits a package.
Run it under the parent's fleet reservation after preparation. This is a
bounded acceptance command, not a replacement for root Turbo tests, real IFC
fixture parity, geometry acceptance, or performance qualification.

## Prerequisites

- Clean committed checkout containing the completed #8042 facade and this runner.
  The inspected baseline is `59f673a0` from
  `/home/louistrue/dev/ifc-diff-completion` (the supplied combined path
  `/home/louistrue/dev/ifc-diff-completion59f673a0` does not exist).
- Parent has prepared artifacts through the root pnpm/Turbo build and the
  repository's independent diff and full WASM build paths under fleet admission.
  `packages/diff/dist`, `packages/wasm/pkg`, and `packages/wasm/pkg-diff` must be
  from that checkout/revision. No source transpilation or stale-artifact build
  fallback is attempted. Both full and diff WASM JS/binaries must be packed,
  although only the independent diff runtime is initialized.
- Repository-pinned `pnpm@10.8.1`, its Corepack payload, and the existing root
  `tsx` dependency are already provisioned. The runner refuses a different
  pnpm version and disables Corepack network acquisition. `tar` must be present.
  There is no `npm install`, workspace linking, registry dependency resolution,
  fetch of prebuilt WASM, or new dependency installation.
- A real Node **22.13.x** executable available on the execution host. It is
  required explicitly; the runner's own Node can be the root toolchain Node.
  `NODE_OPTIONS`/`NODE_PATH` are removed in all subprocesses. Consumers use
  `--no-experimental-strip-types --max-old-space-size=512`.
- Absolute path to the original preparation receipt/log, identifying the
  prepared source commit and successful artifact builds. The runner copies and
  hashes this receipt; it does **not** authenticate its prose or infer that
  arbitrary existing artifacts were freshly built. The parent reconciles the
  source commit, build receipt, and artifact provenance. An overall failed
  preparation receipt is acceptable when the required artifact builds passed
  and the failure occurred elsewhere; the parent reconciles those outcomes.
  For example, the parent's e5a run completed 58/58 builds and docs/API checks
  before lint failed on new test errors that were subsequently fixed. Every
  packed runtime file is SHA256 checked
  against the actual prepared artifact, independently of that receipt.
- A new absolute evidence directory outside the source checkout. Do not reuse
  a failed/uncertain output path: inspect its receipt and `result.json` first.
  Do not nest this command inside another fleet admission if already admitted.

Read-only discovery on this PC found and executed `--version` on the existing
pnpm content-store binary below; it returned **v22.13.0**. This is a local cache
path, not a guaranteed path on Pop. No installation or download was performed:

```sh
NODE22=/home/louistrue/.local/share/pnpm/store/v10/files/10/f65ce27fb6a729d5d35b168506b3e211b9a8c7ac280eaea0a70dd1ef6cc537438d30abe724e49b2154ff3272fcf32996e911983313466303211a7d635f5c1d-exec
"$NODE22" --version
```

## Admitted command

Set `CHECKOUT`, `NODE22`, `PREP_RECEIPT`, and `EVIDENCE` to absolute paths on the
chosen execution host; `STORAGE_TASK` is the parent's open owning storage task.
Use this exact invocation **outside** an existing reservation:

```sh
~/build-workers/ifc-fleet run --cwd "$CHECKOUT" \
  --storage-task "$STORAGE_TASK" --cpu 2 --memory 2 -- \
  node scripts/diff-packed-node22.mjs \
  --node22 "$NODE22" --prep-receipt "$PREP_RECEIPT" --out "$EVIDENCE"
```

The fleet-selected host must have those prerequisites and paths. For a
parent-managed admitted preparation/acceptance group, the inner `node ...`
command is the acceptance step; do not submit a second reservation. `--source
/absolute/prepared-checkout` can select a separately prepared clean checkout
without modifying it. `--pnpm /absolute/pnpm` selects a provisioned pnpm launcher.
The execution environment must still satisfy the repository root toolchain
requirements. This preparation task submitted no fleet jobs.

The runner packs `@ifc-lite/diff` and `@ifc-lite/wasm` with lifecycle scripts
disabled, rejects tar links/devices/traversal, and extracts their real bytes into
the consumer's `node_modules`. All non-development dependencies (including peers
and optional dependencies) must be supplied as real packs. For a future added
dependency, add `--package /absolute/package-directory`; unsupported ranges or
missing packs fail explicitly. Current manifests need only diff and wasm, whose
workspace version is rewritten to the exact packed version by pnpm. No manifest
is rewritten by this harness. Ancestor `node_modules` directories are rejected.

## Assertions and evidence

- A separate Node 22.13 process runs the frozen vectors against the private TS
  oracle via explicit **`tsx/esm/api.tsImport`**, with native stripping disabled.
  The oracle is an expectation cross-check, never a loader for the packed
  consumer and never a generator of expected output.
- Three independent cold Node processes run default concurrent `await
  initDiff()`, `initDiffSync({ module: bytes })`, and invalid asynchronous bytes
  followed by concurrent default retry. The synchronous process also checks a
  failed invalid-byte synchronous init before successful retry. Every one of
  the 24 synchronous public functions and the public `DiffModelHandle` constructor must fail before initialization.
- Real, unmodified Node `fetch(file:)` is shown to reject, while the facade's
  default init succeeds through its filesystem path. No mocked fetch, loader,
  WASM exports, or source workspace facade imports are used in the consumers.
- The runtime class constructor and `prepareDiffModel` factory are exercised through
  the tarball, including compare parity with frozen diff results, placement stripping
  disabled/enabled/disabled cache isolation, idempotent disposal, disposed operands,
  and `Symbol.dispose`. The private TS oracle cross-checks the original 23 functions;
  it predates resident handles.
- Every synchronous public function has fixed semantic assertions; an added
  uncovered function fails the coverage assertion. These include diff scopes,
  exclusions, geometry abstention, matching/aliases, object/ref identity,
  normalization, literal FNV hashes, lone UTF-16 keys/values/sidecars, provenance,
  lineage/rekeying, keyed sidecars, digest mismatch diagnostics, host JSON bytes,
  malformed JSON and getter exception identity. Constants are asserted too.
  This is bounded operation coverage, not every algorithmic branch in #8042.
- `result.json` records source commit, Node binary hash/version, harness hashes,
  explicit oracle loader path/hash, copied prep receipt hash, actual pnpm command,
  package manifests, tarball hashes, and the complete packed file inventories.
  Per-process resolution reports prove realpaths for the public facade, diff JS
  glue, and actual WASM asset inside the empty consumer, with SHA256 and byte
  lengths. These reports are written before initialization can fail.
- Each stage keeps stdout/stderr, status, signal, and spawn errors. Expected
  invalid-byte errors retain messages/stacks. Assertion failures retain their
  actual/expected diagnostics in stderr. There are no skips or auto-retries.
  Each child is limited to 20 seconds, each pack to 60 seconds; subprocesses
  share a five-minute deadline. At most eight packages, 2,000 files/128 MiB per
  package, and a 512 MiB child JS heap are accepted. Use the fleet memory/CPU
  reservation for the whole process tree.

The temporary consumer is removed after success **or failure**, after copying
its compact resolution/error/result files out. Evidence and actual tarballs
remain in `EVIDENCE` until the parent publishes selected compact artifacts and
closes its storage task. Publish `result.json`, `*-resolution.json`,
`*-result.json`, expected-error JSON, original preparation receipt, and stage
logs via the owning launcher's artifact mechanism; never retain the consumer's
`node_modules` or an entire generated workspace. Follow the fleet storage
receipt/closure rules for an unknown outcome; do not blindly resubmit.

## Preparation validation

Only syntax checks and the tiny frozen-oracle vector check were performed while
writing this runner. The oracle check passed under the discovered Node 22.13.0
binary with native stripping disabled. The real packed WASM acceptance is
deliberately left for the parent's admitted execution; it has not passed yet.
