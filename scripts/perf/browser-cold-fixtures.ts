/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { statSync } from 'node:fs';

export function browserFixtureKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '_');
}

/** Explicit cohorts must neither shrink silently nor pool distinct fixtures. */
export function validateBrowserFixtures(fixtures: readonly { name: string; path: string }[]): void {
  const names = new Set<string>();
  const keys = new Set<string>();
  if (!fixtures.length) throw new Error('No fixtures selected');
  for (const fixture of fixtures) {
    if (typeof fixture.name !== 'string' || !fixture.name || typeof fixture.path !== 'string') throw new Error('Invalid fixture name/path');
    const key = browserFixtureKey(fixture.name);
    if (names.has(fixture.name)) throw new Error(`Duplicate fixture label: ${fixture.name}`);
    if (keys.has(key)) throw new Error(`Colliding fixture artifact key: ${fixture.name}`);
    names.add(fixture.name); keys.add(key);
    try {
      if (!statSync(fixture.path).isFile()) throw new Error('not a regular file');
    } catch (error) {
      throw new Error(`Fixture missing or unreadable: ${fixture.name}: ${String(error)}`);
    }
  }
}
