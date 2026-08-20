/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `vitest.setup.ts` warms the packages the namespaces import lazily, so no
 * test pays a cold import inside its own 5000ms budget. Nothing about that
 * arrangement is self-checking: the list is maintained by hand against `src`,
 * and a seventh dynamic import added later would simply not be warmed. The
 * failure is a flake under CI load, months later, in whichever unrelated test
 * happened to run first -- and an un-warmed package is indistinguishable from
 * a warmed one until that happens.
 *
 * So the list is checked against the source it mirrors, by reading both as
 * TEXT. Deliberately not by importing `vitest.setup.ts`: importing it would
 * execute its top-level warm-up and, more importantly, would let a rename keep
 * the test passing while the setup file no longer matched `src` at all.
 */
const here = dirname(fileURLToPath(import.meta.url));
const namespacesDir = here;
const setupFile = join(here, '..', '..', 'vitest.setup.ts');

/** Every `@ifc-lite/*` specifier a namespace loads via a dynamic `import()`. */
function specifiersLazilyImportedBySource(): Set<string> {
  const found = new Set<string>();
  for (const entry of readdirSync(namespacesDir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    const source = readFileSync(join(namespacesDir, entry), 'utf8');
    // The loader idiom is a `const <x>Name = '@ifc-lite/...'` binding handed
    // to `import(...)`; matching the binding rather than the call keeps this
    // robust to how the call itself is formatted or commented.
    if (!source.includes('import(')) continue;
    for (const m of source.matchAll(/const\s+\w*[Nn]ame\s*=\s*'(@ifc-lite\/[^']+)'/g)) {
      found.add(m[1]);
    }
  }
  return found;
}

function specifiersListedInSetup(): Set<string> {
  const setup = readFileSync(setupFile, 'utf8');
  const list = setup.slice(setup.indexOf('LAZY_NAMESPACE_PACKAGES'));
  const body = list.slice(0, list.indexOf('];'));
  return new Set([...body.matchAll(/'(@ifc-lite\/[^']+)'/g)].map((m) => m[1]));
}

describe('the lazy-import warm-up in vitest.setup.ts', () => {
  it('is not silently measuring nothing: the source really does lazily import', () => {
    // Control. If the loader idiom is refactored away, every assertion below
    // passes vacuously against two empty sets. This is the assertion that
    // fails loudly instead, and points at rewriting the scan.
    const fromSource = specifiersLazilyImportedBySource();
    expect(
      fromSource.size,
      'no dynamic @ifc-lite import found in src/namespaces -- the scan below ' +
        'would compare two empty sets and pass without checking anything',
    ).toBeGreaterThan(0);
  });

  it('warms every package the namespaces import lazily', () => {
    const missing = [...specifiersLazilyImportedBySource()].filter(
      (name) => !specifiersListedInSetup().has(name),
    );
    expect(
      missing,
      'these are imported lazily by src/namespaces but not warmed in ' +
        'vitest.setup.ts, so the first test to touch one pays its cold import ' +
        'inside a 5000ms budget -- add them to LAZY_NAMESPACE_PACKAGES',
    ).toEqual([]);
  });

  it('does not warm packages nothing imports lazily any more', () => {
    const stale = [...specifiersListedInSetup()].filter(
      (name) => !specifiersLazilyImportedBySource().has(name),
    );
    expect(
      stale,
      'these are warmed in vitest.setup.ts but no longer imported lazily by ' +
        'src/namespaces -- every test file pays for them for nothing',
    ).toEqual([]);
  });
});
