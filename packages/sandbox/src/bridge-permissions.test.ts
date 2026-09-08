/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The permission gate is the sandbox's whole capability boundary: a namespace
 * whose permission is false is never built onto `bim`, so a script cannot
 * reach it at all. Nothing pinned that. Deleting the gate in
 * `buildSchemaNamespaces` — every namespace built regardless of permissions —
 * left the package's 71 tests green, as did flipping the read-only
 * `DEFAULT_PERMISSIONS` for `mutate` and `store` to true.
 *
 * Both directions matter and are checked separately, so a regression in one
 * cannot hide behind the other:
 *   - the gate honours an explicitly-false permission, and
 *   - the *defaults* it reads are read-only for the two write capabilities.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox } from './sandbox.js';
import { DEFAULT_PERMISSIONS, type SandboxPermissions } from './types.js';

/** `typeof bim.<ns>` inside the sandbox: 'object' when built, 'undefined' when gated out. */
async function namespaceTypes(
  permissions: SandboxPermissions | undefined,
): Promise<Record<string, string>> {
  const sandbox = await createSandbox({} as BimContext, { permissions });
  try {
    const result = await sandbox.eval(
      `({
        model: typeof bim.model,
        query: typeof bim.query,
        viewer: typeof bim.viewer,
        mutate: typeof bim.mutate,
        store: typeof bim.store,
        lens: typeof bim.lens,
        create: typeof bim.create,
        files: typeof bim.files,
        export: typeof bim.export,
      })`,
      { typescript: false },
    );
    return result.value as Record<string, string>;
  } finally {
    sandbox.dispose();
  }
}

describe('sandbox permission gate', () => {
  it('does not build a namespace whose permission is explicitly false', async () => {
    const types = await namespaceTypes({
      model: false,
      query: false,
      viewer: false,
      mutate: false,
      store: false,
      lens: false,
      export: false,
      files: false,
    });

    // Every gate off: the `bim` object carries no namespace at all.
    expect(types).toEqual({
      model: 'undefined',
      query: 'undefined',
      viewer: 'undefined',
      mutate: 'undefined',
      store: 'undefined',
      lens: 'undefined',
      create: 'undefined',
      files: 'undefined',
      export: 'undefined',
    });
  });

  it('builds exactly the namespaces whose permission is true', async () => {
    const types = await namespaceTypes({
      model: false,
      query: true,
      viewer: false,
      mutate: true,
      store: false,
      lens: false,
      export: false,
      files: false,
    });

    expect(types.query).toBe('object');
    expect(types.mutate).toBe('object');
    // Everything else stays out — a gate that lets one namespace through must
    // not let the rest through with it.
    expect(types.model).toBe('undefined');
    expect(types.viewer).toBe('undefined');
    expect(types.store).toBe('undefined');
    expect(types.lens).toBe('undefined');
    expect(types.export).toBe('undefined');
    expect(types.files).toBe('undefined');
    // `bim.create` reuses the `export` permission, so it follows export, not
    // its own name.
    expect(types.create).toBe('undefined');
  });

  it('gates bim.create on the export permission it declares', async () => {
    const types = await namespaceTypes({
      model: false,
      query: false,
      viewer: false,
      mutate: false,
      store: false,
      lens: false,
      export: true,
      files: false,
    });
    expect(types.create).toBe('object');
    expect(types.export).toBe('object');
  });

  it('keeps the two write capabilities off by default', () => {
    // Asserted on the constant as well as through a sandbox below: this is the
    // published default for every caller that passes no permissions at all.
    expect(DEFAULT_PERMISSIONS.mutate).toBe(false);
    expect(DEFAULT_PERMISSIONS.store).toBe(false);
    // The read capabilities are on by default — a default of "nothing works"
    // would pass the two assertions above while breaking every caller.
    expect(DEFAULT_PERMISSIONS.model).toBe(true);
    expect(DEFAULT_PERMISSIONS.query).toBe(true);
    expect(DEFAULT_PERMISSIONS.viewer).toBe(true);
    expect(DEFAULT_PERMISSIONS.lens).toBe(true);
    expect(DEFAULT_PERMISSIONS.export).toBe(true);
    expect(DEFAULT_PERMISSIONS.files).toBe(true);
  });

  it('a default sandbox exposes the read API but neither write namespace', async () => {
    const types = await namespaceTypes(undefined);

    expect(types.mutate).toBe('undefined');
    expect(types.store).toBe('undefined');
    expect(types.query).toBe('object');
    expect(types.model).toBe('object');
    expect(types.viewer).toBe('object');
    expect(types.lens).toBe('object');
    expect(types.export).toBe('object');
    expect(types.files).toBe('object');
    expect(types.create).toBe('object');
  });
});
