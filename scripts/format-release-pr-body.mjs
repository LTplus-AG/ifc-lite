// SPDX-License-Identifier: MPL-2.0

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';

export function formatReleasePrBody(body, manifests) {
  const privateHeadings = new Set(
    manifests.filter(pkg => pkg.private).map(pkg => `## ${pkg.name}@${pkg.version}`),
  );
  return body
    .replace(
      'the packages will be published to npm automatically',
      'public packages will be published to npm automatically. Entries marked as private version bumps stay in the workspace',
    )
    .replace(/^## .+$/gm, heading => (
      privateHeadings.has(heading) ? `${heading} (private version bump)` : heading
    ));
}

if (isMainEntry(import.meta.url)) {
  // Use the same workspace package discovery as Changesets.
  const require = createRequire(import.meta.url);
  const cliRequire = createRequire(require.resolve('@changesets/cli/package.json'));
  const { getPackages } = await import(pathToFileURL(cliRequire.resolve('@manypkg/get-packages')).href);
  const { packages } = await getPackages(process.cwd());
  const body = readFileSync(0, 'utf8');
  process.stdout.write(formatReleasePrBody(body, packages.map(({ packageJson }) => packageJson)));
}
