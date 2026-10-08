/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Registry version discovery is independent of the generated fixture link.
vi.mock('../src/utils/config-fixers.js', () => ({ getPackageVersion: () => '^1.0.0' }));
import { createThreejsTemplate } from '../src/templates/threejs.js';
import { createBabylonjsTemplate } from '../src/templates/babylonjs.js';

const manifest = JSON.parse(readFileSync(new URL('../../../tests/models/manifest.json', import.meta.url), 'utf8')) as {
  base_url: string; files: Array<{ path: string; sha256: string }>;
};

describe('canonical fixture links in generated starter projects (#7072)', () => {
  it.each([
    ['Three.js', createThreejsTemplate],
    ['Babylon.js', createBabylonjsTemplate],
  ] as const)('%s README downloads the manifest fixture', (_name, scaffold) => {
    const target = mkdtempSync(join(tmpdir(), 'ifclite-fixture-link-'));
    try {
      scaffold(target, 'fixture-link-proof');
      const readme = readFileSync(join(target, 'README.md'), 'utf8');
      // @source-text-assertion-ok this README is generated output from the real scaffold, not template source
      const link = readme.match(/\[AC20-FZK-Haus\.ifc\]\(([^)]+)\)/)?.[1];
      const fixture = manifest.files.find(entry => entry.path === 'ara3d/AC20-FZK-Haus.ifc');
      expect(fixture).toBeDefined();
      expect(link).toBe(`${manifest.base_url}/${fixture?.sha256}`);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
