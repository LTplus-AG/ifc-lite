# Retained source-package release runbook

Refs #7955. Draft for the release owner; no publication was performed by this
work. Source-package bootstrap and SDK distribution are separate approvals.

## Preflight and evidence

Start from a clean reviewed commit. Record `git rev-parse HEAD`, Rust/Node/npm
versions and the fleet receipt for each command. Keep the existing root Turbo
graph and pinned toolchain. On the provisioned fleet run the following with
`ifc-fleet run --host pc-wsl --cwd /absolute/checkout --` prepended:

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
summaries are local scratch; the fleet's immutable log/receipt owns the result.

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

## Observed Cargo package results

At `5d159aeca6a1f143c027153c8952def85e45e790`, all nine `cargo package --list`
commands passed. Runtime lists 32 source/package-metadata files and no SDK,
worker executable or WASM. Core and clash verified their archives and passed
`cargo publish --dry-run --locked` (upload explicitly aborted). Geometry,
runtime, processing, landxml, export, ffi and wasm failed with exit 101 on
unpublished 26.0.0 prerequisites. Runtime's retained-feature dry-run failed at
the same geometry-version resolution. Source remained clean and unchanged.
At `e5760aa0958df8d2dd2037085ac17ddfdd9e9e34`, both combined graph dry-runs
passed: all nine selected archives built in default mode and with the retained
runtime/processing/browser features. Cargo explicitly aborted upload. The
source stayed clean and unchanged. This verifies the packaged graph without
registry publication; it does not remove the standalone registry prerequisite
or authorize enrolling the runtime in automatic publishing.

After removing runtime from the automatic release list at
`09ee32ce3c669eef81dd87ff9fe330812ae3fd65`, PC qualification passed the real
`node scripts/check-rust-semver.mjs` gate (all eight published crates compared
against crates.io) and `node scripts/check-rust-api-surface.mjs` (eight crates,
720 items). Receipts are `c581a7d7-5508-4a00-941f-3ccf6443f722` and
`e1441266-edea-41aa-b1e7-916368be7751`; both confirm unchanged source. The
release-order/version-sync fixture checks and major-offset gate also passed.
`publish = false` remains removed for explicit bootstrap qualification; the
automatic list and both floors remain at their original eight crates.

## First crates.io publication (human operation)

Observed on 2026-10-29: runtime name returned HTTP 404; core and geometry latest
were 25.0.1, while this source declares 26.0.0. Recheck immediately before any
publication. Do not reuse older 22.6 bootstrap authorization for this source.

1. Obtain explicit authorization for the exact **source-only archive hash,
   source commit, name and version**, and complete review of the release list.
2. Publish prerequisite versions in the release script's actual dependency
   order: core, clash, geometry, processing, landxml, export, ffi, wasm. Runtime
   is deliberately absent from this automatic list; bootstrap it separately
   after its prerequisites are available. Runtime's first 26.0.0 upload cannot resolve
   geometry 26.0.0 until that prerequisite is visible in the registry index.
   Some versioned dev-dependencies also constrain this order.
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
