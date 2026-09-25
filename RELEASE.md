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
   - npm packages are published to npm registry (45 `@ifc-lite/*` packages + `create-ifc-lite`)
   - Rust crates are published to crates.io (`ifc-lite-core`, `ifc-lite-clash`, `ifc-lite-geometry`, `ifc-lite-processing`, `ifc-lite-landxml`, `ifc-lite-export`, `ifc-lite-ffi`, `ifc-lite-wasm`)
   - GitHub Release is created with version tag
   - Server binaries are cross-compiled for 6 platforms (Linux x64/ARM64/musl, macOS x64/ARM64, Windows x64) and attached to the release

### A Version Packages PR must be fresh when it lands

changesets/action publishes only from a tree with **no** pending `.changeset/*.md`, and the Release workflow runs once per push to `main`, on its tip. So a push that carries a Version Packages commit *and* a pending changeset opens a new version PR and publishes nothing (#5647). That happens in two ways:

- The Version Packages PR is stale. It is refreshed by the Release run for each push, which lags `main`, and the merge queue squashes it onto whatever landed ahead of it. A changeset that landed after the last refresh is still in the tree.
- A PR with a changeset is queued behind the Version Packages PR and lands in the same push (the queue merges up to five entries at once).

Three checks stop that from passing silently. All run `scripts/check-release-late-changesets.mjs`, which compares the tree with the start of the push: it fails when versions of existing workspace packages moved in that range *and* changesets are pending at the tip.

- **Merge queue (fail closed).** The check is the first step of the `changes` job in `.github/workflows/test.yml`. That job feeds the required `Build + WASM + Rust + Node` check. On `merge_group` it compares the queued commit with the current `main` tip, and a failing entry is removed from the queue. If it is the Version Packages PR, wait for the Release run for the latest `main` push to refresh it, then queue it again. If it is an ordinary PR queued behind the Version Packages PR, queue it again once that PR has landed. On a pull request the check fails the same required check, so a stale Version Packages PR cannot be queued. On a push to `main` the commit has already landed, so it only annotates: failing `changes` there would skip every other lane of that push.
- **Version Packages PR freshness (blocks even an admin merge).** Merges on this repo normally bypass the merge queue (the `main` ruleset's admin bypass), so the `merge_group` check above rarely runs, and the Version Packages PR's own `pull_request` verdict is not recomputed when `main` moves (#5951). `.github/workflows/release-pr-freshness.yml` runs on every push to `main` and to `changeset-release/main`: it squashes the open Version Packages PR onto the current `main` tip and runs the same script. A stale PR is converted to a **draft**, which GitHub refuses to merge even with a bypass, and gets a failing `Version Packages freshness` status saying why. The Release run for the latest `main` push refreshes the PR, and that push re-runs the workflow, which marks it ready again. So: a Version Packages PR in draft is waiting for its refresh; do not un-draft it by hand.
- **Release backstop (fail loudly).** If such a push reaches `main` anyway (a bypass), its Release run still refreshes the Version Packages PR, then ends **red** with a "Release commit still carries changesets" error. The publish verifiers fail too, because the new versions are not on the registries. To recover, merge the refreshed Version Packages PR on its own: `changeset publish` ships every workspace version that is not on npm yet, including the ones the earlier commit bumped.

## Release Workflow Diagram

```
PR with changeset → Merge to main → "Version Packages" PR created
                                            ↓
                                    Review & Merge
                                            ↓
                    Build → Publish npm (46 packages) → Publish Rust (8 crates)
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
- **Rust-only majors**: `rust-major-offset.json` records how many majors ahead of npm the published crates run. `sync-versions.js` applies `majorOffset` to the Rust manifests only; npm, the root `package.json` and the `v*` tag keep the version changesets chose. At `0` both sides carry the same string. For each new Rust-only major, increment the offset exactly once, append the previous `latestBreak` to `reason` with exactly one separating space, rotate `latestBreak` to the new break, and append its issue/PR references to `refs`. `pnpm check:rust-major-offset` fails CI when the manifests and that five-key metadata contract disagree; see [docs/contributing/release.md](docs/contributing/release.md#expressing-a-rust-only-major)

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

### "Release commit still carries changesets"
- The Version Packages PR was stale when it merged or was queued. See [A Version Packages PR must be fresh when it lands](#a-version-packages-pr-must-be-fresh-when-it-lands).

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
