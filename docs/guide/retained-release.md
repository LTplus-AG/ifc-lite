# Retained source-package release runbook

Refs #7955. Draft for the release owner; no publication was performed by this
work. Source-package bootstrap and SDK distribution are separate approvals.

## Preflight and evidence

Start from a clean reviewed commit. Record `git rev-parse HEAD`, Rust/Node/npm
versions and the validation results for each command. Keep the existing root Turbo
graph and pinned toolchain. Run the following in the release qualification environment:

```sh
node scripts/retained-package-proof.mjs cargo
node scripts/retained-package-proof.mjs cargo-graph
node scripts/retained-package-proof.mjs build
node scripts/retained-package-proof.mjs npm
```

`cargo` invokes `cargo package --list` and `cargo publish --dry-run --locked`
for every entry in `scripts/lib/crates-io.mjs` **plus the unbootstrapped runtime
candidate**, followed by a feature-on runtime dry-run. The qualification list
is separate from the automatic release list. Runtime stays out of `CRATES`
until its first registry release exists: the always-on semver gate correctly
rejects a listed crate without a baseline. Both crate-count floors remain eight.
`cargo-graph` runs a combined dry-run of those same nine crates, first default
and then with runtime/processing/browser retained features. Cargo's multi-package
mode can stage their real normalized archives together before the prerequisite
versions exist in the registry; it does not use path patches or remove edges.
See [Cargo package registry semantics](https://doc.rust-lang.org/cargo/commands/cargo-package.html#option-cargo-package---registry).
That graph check does not replace the single-crate registry-readiness result.
`build` runs default workspace tests, the excluded Python consumer build and
strict all-target Clippy. `npm` builds through root `pnpm build` then invokes
`npm pack --dry-run --json` for WASM and CLI. A failed command does not suppress
later evidence, and any failure makes the qualification command fail. JSON
summaries are local scratch; retain immutable logs and source identities with the release evidence.

A dry-run is **not** a publication, Trusted Publisher test, wheel installation,
or final linked-SDK audit. A missing registry dependency is a real blocker;
never hide it with `--no-verify`, a path patch or by removing an optional edge.
The Python `cargo build` validates the PyO3 consumer but does not build/install a
wheel; execute `.github/workflows/python-wheels.yml`'s build/import checks on the
final release source before calling wheel distribution qualified.

Review the archive inventory: runtime contains only `src/**`, manifests/lock,
README, LICENSE and Cargo VCS metadata. It must not carry SDK sources, worker
executables, build trees or WASM. Inspect the normalized archived Cargo.toml:
`ifc-lite-geometry` must retain a registry version and the `retained-runtime`
feature forwarding. No build script may fetch an SDK. Published npm archives
must include `THIRD_PARTY_NOTICES.txt`. The current npm WASM archive deliberately
excludes `pkg-retained/*.js`, `pkg-retained/*.wasm` and SDK assets; installing it
alone does not install a retained engine.

## Qualification record

Keep command logs, receipt identifiers, source commits, archive hashes and
observed registry versions in the release handoff. Record single-crate registry
readiness separately from combined-graph dry-runs: a combined graph can verify
normalized archives before their prerequisites have been published.

Before release, run `node scripts/check-rust-semver.mjs` and
`node scripts/check-rust-api-surface.mjs`, plus release-order/version-sync checks.
`publish = false` is removed for explicit runtime bootstrap qualification; the
automatic list and both crate floors remain at their original eight crates.

## First crates.io publication (human operation)

Observed on 2026-10-29: runtime name returned HTTP 404; core and geometry latest
were 25.0.1, while this source declares 26.0.0. Recheck immediately before any
publication. Do not reuse older 22.6 bootstrap authorization for this source.

1. Obtain explicit authorization for the exact **source-only archive hash,
   source commit, name and version**, and complete review of the release list.
2. Let `release.yml` publish the eight existing crates, confirm their approved
   versions appear in the sparse index, and bootstrap **only the runtime by
   hand**. Do not hand-publish those eight crates with a personal token. Runtime
   stays outside the automatic list until bootstrap. Its first upload cannot
   resolve the required geometry version until that version is indexed.
3. Before uploading runtime, repeat `cargo package -p ifc-lite-geometry-runtime`
   and both dry-runs (default and `--features retained-runtime`). Retain the
   resulting `.crate` SHA-256, file list and `.cargo_vcs_info.json`. All must
   refer to the approved clean source. Wait for prerequisite registry indexing
   before retrying a **diagnosed dependency-resolution failure**.
4. Authenticate privately with a short-lived crates.io token scoped for the
   first new-crate publication. Use normal Cargo credential storage (`cargo
   login` interactively); never put tokens in shell arguments, repository files,
   logs or this document. Only after approval run:

   ```sh
   cargo publish -p ifc-lite-geometry-runtime --locked
   ```

5. Verify the registry's exact version, owners, checksum, downloaded archive
   file list and VCS identity. On an uncertain upload response, inspect the
   existing registry version before doing anything else; never blindly replay.
6. In `https://crates.io/crates/ifc-lite-geometry-runtime/settings`, add the GitHub
   Trusted Publisher: owner `LTplus-AG`, repository `ifc-lite`, workflow filename
   `release.yml`, environment `release-publish`. Confirm these exact fields on
   every crate in the release list, not just runtime. Record verification in
   private release evidence; absence of a public API result is not a verified
   setting. Revoke the bootstrap token after registry confirmation.
7. **Only after bootstrap and publisher verification, add
   `ifc-lite-geometry-runtime` to `CRATES` in `scripts/lib/crates-io.mjs`, after
   geometry.** In that same reviewed change, run `pnpm rust-api-surface:update`
   and commit the newly enrolled API snapshot; run the semver and API-surface
   gates plus release-order and version-sync checks. Do not lower `CRATE_FLOOR`
   or exempt `NO_BASELINE`. The crate already inherits `version.workspace` and
   is a workspace member, so version synchronization does not depend on release
   enrollment. Removing `publish = false` permits the explicit authorized
   bootstrap command; it does not add the crate to automated publishing.
8. The existing workflow uses `id-token: write` and
   `rust-lang/crates-io-auth-action` under `release-publish`. Its next authorized
   release proves OIDC exchange and package permission. A local dry-run cannot.
   Do not trigger publication merely to test the configuration.

See the official [crates.io Trusted Publishing documentation](https://crates.io/docs/trusted-publishing)
and [Rust's rollout explanation](https://blog.rust-lang.org/2025/07/11/crates-io-development-update-2025-07/).
Registry settings and successful OIDC use remain **unverified** by this task.

## npm and linked artifacts

The existing `@ifc-lite/wasm` and `@ifc-lite/cli` packages use the existing release
workflow; no new npm package is introduced here. Check their Trusted Publisher
settings against the same repository/workflow/environment before release.
See [npm's current setup instructions](https://docs.npmjs.com/trusted-publishers/).
Use the repository's pnpm release path to transform workspace dependencies;
`npm pack --dry-run` proves file selection, not that `workspace:^` dependencies
are suitable for direct npm publication.

Before any SDK/native/retained-WASM distribution, resolve every open item in
[retained licensing](../architecture/retained-licensing.md), bind final artifact
hashes and source links, and obtain the human licence decision. Then install the
actual release archives into a clean consumer and run browser/CLI/Python smoke
checks. Staged fixtures and dry-runs cannot substitute for that final step.
