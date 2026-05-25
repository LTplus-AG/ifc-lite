/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Centralised toast phrasing for the extensions / flavors surfaces.
 * Keeps tone, capitalisation, and trailing-punctuation consistent
 * across call sites.
 *
 * Callers pass the result to `toast.success` / `toast.info` /
 * `toast.error` so the colour mapping stays at the call site.
 */

export function flavorSwitched(name: string): string {
  return `Switched to ${name}`;
}

export function flavorExported(filename: string): string {
  return `Exported ${filename}`;
}

export function flavorImported(name: string): string {
  return `Imported ${name}`;
}

export function flavorDeleted(name: string): string {
  return `Deleted ${name}`;
}

export function flavorReset(): string {
  return 'Reset to baseline flavor';
}

export function testsPassed(id: string, passed: number, total: number): string {
  return `${id}: ${passed}/${total} tests passed`;
}

export function testsNotDeclared(id: string): string {
  return `${id} declares no tests`;
}

export function testsFailed(id: string, failed: number, firstError: string): string {
  return `${id}: ${failed} test${failed === 1 ? '' : 's'} failed — ${firstError}`;
}

export function failed(operation: string, err: unknown): string {
  const cause = err instanceof Error ? err.message : String(err);
  return `${operation} failed — ${cause}`;
}
