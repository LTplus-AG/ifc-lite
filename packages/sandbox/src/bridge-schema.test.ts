/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { NAMESPACE_SCHEMAS } from './bridge-schema.js';
import { createSandbox } from './sandbox.js';

const CREATE_ONLY_PERMISSIONS = {
  query: false,
  mutate: false,
  viewer: false,
  export: true,
  model: false,
  lens: false,
  files: false,
} as const;

describe('bim.create bridge schema', () => {
  it('wires hosted element and profile helpers with their actual signatures', () => {
    const createNamespace = NAMESPACE_SCHEMAS.find((schema) => schema.name === 'create');
    expect(createNamespace).toBeDefined();

    const createProfile = createNamespace?.methods.find((method) => method.name === 'createProfile');
    expect(createProfile?.args).toEqual(['number', 'dump']);
    expect(createProfile?.paramNames).toEqual(['handle', 'profile']);

    const addIfcWallDoor = createNamespace?.methods.find((method) => method.name === 'addIfcWallDoor');
    expect(addIfcWallDoor?.args).toEqual(['number', 'number', 'dump']);
    expect(addIfcWallDoor?.paramNames).toEqual(['handle', 'wallId', 'params']);

    const addIfcWallWindow = createNamespace?.methods.find((method) => method.name === 'addIfcWallWindow');
    expect(addIfcWallWindow?.args).toEqual(['number', 'number', 'dump']);
    expect(addIfcWallWindow?.paramNames).toEqual(['handle', 'wallId', 'params']);
  });

  it('does not expose a namespace whose permission is disabled', async () => {
    // Counterfactual, not just a boundary check: bim.mutate (disabled here)
    // and bim.query (left enabled) are evaluated in the SAME session, so a
    // passing assertion on bim.mutate cannot be explained by the sandbox
    // being broken in general — bim.query proves the sandbox is otherwise
    // functional. mutate:false is also DEFAULT_PERMISSIONS' own default, so
    // this exercises the exact posture production code ships with.
    const sandbox = await createSandbox({} as BimContext, {
      permissions: { mutate: false, query: true },
    });
    try {
      await expect(sandbox.eval('typeof bim.mutate', { typescript: false })).resolves.toMatchObject({
        value: 'undefined',
      });
      await expect(sandbox.eval('bim.mutate.setName', { typescript: false })).rejects.toThrow();

      await expect(sandbox.eval('typeof bim.query', { typescript: false })).resolves.toMatchObject({
        value: 'object',
      });
    } finally {
      sandbox.dispose();
    }
  });

  it('isolates creator handles per sandbox session', async () => {
    const sandboxA = await createSandbox({} as BimContext, {
      permissions: CREATE_ONLY_PERMISSIONS,
    });
    const sandboxB = await createSandbox({} as BimContext, {
      permissions: CREATE_ONLY_PERMISSIONS,
    });

    try {
      const handleResult = await sandboxA.eval('bim.create.project({ Name: "Session A" })', {
        typescript: false,
      });
      const handle = handleResult.value as number;

      await expect(
        sandboxB.eval(`bim.create.toIfc(${handle})`, {
          typescript: false,
        }),
      ).rejects.toThrow('Invalid creator handle');
    } finally {
      sandboxA.dispose();
      sandboxB.dispose();
    }
  });
});
