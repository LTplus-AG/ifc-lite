# Release Process

This project uses [Changesets](https://github.com/changesets/changesets) for automated version management and publishing.

For full details, see [RELEASE.md](https://github.com/LTplus-AG/ifc-lite/blob/main/RELEASE.md) in the project root.

## Quick Reference

### Adding a Changeset

```bash
pnpm changeset
```

This prompts you to select packages, choose a bump type (`patch`/`minor`/`major`), and write a description.

### What Gets Published

On each release, the following are published automatically:

**npm (36 packages):** All `@ifc-lite/*` packages + `create-ifc-lite`

**crates.io (6 crates):** `ifc-lite-core`, `ifc-lite-geometry`, `ifc-lite-clash`, `ifc-lite-processing`, `ifc-lite-ffi`, `ifc-lite-wasm`

**GitHub Release:** Version tag + server binaries for 6 platforms

### How Publishing Authenticates

npm publishes use OIDC trusted publishing from GitHub Actions: the workflow
exchanges an `id-token` for short-lived npm credentials and attaches
provenance to every tarball, so no long-lived npm token is stored. One
consequence: a brand-new package cannot bootstrap itself through OIDC, so new
packages need a manual first publish by a maintainer before the automated
flow can take over.

crates.io publishes run through `scripts/release-crates.mjs`
(`pnpm release:crates`), which publishes the crates in dependency order and
skips versions that already exist.

### Release Scripts

The root `package.json` wires the flow together:

| Command | What it does |
|---------|--------------|
| `pnpm changeset` | Create a changeset for your PR |
| `pnpm version` | `changeset version` + `scripts/sync-versions.js` |
| `pnpm release` | Build, verify ESM entry points, then publish npm (`changeset publish`) and crates (`scripts/release-crates.mjs`) |

### Version Synchronization

Packages version independently. Changesets still propagates internal dependency bumps, and `scripts/sync-versions.js` keeps the root package version, Cargo.toml workspace version, and internal Rust workspace dependency versions aligned with the highest released workspace package version.

### Expressing a Rust-only major

A changeset states a bump level for **npm packages**. A change can be additive in TypeScript and breaking in Rust — a new field on a `pub` struct callers construct literally, an extra parameter on a `pub fn` — and the crate would then publish under the TypeScript bump level.

`rust-major-offset.json` at the repo root is how that is said out loud:

```json
{ "majorOffset": 1, "reason": "…which crate's public API broke…", "refs": ["#3210"] }
```

`sync-versions.js` adds `majorOffset` to the **major** of the npm-derived version when it writes the Rust manifests. npm 6.1.0 with `majorOffset: 1` publishes the crates at 7.1.0; the npm packages, the root `package.json` and the `v*` tag stay on 6.1.0. At `majorOffset: 0` the two versions are the same string; the repo is at `2`, so the crates run two majors ahead of the npm packages.

- Minor and patch keep tracking npm, so raising the offset is a **once per Rust-only major** edit, not a per-release chore.
- A non-zero offset without a `reason` and at least one `refs` entry is a hard failure: a permanent major-version claim about a published crate has to say what broke.
- `pnpm check:rust-major-offset` (run on every PR) fails when the committed manifests do not match what the offset implies. Whether the offset is **large enough** is a different question, answered by `scripts/check-rust-semver.mjs` against the crate live on crates.io.

### Workflow

1. Create a PR with your changes and a changeset file
2. Merge to `main` - the Changesets bot creates a "Version Packages" PR
3. Review and merge the "Version Packages" PR to trigger publishing

See [RELEASE.md](https://github.com/LTplus-AG/ifc-lite/blob/main/RELEASE.md) for emergency manual release instructions, troubleshooting, and FAQ.
