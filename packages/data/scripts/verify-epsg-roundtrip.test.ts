/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtures, verifyFixture } from './verify-epsg-roundtrip.js';

/**
 * Runs the curated EPSG control points as part of `pnpm test`.
 *
 * The verification itself is not new — `verify-epsg-roundtrip.ts` has always
 * done this, and does it well, reprojecting published landmark coordinates
 * (the Amersfoort tower, the Rostock control point) through the bundled proj4
 * definitions and demanding agreement within a metre. What was missing is that
 * it only ran when somebody typed `pnpm verify:epsg`, so nothing failed if
 * they didn't.
 *
 * Measured on this branch: changing EPSG:28992's `lon_0` from 5.3876 to
 * 5.2876 -- a plausible transcription slip, and about 700 metres on the
 * ground -- leaves `packages/data` at 173/173 passing and the viewer's
 * `reproject.test.ts` at 32/32. The standalone script catches it immediately
 * (`fwd=6828.75m` against a 1 m tolerance). This file is the wiring, not the
 * check.
 *
 * `epsg-index.test.ts` covers lookup and search over the same index, but
 * nothing there asks whether a definition is geodetically *correct*: a CRS can
 * be found by code and name while placing the model in the wrong country.
 *
 * The whole set runs in well under a second, so there is no reason for it to
 * be opt-in. Each fixture is its own `it` so a failure names the CRS rather
 * than reporting "17 fixtures, 1 failed".
 */

const fixtures = loadFixtures();

describe('bundled EPSG definitions place published control points correctly', () => {
  it('the fixture set is present and non-empty', () => {
    // If the JSON ever fails to resolve, every generated case below would
    // silently vanish and this file would pass by testing nothing.
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`EPSG:${fixture.epsg} — ${fixture.name}`, async () => {
      const result = await verifyFixture(fixture);

      // `reason` carries the specific failure (code absent from the index, no
      // proj4 string, a transform that threw). Surface it rather than letting
      // the numeric assertion below report a bare null.
      expect(result.reason ?? null, `EPSG:${fixture.epsg} ${result.reason ?? ''}`).toBeNull();

      expect(result.forwardErrorM).not.toBeNull();
      expect(result.roundTripErrorM).not.toBeNull();

      // Forward: does the bundled definition put the published projected
      // coordinate at its published latitude and longitude? This is the check
      // that catches a wrong ellipsoid, meridian, or missing datum shift --
      // the errors that land a model in the wrong place with no complaint.
      expect(
        result.forwardErrorM!,
        `EPSG:${fixture.epsg} forward error ${result.forwardErrorM!.toFixed(2)}m ` +
          `exceeds the ${fixture.tolerance_m}m tolerance (${fixture.control_point.description})`,
      ).toBeLessThanOrEqual(fixture.tolerance_m);

      // Round trip is a weaker check on its own -- a definition can be
      // self-consistently wrong -- but it catches a non-invertible or
      // numerically unstable projection that the forward check would pass.
      expect(
        result.roundTripErrorM!,
        `EPSG:${fixture.epsg} round-trip error ${result.roundTripErrorM!.toFixed(2)}m ` +
          `exceeds the ${fixture.tolerance_m}m tolerance`,
      ).toBeLessThanOrEqual(fixture.tolerance_m);

      expect(result.pass, `EPSG:${fixture.epsg} ${result.reason ?? 'failed verification'}`).toBe(true);
    });
  }
});

describe('the CLI entry point still fires when reached through a symlink', () => {
  // The cases above import the module, where the entry-point guard is always
  // false by construction — so they cannot see it break. Only spawning the
  // file as a real process can.
  //
  // The guard compares REAL paths because `import.meta.url` is resolved
  // through symlinks and `process.argv[1]` is not. Comparing them with a
  // plain `path.resolve` makes the guard silently false whenever the script
  // is reached through a link: `main()` never runs, nothing prints, and the
  // process exits 0. `pnpm verify:epsg` would then report success having
  // verified nothing, which is worse than having no gate.
  //
  // macOS makes this the DEFAULT rather than an edge case: `os.tmpdir()` is
  // `/var/folders`, itself a symlink to `/private/var/folders`.
  const scriptPath = fileURLToPath(new URL('./verify-epsg-roundtrip.ts', import.meta.url));
  const tsxBin = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));

  it.skipIf(!fs.existsSync(tsxBin))('runs the fixtures and exits 0 via a symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epsg-entry-'));
    const link = path.join(dir, 'linked-verify.ts');
    try {
      fs.symlinkSync(scriptPath, link);
      const stdout = execFileSync(tsxBin, [link], {
        cwd: path.dirname(scriptPath),
        encoding: 'utf8',
        timeout: 60_000,
      });
      // The report only exists if `main()` actually ran. An empty stdout with
      // a 0 exit is exactly the silent failure being guarded against.
      expect(stdout).toMatch(/fixtures passed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
