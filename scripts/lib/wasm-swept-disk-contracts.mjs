/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Exercise the published JavaScript wrapper and real Rust extractor (#5770). */
export function runSweptDiskContracts(api, test, rootDir) {
  const fixture = (name) => readFileSync(join(
    rootDir, 'rust/geometry/tests/fixtures', name,
  ));

  test('#5770: authored line, radius and centreline length cross the WASM boundary', () => {
    const document = api.extractSweptDiskDescriptions(fixture('swept_disk_trimmed_line.ifc'));
    assert.equal(document.up_axis, 'Z');
    assert.equal(document.units, 'm');
    assert.equal(document.coordinate_space, 'absolute_ifc_world');
    assert.deepEqual(document.diagnostics, []);
    const occurrence = document.elements['50'][0];
    assert.equal(occurrence.status.type, 'complete');
    assert.equal(occurrence.Directrix.length, 1);
    assert.equal(occurrence.Directrix[0].type, 'line');
    assert.ok(Math.abs(occurrence.Radius - 0.0145) < 1e-9);
    assert.ok(Math.abs(occurrence.directrix_metrics.total_length - 2.75) < 1e-9);
    assert.equal(occurrence.directrix_metrics.segments[0].bend_angle, null);
    assert.equal(occurrence.InnerRadius, null);
  });

  test('#5770: ordered arcs, bends and optional product IDs cross the WASM boundary', () => {
    const source = fixture('swept_disk_composite_arc_ubar.ifc');
    const none = api.extractSweptDiskDescriptions(source, new Uint32Array());
    assert.deepEqual(none.elements, {});
    const document = api.extractSweptDiskDescriptions(source, new Uint32Array([125]));
    assert.deepEqual(Object.keys(document.elements), ['125']);
    const occurrence = document.elements['125'][0];
    assert.equal(occurrence.Directrix.length, 5);
    assert.deepEqual(occurrence.Directrix.map((segment) => segment.type),
      ['line', 'arc', 'line', 'arc', 'line']);
    assert.ok(Math.abs(occurrence.directrix_metrics.segments[1].bend_angle - Math.PI / 2) < 1e-9);
    assert.ok(Math.abs(occurrence.directrix_metrics.segments[3].bend_angle - Math.PI / 2) < 1e-9);
  });
}
