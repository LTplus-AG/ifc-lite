/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Load a module a test is about inside the test, so that reverting the
 * production change fails an assertion instead of the test file's load
 * (#8890; the revert oracle reads a load failure as "no assertion ran").
 * The vitest twin of the viewer's `required-module.ts`.
 */
import { expect } from 'vitest';

const MISSING = /Failed to load url|Cannot find module|ERR_MODULE_NOT_FOUND|does not exist/;

export async function requiredModule<T>(load: () => Promise<T>, behaviour: string): Promise<T> {
  let loaded: T | undefined;
  try {
    loaded = await load();
  } catch (error) {
    // Only a missing module becomes the assertion below; anything else is a real failure.
    if (!(error instanceof Error) || !MISSING.test(`${error.message} ${String((error as { code?: unknown }).code ?? '')}`)) throw error;
  }
  expect(loaded !== undefined, behaviour).toBe(true);
  return loaded as T;
}

/** A function the change adds to an existing module: asserted present before it is called. */
export function requiredFunction<F>(value: F | undefined, behaviour: string): F {
  expect(typeof value, behaviour).toBe('function');
  return value as F;
}
