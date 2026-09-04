/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The server templates scaffold `parquet-wasm` as an optional dependency, and
 * @ifc-lite/server-client declares the same package as an optional peer. A
 * scaffold that pins a version outside that peer range is rejected outright by
 * strict peer resolution, and under a permissive package manager it silently
 * installs a decoder the SDK does not support. The pins are written by hand in
 * two separate files, so nothing but this test keeps them inside the contract.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

const TEMPLATES = [
  'packages/create-ifc-lite/src/templates/server.ts',
  'packages/create-ifc-lite/src/templates/server-native.ts',
];

type Caret = { major: number; minor: number; patch: number };

/**
 * Parse `^X.Y.Z`. Anything else throws, so a range format this test cannot
 * reason about fails loudly instead of passing vacuously.
 */
function parseCaret(range: string, what: string): Caret {
  // @source-text-assertion-ok shape guard, not a subject assertion: a range outside ^X.Y.Z throws below instead of being mis-compared
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!match) {
    throw new Error(`${what} is "${range}", which this test can only check in ^X.Y.Z form.`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Does the floor of a caret range fall inside another caret range? A caret on a
 * 0.x version pins the minor too, so `^0.7.2` excludes 0.8.0 while `^1.7.2`
 * includes 1.8.0.
 */
function floorSatisfies(candidate: Caret, allowed: Caret): boolean {
  if (candidate.major !== allowed.major) return false;
  if (allowed.major === 0 && candidate.minor !== allowed.minor) return false;
  if (candidate.minor !== allowed.minor) return candidate.minor > allowed.minor;
  return candidate.patch >= allowed.patch;
}

function readPeerRange(): string {
  const pkg = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'packages/server-client/package.json'), 'utf-8')
  );
  const range = pkg.peerDependencies?.['parquet-wasm'];
  if (typeof range !== 'string') {
    throw new Error('@ifc-lite/server-client no longer declares a parquet-wasm peer dependency.');
  }
  return range;
}

function readTemplatePin(relativePath: string): string {
  const source = readFileSync(resolve(REPO_ROOT, relativePath), 'utf-8');
  // @source-text-assertion-ok the hand-written pin literal is the subject; scaffolding it instead needs getPackageVersion, which shells out to `npm view`
  const match = /'parquet-wasm':\s*'([^']+)'/.exec(source);
  if (!match) {
    throw new Error(`${relativePath} no longer pins parquet-wasm in a scaffolded package.json.`);
  }
  return match[1];
}

describe('server template dependency pins', () => {
  it.each(TEMPLATES)('%s scaffolds a parquet-wasm inside the server-client peer range', (template) => {
    const peerRange = readPeerRange();
    const templateRange = readTemplatePin(template);

    const peer = parseCaret(peerRange, 'The @ifc-lite/server-client parquet-wasm peer range');
    const pinned = parseCaret(templateRange, `The parquet-wasm pin in ${template}`);

    expect(
      floorSatisfies(pinned, peer),
      `${template} pins parquet-wasm ${templateRange}, outside the server-client peer range ${peerRange}.`
    ).toBe(true);
  });
});
