import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/** Test sources and data share the nearest Cargo package's runner (#3974). */
export function cargoTestOwner(file, root) {
  let dir = dirname(file);
  while (!isAbsolute(relative(root, dir)) && relative(root, dir).split(sep)[0] !== '..') {
    const manifest = join(dir, 'Cargo.toml');
    if (existsSync(manifest)) {
      const toml = readFileSync(manifest, 'utf8');
      const name = /^\s*\[package\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m.exec(toml);
      return name ? { dir, crate: name[1] } : null;
    }
    if (dir === root || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return null;
}
