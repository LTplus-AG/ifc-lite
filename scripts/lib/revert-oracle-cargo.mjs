import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/**
 * Directories the root workspace `Cargo.toml` excludes (`exclude = [...]`) — a
 * crate rooted there (e.g. `rust/python`, its own PyO3 workspace) cannot be run
 * as `cargo test -p <crate>` from `root`: cargo reports "package ID
 * specification did not match any packages" (#4104). `cargoTestOwner` must not
 * claim a file under one of these directories, regardless of that file's
 * language, since the oracle has no way to run it as cargo from `root` either
 * way — ownership should fall through to another owner (e.g. `pythonTestOwner`
 * for a `.py` file) or go `unassigned`, not fail with a misleading verdict.
 *
 * The array elements are matched loosely on purpose: both TOML string forms
 * (`"..."` and `'...'`) and an accidental trailing slash (`"rust/python/"`)
 * are accepted, since either would otherwise silently produce an empty list
 * and quietly reintroduce #4104. A full TOML parse would be more correct
 * still (e.g. it would also accept an exclude list split across `+=` or a
 * dotted-key form), but no manifest in this repo uses those, so the residual
 * risk is limited to a shape nobody has written.
 */
function excludedWorkspaceDirs(root) {
  const manifest = join(root, 'Cargo.toml');
  if (!existsSync(manifest)) return [];
  const toml = readFileSync(manifest, 'utf8');
  const list = /^\s*exclude\s*=\s*\[([^\]]*)\]/m.exec(toml);
  if (!list) return [];
  return [...list[1].matchAll(/["']([^"']+)["']/g)].map((m) => join(root, m[1].replace(/\/+$/, '')));
}

/**
 * The root workspace manifest's `members = [...]` entries, as raw glob
 * patterns (not yet resolved against the filesystem). `null` means the
 * manifest has no `members` key at all — an oracle-side style this repo
 * does not use, but if it ever did, refusing to guess is safer than
 * silently claiming every crate is out of the workspace.
 */
function memberPatterns(root) {
  const manifest = join(root, 'Cargo.toml');
  if (!existsSync(manifest)) return null;
  const toml = readFileSync(manifest, 'utf8');
  const list = /^\s*members\s*=\s*\[([^\]]*)\]/m.exec(toml);
  if (!list) return null;
  return [...list[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1].replace(/\/+$/, ''));
}

/**
 * Translate one `members` glob entry (e.g. `"rust/*"`) into a RegExp that
 * matches a workspace-relative, `/`-joined directory path. `*` matches
 * within a single path component (never across `/`), mirroring the `glob`
 * crate cargo itself uses to expand `members`; an entry with no `*` at all
 * degenerates to an exact match. This repo's root manifest currently uses
 * an explicit list with no globs, but cargo permits one (`members =
 * ["rust/*"]`), and an exact-match-only check would silently stop guarding
 * the day someone adds one.
 */
function globToRegExp(pattern) {
  const parts = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('[^/]*')}$`);
}

/**
 * Whether `dir` (an absolute path to a directory holding a `Cargo.toml`) is
 * reachable from the root workspace manifest's `members` list — the third
 * way a crate can sit outside the buildable workspace, alongside `exclude`
 * and an own `[workspace]` table: a crate present on disk, not excluded,
 * without its own `[workspace]`, simply never listed in `members`. Cargo
 * cannot `-p` such a crate from `root` any more than an excluded one can.
 */
function isWorkspaceMember(dir, root) {
  const patterns = memberPatterns(root);
  if (patterns === null) return true;
  const rel = relative(root, dir).split(sep).join('/');
  return patterns.some((pattern) => globToRegExp(pattern).test(rel));
}

/**
 * A crate manifest that declares its own bare `[workspace]` table (as opposed
 * to a `[workspace.*]` sub-table, e.g. `[workspace.dependencies]`) is its own
 * workspace root, independent of the root manifest's `exclude` list (#4104
 * follow-up): `rust/core/fuzz`, `rust/geometry/fuzz`, and
 * `rust/csg-thread-bench` all do this so that `cargo build --workspace` from
 * `root` ignores them entirely. `cargo test -p <crate>` run from `root` fails
 * the same way it does for an excluded crate ("package ID specification did
 * not match any packages"), so a file under one of these must not be claimed
 * either — unless the manifest in question *is* `root`'s own, in which case
 * a combined `[package]` + `[workspace]` manifest there is the primary
 * workspace, not a detached one.
 */
function hasOwnWorkspaceTable(toml) {
  return /^\s*\[workspace\]/m.test(toml);
}

/**
 * Test sources and data share the nearest Cargo package's runner (#3974),
 * unless that package's directory is excluded from the root workspace, is
 * itself the root of a separate workspace (#4104), or is simply absent from
 * the root manifest's `members` list, in which case it is not a valid cargo
 * owner for anything under it.
 */
export function cargoTestOwner(file, root) {
  let dir = dirname(file);
  const excluded = excludedWorkspaceDirs(root);
  while (!isAbsolute(relative(root, dir)) && relative(root, dir).split(sep)[0] !== '..') {
    const manifest = join(dir, 'Cargo.toml');
    if (existsSync(manifest)) {
      if (excluded.includes(dir)) return null;
      const toml = readFileSync(manifest, 'utf8');
      const name = /^\s*\[package\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m.exec(toml);
      if (!name) return null;
      if (dir !== root && hasOwnWorkspaceTable(toml)) return null;
      if (dir !== root && !isWorkspaceMember(dir, root)) return null;
      return { dir, crate: name[1] };
    }
    if (dir === root || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return null;
}
