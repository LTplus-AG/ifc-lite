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
 */
function excludedWorkspaceDirs(root) {
  const manifest = join(root, 'Cargo.toml');
  if (!existsSync(manifest)) return [];
  const toml = readFileSync(manifest, 'utf8');
  const list = /^\s*exclude\s*=\s*\[([^\]]*)\]/m.exec(toml);
  if (!list) return [];
  return [...list[1].matchAll(/"([^"]+)"/g)].map((m) => join(root, m[1]));
}

/**
 * Test sources and data share the nearest Cargo package's runner (#3974),
 * unless that package's directory is excluded from the root workspace
 * (#4104), in which case it is not a valid cargo owner for anything under it.
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
      return name ? { dir, crate: name[1] } : null;
    }
    if (dir === root || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return null;
}
