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

### Workflow

1. Create a PR with your changes and a changeset file
2. Merge to `main` - the Changesets bot creates a "Version Packages" PR
3. Review and merge the "Version Packages" PR to trigger publishing

See [RELEASE.md](https://github.com/LTplus-AG/ifc-lite/blob/main/RELEASE.md) for emergency manual release instructions, troubleshooting, and FAQ.
