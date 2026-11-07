/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fs from 'node:fs';
import path from 'node:path';

interface PackageVersion {
  name: string;
  version: string;
}

// Collect all package versions
export function collectPackageVersions(packagesDir: string): PackageVersion[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(packagesDir);
  } catch (error) {
    console.warn('[vite] Could not read package versions', error);
    return [];
  }

  const versions: PackageVersion[] = [];
  for (const dir of dirs) {
    const pkgPath = path.join(packagesDir, dir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.name && pkg.version) {
        versions.push({ name: pkg.name, version: pkg.version });
      }
    } catch (error) { console.warn(`[vite] Could not read package version: ${pkgPath}`, error); }
  }
  return versions.sort((a, b) => a.name.localeCompare(b.name));
}
