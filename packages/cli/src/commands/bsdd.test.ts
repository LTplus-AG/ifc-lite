/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite bsdd` parsed `--json` into a variable it never read: every
 * subcommand called `printJson(...)` unconditionally, so `bsdd class
 * IfcWall` and `bsdd class IfcWall --json` produced byte-identical output
 * and there was no human-readable mode at all, unlike every other CLI
 * command with a `--json` flag (e.g. `ext capabilities`). This pins the
 * observable fix: omitting `--json` now prints a human-readable summary,
 * and `--json` still prints the raw structured payload.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('@ifc-lite/sdk', () => {
  class BsddNamespace {
    async fetchClassInfo(ifcType: string) {
      return {
        uri: `https://example.org/class/${ifcType}`,
        code: ifcType,
        name: 'Wall',
        definition: 'A vertical construction.',
        parentClassUri: null,
        relatedIfcEntityNames: null,
        classProperties: [
          { name: 'IsExternal', uri: 'u1', description: 'Externality', dataType: 'Boolean', propertySet: 'Pset_WallCommon', allowedValues: null, units: null, isIfcStandard: true },
        ],
      };
    }
  }
  return { BsddNamespace };
});

const { bsddCommand } = await import('./bsdd.js');

afterEach(() => {
  vi.restoreAllMocks();
});

function captureStdio(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

describe('bsddCommand --json', () => {
  it('prints a human-readable summary without --json, and raw JSON with --json', async () => {
    const withoutJson = captureStdio();
    await bsddCommand(['class', 'IfcWall']);
    const plainOut = withoutJson.out.join('');

    const withJson = captureStdio();
    await bsddCommand(['class', 'IfcWall', '--json']);
    const jsonOut = withJson.out.join('');

    // The two modes must differ: this is the flag's whole point.
    expect(plainOut).not.toBe(jsonOut);

    // --json output must remain a parseable structured payload.
    expect(() => JSON.parse(jsonOut)).not.toThrow();

    // Without --json, output must not just be pretty-printed JSON: it must
    // not parse as JSON at all (it's the human summary).
    expect(() => JSON.parse(plainOut)).toThrow();
  });
});
