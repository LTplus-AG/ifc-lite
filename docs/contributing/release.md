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

**npm (18 packages):** All `@ifc-lite/*` packages + `create-ifc-lite`

**crates.io (3 crates):** `ifc-lite-core`, `ifc-lite-geometry`, `ifc-lite-wasm`

**GitHub Release:** Version tag + server binaries for 6 platforms

### Version Synchronization

Packages version independently. Changesets still propagates internal dependency bumps, and `scripts/sync-versions.js` keeps the root package version, Cargo.toml workspace version, and internal Rust workspace dependency versions aligned with the highest released workspace package version.

### Workflow

1. Create a PR with your changes and a changeset file
2. Merge to `main` - the Changesets bot creates a "Version Packages" PR
3. Review and merge the "Version Packages" PR to trigger publishing

See [RELEASE.md](https://github.com/LTplus-AG/ifc-lite/blob/main/RELEASE.md) for emergency manual release instructions, troubleshooting, and FAQ.
