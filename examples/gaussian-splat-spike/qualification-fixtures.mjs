/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567: analytic controls, not captured geometry or survey alignment.
// Only emits standard binary little-endian Gaussian PLY; no decoder or renderer.
export const qualificationColumns = [
  'x', 'y', 'z', 'nx', 'ny', 'nz',
  'f_dc_0', 'f_dc_1', 'f_dc_2',
  ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
  'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
];
export function qualificationPly({ batches = 32, perBatch = 257 } = {}) {
  if (!Number.isInteger(batches) || !Number.isInteger(perBatch) || batches < 1 || perBatch < 1 || batches * perBatch > 16384) {
    throw new Error('analytic fixture budget: 1..16384 rows');
  }
  const count = batches * perBatch;
  const header = Buffer.from(`ply\nformat binary_little_endian 1.0\ncomment MPL-2.0 analytic control, no survey provenance\nelement vertex ${count}\n${qualificationColumns.map(name => `property float ${name}\n`).join('')}end_header\n`);
  const body = Buffer.alloc(count * qualificationColumns.length * 4);
  for (let row = 0; row < count; row++) {
    const batch = Math.floor(row / perBatch), local = row % perBatch;
    // Every contiguous source batch overlaps every other batch in depth.
    // Exact binary fractions keep independent coefficient assertions simple.
    const values = [batch, local, -(local * batches + batch + 1), 0, 0, 1,
      0.25, 0.5, 0.75, ...Array.from({ length: 45 }, (_, k) => ((row % 7) - 3) * (k + 1) / 1024),
      0, -2, -3, -4, 1, 0, 0, 0];
    values.forEach((value, column) => body.writeFloatLE(value, (row * values.length + column) * 4));
  }
  return Buffer.concat([header, body]);
}
export function malformedQualificationPly() {
  const valid = qualificationPly({ batches: 1, perBatch: 1 });
  const end = valid.indexOf('end_header\n') + 'end_header\n'.length;
  const nonfinite = Buffer.from(valid);
  nonfinite.writeFloatLE(NaN, end);
  return [
    { id: 'truncated-record', bytes: valid.subarray(0, valid.length - 1), expected: 'reject' },
    { id: 'nonfinite-position', bytes: nonfinite, expected: 'reject-or-diagnose', pending: 'Production finite-channel validation is M2; upstream decode may preserve NaN.' },
  ];
}
