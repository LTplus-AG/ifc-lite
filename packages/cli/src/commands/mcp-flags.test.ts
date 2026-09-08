/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite mcp` must not mistake an option's VALUE for a model path.
 *
 * The subcommand and the standalone `ifc-lite-mcp` binary are two front doors
 * to the same server. The binary reads a flag and consumes its value in one
 * branch so it cannot disagree with itself; the subcommand only needs to know
 * WHICH flags carry a value, and kept a hand-written copy of that list. The
 * copy drifted — `--allow-origin` reached the binary and never the copy — so
 * the origin after it was resolved as an IFC file. The list now comes from
 * `@ifc-lite/mcp/cli-args`, checked there against the binary's real parser.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { collectModelPaths } from './mcp.js';

describe('collectModelPaths', () => {
  it('does not resolve an --allow-origin value as a model path', () => {
    const { files } = collectModelPaths([
      '--transport', 'http',
      '--allow-origin', 'https://app.example.test',
      'model.ifc',
    ]);
    expect(files).toEqual([resolve('model.ifc')]);
  });

  it('skips the value of every value-bearing flag', () => {
    const { files } = collectModelPaths([
      '--port', '8765',
      '--host', '127.0.0.1',
      '--token', 'secret-placeholder',
      '--bsdd', 'https://bsdd.example.test',
      '--allow', '/models',
      '--viewer-port', '0',
      'a.ifc', 'b.ifc',
    ]);
    expect(files).toEqual([resolve('a.ifc'), resolve('b.ifc')]);
  });

  it('does not swallow the model path after a boolean flag', () => {
    const { files } = collectModelPaths(['--read-only', 'model.ifc']);
    expect(files).toEqual([resolve('model.ifc')]);
  });

  it('reports the binary-only flags instead of silently ignoring them', () => {
    const { unsupported } = collectModelPaths([
      '--allow-origin', 'https://app.example.test',
      '--federate',
      'model.ifc',
    ]);
    expect(unsupported).toEqual(['--allow-origin', '--federate']);
  });

  it('reports nothing when every flag is one the subcommand honours', () => {
    const { unsupported } = collectModelPaths(['--read-only', '--port', '8765', 'model.ifc']);
    expect(unsupported).toEqual([]);
  });
});
