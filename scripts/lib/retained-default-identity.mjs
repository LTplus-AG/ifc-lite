// SPDX-License-Identifier: MPL-2.0
import { readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

// Archive mtimes describe commits, not this extraction. Cargo must see fresh inputs.
export function refreshSourceMtimes(directory) {
  const now = new Date();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) refreshSourceMtimes(path);
    else if (entry.isFile()) utimesSync(path, now, now);
  }
}

export function assertWorkspaceCompiled(log, arm) {
  const crates = ['ifc-lite-core', 'ifc-lite-geometry', 'ifc-lite-processing', 'ifc-lite-wasm'];
  const missing = crates.filter(crate => !new RegExp(`^\\s*Compiling ${crate} v[^\\n]*`, 'm').test(log));
  if (missing.length) {
    throw new Error(`Default identity ${arm} did not compile workspace crates: ${missing.join(', ')}; cached artifacts cannot establish identity`);
  }
}
