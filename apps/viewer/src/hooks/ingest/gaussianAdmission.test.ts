// SPDX-License-Identifier: MPL-2.0
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlyHeader, PlyStreamingSource } from '@ifc-lite/pointcloud';
import { inspectGaussianAdmission } from './gaussianAdmission.js';

const fields = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
function ply(names = fields, count = 1, body = new Uint8Array(names.length * 4), comment = '') {
  return new File([`ply\nformat binary_little_endian 1.0\n${comment}element vertex ${count}\n${names.map(n => `property float ${n}\n`).join('')}end_header\n`, body], 'capture.ply');
}
async function inspect(file: File) {
  return inspectGaussianAdmission(file, await file.slice(0, 4096).arrayBuffer());
}
it('recognizes Gaussian PLY content beyond the first read, independent of suffix (#8565)', async () => {
  const file = ply(fields, 1, undefined, `comment ${'a'.repeat(5000)}\n`);
  const renamed = new File([file], 'renamed.bin');
  assert.deepEqual(await inspect(renamed), { kind: 'disabled', format: 'gaussian-ply', count: 1, shDegree: 0 });
});
it('preserves ordinary PLY and ignores Gaussian words in comments and face properties (#8565)', async () => {
  assert.deepEqual(await inspect(ply(['x', 'y', 'z', 'red', 'green', 'blue', 'scale_0', 'rot_0'])), { kind: 'ordinary' });
  const file = new File(['ply\nformat ascii 1.0\ncomment f_dc_0 scale_0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nelement face 0\nproperty float rot_0\nend_header\n0 0 0\n'], 'ordinary.splat');
  assert.deepEqual(await inspect(file), { kind: 'ordinary' });
});
it('rejects incomplete, duplicate, list and invalid SH schemas (#8565)', async () => {
  for (const names of [fields.slice(1), [...fields, 'x'], [...fields, 'f_rest_0'],
    [...fields, ...Array.from({ length: 9 }, (_, i) => `f_rest_${i + 1}`)]]) {
    assert.equal((await inspect(ply(names))).kind, 'invalid');
  }
  for (const declaration of ['property list uchar float x', 'property constructor x', 'property mystery x']) {
    const invalid = new File([(await ply().text()).replace('property float x', declaration)], 'invalid.ply');
    assert.equal((await inspect(invalid)).kind, 'invalid');
  }
});
it('rejects truncated headers and payloads before decoding (#8565)', async () => {
  for (const file of [new File(['ply\n'], 'short.ply'), ply(fields, 1, new Uint8Array(1)),
    new File([new Uint8Array(31)], 'short.splat'), new File([], 'empty.splat')]) {
    assert.equal((await inspect(file)).kind, 'invalid');
  }
  assert.equal((await inspect(new File([new Uint8Array(32)], 'one.splat'))).kind, 'disabled');
});
it('bounds declared allocation and header reads without allocating the claimed payload (#8565)', async () => {
  for (const count of [-1, 0, 2_000_001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await inspect(ply(fields, count))).kind, 'invalid');
  }
  const huge = new File([new Uint8Array(32)], 'huge.splat');
  Object.defineProperty(huge, 'size', { value: 1024 ** 3 });
  assert.equal((await inspect(huge)).kind, 'invalid');
  const file = ply(fields, 1, undefined, `comment ${'a'.repeat(70_000)}\n`);
  const reads: number[] = [];
  const slice = file.slice.bind(file);
  file.slice = (start, end) => { reads.push(end ?? file.size); return slice(start, end); };
  assert.equal((await inspect(file)).kind, 'invalid');
  assert.deepEqual(reads, [4096, 65536]);
});

it('recognizes complete SH degree one and bounds decoded columns independently (#8565)', async () => {
  const sh = [...fields, ...Array.from({ length: 9 }, (_, i) => `f_rest_${i}`)];
  assert.deepEqual(await inspect(ply(sh)), { kind: 'disabled', format: 'gaussian-ply', count: 1, shDegree: 1 });
  const wide = [...fields, ...Array.from({ length: 100 }, (_, i) => `custom_${i}`)];
  assert.deepEqual(await inspect(ply(wide, 2_000_000)), { kind: 'invalid', reason: 'Gaussian input exceeds the admission allocation limit.' });
});

// #8582 review: admission must agree with the existing PLY parser and streaming
// reader about delimiters, or Gaussian attributes can reach the point-cloud path.
for (const [label, magic, terminator, eol] of [
  ['trailing magic space', 'ply ', 'end_header', '\n'],
  ['trailing magic tab', 'ply\t', 'end_header', '\n'],
  ['trailing terminator space', 'ply', 'end_header ', '\n'],
  ['leading terminator spaces', 'ply', '  end_header', '\n'],
  ['tabs and CRLF', 'ply \t', '\t end_header \t', '\r\n'],
  ['extended first line', `ply${' '.repeat(5000)}`, ' end_header\t', '\n'],
]) {
  for (const gaussian of [false, true]) it(`${gaussian ? 'Gaussian' : 'ordinary'} PLY ${label} agrees with the real reader (#8582)`, async () => {
    const names = gaussian ? fields : ['x', 'y', 'z'];
    const headerText = [magic, 'format binary_little_endian 1.0', 'element vertex 1',
      ...names.map(name => `property float ${name}`), terminator, ''].join(eol);
    const body = new Uint8Array(names.length * 4);
    const view = new DataView(body.buffer);
    [1, 2, 3].forEach((value, index) => view.setFloat32(index * 4, value, true));
    const file = new File([headerText, body], 'whitespace.ply');
    const parsed = parsePlyHeader(new Uint8Array(await file.arrayBuffer()));
    assert.equal(parsed.bodyOffset, new TextEncoder().encode(headerText).byteLength);
    assert.equal(parsed.elements[0].properties.length, names.length);
    assert.equal((await inspect(file)).kind, gaussian ? 'disabled' : 'ordinary');
    const source = new PlyStreamingSource(file);
    try {
      assert.equal((await source.open()).totalPointCount, 1);
      assert.deepEqual(Array.from((await source.next(1))!.positions), [1, 2, 3]);
      assert.equal(await source.next(1), null);
    } finally { source.close(); }
  });
}
