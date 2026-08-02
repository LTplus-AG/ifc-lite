# Release Process

This project uses [Changesets](https://github.com/changesets/changesets) for automated version management and publishing to npm and crates.io.

## How It Works

The release process is **fully automated** via GitHub Actions. All you need to do is:

1. Add changesets to your PRs
2. Merge the automated "Version Packages" PR when ready to release

## Developer Workflow

### Adding Changes (Required for PRs)

When you make changes that should be included in the next release, add a changeset:

```bash
pnpm changeset
```

This will prompt you to:
1. **Select packages** that changed
2. **Choose bump type**: `patch` (bug fix), `minor` (feature), or `major` (breaking change)
3. **Write a description** of the changes (will appear in CHANGELOG.md)

This creates a markdown file in `.changeset/` that describes the change.

**Example changeset:**
```markdown
---
"@ifc-lite/parser": minor
"@ifc-lite/renderer": minor
---

Add support for IFC4X3 entities
```

### What Happens Next (Automatic)

1. **When PR is merged to main**:
   - GitHub Actions runs
   - Changesets bot creates/updates a "Version Packages" PR
   - This PR includes:
     - Version bumps in all `package.json` and `Cargo.toml` files
     - Updated `CHANGELOG.md` with all accumulated changes
     - Synced versions between npm and Rust

2. **When "Version Packages" PR is merged**:
   - All packages are automatically built
   - npm packages are published to npm registry (35 `@ifc-lite/*` packages + `create-ifc-lite`)
   - Rust crates are published to crates.io (`ifc-lite-core`, `ifc-lite-geometry`, `ifc-lite-clash`, `ifc-lite-processing`, `ifc-lite-ffi`, `ifc-lite-wasm`)
   - GitHub Release is created with version tag
   - Server binaries are cross-compiled for 6 platforms (Linux x64/ARM64/musl, macOS x64/ARM64, Windows x64) and attached to the release

## Release Workflow Diagram

```
PR with changeset → Merge to main → "Version Packages" PR created
                                            ↓
                                    Review & Merge
                                            ↓
                    Build → Publish npm (36 packages) → Publish Rust (6 crates)
                                            ↓
                    Create GitHub Release → Build server binaries (6 platforms)
```

> **Workflow file**: [`.github/workflows/release.yml`](.github/workflows/release.yml)

## Manual Release (Emergency Only)

If you need to manually release:

```bash
# 1. Add changeset if you haven't
pnpm changeset

# 2. Bump versions
pnpm version

# 3. Commit changes
git add .
git commit -m "chore: version packages"

# 4. Build and publish
pnpm release
```

## Version Synchronization

Packages are versioned independently:

- **Independent versioning**: `@ifc-lite/*` packages only bump when they have their own changeset or when Changesets propagates an internal dependency update
- **Automatic sync**: `scripts/sync-versions.js` syncs the root package version, `Cargo.toml` workspace version, and internal Rust workspace dependency versions to the highest released workspace package version
- **Dependency propagation**: `updateInternalDependencies: "patch"` keeps dependents aligned when an internal package version changes

## Publish Authentication

No long-lived registry tokens are stored as secrets. The release workflow uses
OIDC trusted publishing for both registries:

- **npm**: the workflow's `id-token: write` permission plus the npm CLI's OIDC
  handshake mints a short-lived credential at publish time (with SLSA
  provenance). New packages need one manual first publish before trusted
  publishing can take over.
- **crates.io**: `rust-lang/crates-io-auth-action` exchanges the workflow's
  OIDC token for a short-lived crates.io token.
- `GITHUB_TOKEN`: automatically provided by GitHub Actions.

## FAQ

### Q: Do I need to update version numbers manually?
**A:** No! Changesets handles all version bumps automatically.

### Q: When do packages get published?
**A:** Only when the "Version Packages" PR is merged to main.

### Q: Can I see what will be released before publishing?
**A:** Yes! Review the "Version Packages" PR to see all version bumps and CHANGELOG entries.

### Q: What if I forget to add a changeset?
**A:** The "Version Packages" PR won't include your changes. Add a changeset and push to main - the bot will update the PR.

### Q: Can I release a single package?
**A:** Yes. Packages version independently, although Changesets will still bump dependents when internal package ranges need to stay aligned.

### Q: What if publishing fails?
**A:** The workflow has built-in retry logic. Rust crates publish with 30s delays between each. If a version is already published, it's skipped safely.

## Best Practices

1. **Add changesets in feature PRs**: Include the changeset file in your PR for review
2. **Clear descriptions**: Write good changeset descriptions - they become your CHANGELOG
3. **Appropriate bump types**:
   - `patch`: Bug fixes, docs, tests
   - `minor`: New features (backwards compatible)
   - `major`: Breaking changes
4. **Batch releases**: Don't merge "Version Packages" PR immediately - let multiple changes accumulate
5. **Review before release**: Always review the "Version Packages" PR before merging

## Troubleshooting

### Changesets bot isn't creating a PR
- Check that changesets exist in `.changeset/` (not just README.md and config.json)
- Verify GitHub Actions has write permissions
- Check workflow logs in Actions tab

### Publishing fails
- Confirm the release workflow requests `id-token: write` (required for the OIDC handshake) alongside the other GitHub Actions permissions
- Verify the npm trusted-publisher config lists this repo + workflow for the `@ifc-lite/*` packages
- For a brand-new package, do the one-time manual first publish before trusted publishing can take over
- For Rust: confirm the crates.io trusted-publisher config is set for the crate
- Check if versions already exist on registries

### Versions out of sync
- Run `pnpm version` locally to sync
- Commit the changes and push

## Migration Notes

This project migrated from manual versioning to Changesets. The old workflow:
- ❌ Manual version bumps in multiple files
- ❌ Manual git tags
- ❌ Publishing on every push to main
- ❌ Error-prone and easy to forget steps

The new workflow:
- ✅ Automated version bumps
- ✅ Single source of truth (changesets)
- ✅ Publishing only on explicit merge
- ✅ Clear audit trail via "Version Packages" PR
