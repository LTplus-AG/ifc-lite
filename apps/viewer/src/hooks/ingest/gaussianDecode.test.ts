// SPDX-License-Identifier: MPL-2.0
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createChunkDataPool, MemoryReadFileSystem, readPly, materializeToDataTable } from '@playcanvas/splat-transform';
import { inspectGaussianAdmission } from './gaussianAdmission.js';
// A production-only revert removes this new module. Load inside each test so
// that missing decode capability fails an assertion, rather than file loading.
async function decodeGaussianFile(file: File) {
  const decoder = await import('./gaussianDecode.js').catch((error: unknown) => {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  });
  assert.ok(decoder, 'Gaussian captures must have a worker decoder before their channel contracts can be verified');
  return decoder.decodeGaussianFile(file);
}

const base = ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
  'scale_0', 'scale_1', 'scale_2', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
function ply(degree = 0, overrides: Record<string, number> = {}) {
  const names = [...base, ...Array.from({ length: [0, 9, 24, 45][degree] }, (_, i) => `f_rest_${i}`)];
  const body = new ArrayBuffer(names.length * 4);
  const data = new DataView(body);
  names.forEach((name, i) => data.setFloat32(i * 4, overrides[name] ?? (name === 'rot_0' ? 1 : i / 100), true));
  return new File([`ply\nformat binary_little_endian 1.0\nelement vertex 1\n${names.map(name => `property float ${name}\n`).join('')}end_header\n`, body], 'source.ply');
}

for (const degree of [0, 1, 2, 3]) it(`real upstream decoder preserves raw SH${degree} and source coordinates (#8565)`, async () => {
  const decoded = await decodeGaussianFile(ply(degree, { x: 123, y: -45, z: 67, scale_0: Math.log(2), opacity: -2 }));
  assert.equal(decoded.count, 1);
  assert.equal(decoded.shDegree, degree);
  assert.deepEqual(decoded.centerBounds, { min: [123, -45, 67], max: [123, -45, 67] });
  assert.equal(decoded.columns.scale_0[0], Math.fround(Math.log(2)));
  assert.equal(decoded.columns.opacity[0], -2);
  assert.equal(Object.keys(decoded.columns).length, 14 + [0, 9, 24, 45][degree]);
  if (degree === 3) assert.equal(decoded.columns.f_rest_44[0], Math.fround(58 / 100));
});

for (const name of ['x', 'y', 'z', 'rot_0', 'scale_1', 'opacity', 'f_dc_2', 'f_rest_44']) {
  for (const value of [NaN, Infinity, -Infinity]) it(`rejects upstream-preserved ${name}=${value} before publication (#8565)`, async () => {
    await assert.rejects(decodeGaussianFile(ply(3, { [name]: value })), /Non-finite/);
  });
}

it('rejects finite logs whose covariance cannot survive float32 and degenerate rotation (#8565)', async () => {
  for (const scale of [100, -100]) await assert.rejects(decodeGaussianFile(ply(0, { scale_0: scale })), /covariance/);
  await assert.rejects(decodeGaussianFile(ply(0, { rot_0: 0, rot_1: 0, rot_2: 0, rot_3: 0 })), /rotation/);
});

it('decodes real 32-byte splat framing via upstream without implicit placement (#8565)', async () => {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  [1, -2, 3, 2, 3, 4].forEach((value, i) => view.setFloat32(i * 4, value, true));
  bytes.set([128, 64, 255, 128, 255, 128, 128, 128], 24);
  const decoded = await decodeGaussianFile(new File([bytes], 'capture.splat'));
  assert.deepEqual(decoded.centerBounds.min, [1, -2, 3]);
  assert.equal(decoded.shDegree, 0);
  assert.ok(Math.abs(Math.exp(decoded.columns.scale_0[0]) - 2) < 1e-6);
  bytes[0] = 0; view.setFloat32(0, NaN, true);
  await assert.rejects(decodeGaussianFile(new File([bytes], 'bad.splat')), /Non-finite/);
});

it('ordinary PLY and truncated Gaussian payload never enter decoding (#8565)', async () => {
  await assert.rejects(decodeGaussianFile(new File(['ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n'], 'ordinary.ply')), /Not a Gaussian/);
  await assert.rejects(decodeGaussianFile(new File([new Uint8Array(31)], 'broken.splat')), /Truncated/);
});

// These are actual binary PLY records, including extras the output does not retain.
function layoutPly(count: number, extras = 0, metadata: 'before' | 'after' | 'none' = 'none') {
  const stride = base.length * 4 + extras * 8;
  const body = new ArrayBuffer(count * stride);
  const view = new DataView(body);
  for (let row = 0; row < count; row++) {
    base.forEach((name, i) => view.setFloat32(row * stride + i * 4,
      name === 'x' ? 1 : name === 'y' ? 2 : name === 'z' ? 3 : name === 'rot_0' ? 1 : 0, true));
  }
  const metaHeader = 'element metadata 1\nproperty float value\n';
  const metaBody = new ArrayBuffer(4);
  new DataView(metaBody).setFloat32(0, 123, true);
  const header = `ply\nformat binary_little_endian 1.0\n${metadata === 'before' ? metaHeader : ''}element vertex ${count}\n`
    + base.map(name => `property float ${name}\n`).join('')
    + Array.from({ length: extras }, (_, i) => `property double e${i}\n`).join('')
    + (metadata === 'after' ? metaHeader : '') + 'end_header\n';
  return new File([header, ...(metadata === 'before' ? [metaBody] : []), body,
    ...(metadata === 'after' ? [metaBody] : [])], 'layout.ply');
}

// Intercept numeric Uint8Array construction BEFORE allocation, so the negative
// control can prove the 603.5 MiB request without ever allocating that memory.
async function boundedScratch<T>(run: () => Promise<T>) {
  const original = globalThis.Uint8Array;
  const requested: number[] = [];
  globalThis.Uint8Array = new Proxy(original, {
    construct(target, args: unknown[]) {
      if (typeof args[0] === 'number') {
        requested.push(args[0]);
        if (args[0] > 16 * 1024 * 1024) throw new Error(`Scratch allocation refused: ${args[0]}`);
      }
      return Reflect.construct(target, args);
    },
  });
  try { return { result: await run(), requested }; }
  finally { globalThis.Uint8Array = original; }
}

for (const count of [1, 1800]) it(`bounds full-stride scratch and actual rows with ${count} wide records (#8565)`, async () => {
  const file = layoutPly(count, 1200);
  const { result, requested } = await boundedScratch(() => decodeGaussianFile(file));
  assert.equal(result.count, count);
  assert.deepEqual(result.centerBounds, { min: [1, 2, 3], max: [1, 2, 3] });
  assert.equal(Object.keys(result.columns).length, 14);
  const stride = 14 * 4 + 1200 * 8;
  const expected = Math.min(count, Math.floor(16 * 1024 * 1024 / stride)) * stride;
  assert.ok(requested.includes(expected), 'real upstream record scratch was observed');
  if (count === 1) assert.ok(Math.max(...requested) < 1024 * 1024, 'one row cannot reserve a full chunk');
});

it('negative control safely catches the upstream fixed-chunk scratch request (#8565)', async () => {
  const file = layoutPly(1, 1200);
  await assert.rejects(boundedScratch(() => rawUpstream(file, 65_536)), /Scratch allocation refused: 632815616/);
});

it('rejects preceding-element offsets while preserving vertex-first trailing elements (#8565)', async () => {
  const before = layoutPly(1, 0, 'before');
  // Negative control: the unguarded pinned upstream reader consumes metadata as x.
  const wrong = await rawUpstream(before, 1);
  assert.deepEqual(['x', 'y', 'z'].map(name => wrong.getColumnByName(name)?.data[0]), [123, 1, 2]);
  await assert.rejects(decodeGaussianFile(before), /element before vertex/);
  const after = await decodeGaussianFile(layoutPly(1, 0, 'after'));
  assert.deepEqual(after.centerBounds.min, [1, 2, 3]);
  const ordinary = new File(['ply\nformat ascii 1.0\nelement metadata 1\nproperty float value\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n123\n1 2 3\n'], 'ordinary.ply');
  assert.deepEqual(await inspectGaussianAdmission(ordinary, await ordinary.arrayBuffer()), { kind: 'ordinary' });
});

async function rawUpstream(file: File, chunkSize: number) {
  const fs = new MemoryReadFileSystem();
  fs.set('capture', new Uint8Array(await file.arrayBuffer()));
  const input = await fs.createSource('capture');
  const pool = createChunkDataPool({ chunkSize, maxPooledBytes: 16 * 1024 * 1024 });
  const source = await readPly(input, pool);
  try { return await materializeToDataTable(source, pool, new Set(['position', 'geometric', 'color'])); }
  finally { try { await source.close(); } finally { pool.destroy(); } }
}

async function changeHeader(file: File, edit: (header: string) => string) {
  const probe = await file.slice(0, 65536).text();
  const end = probe.indexOf('\nend_header\n') + '\nend_header\n'.length;
  assert.ok(end >= '\nend_header\n'.length);
  return new File([edit(probe.slice(0, end)), file.slice(end)], 'header-tokens.ply');
}

it('comment terminator tokens cannot hide wide upstream records (#8565 review r2)', async () => {
  const file = await changeHeader(layoutPly(1800, 1200), header => header.replace(
    'property double e0\n', 'comment end_header\nproperty double e0\n'));
  const { result, requested } = await boundedScratch(() => decodeGaussianFile(file));
  assert.equal(result.count, 1800);
  assert.deepEqual(result.centerBounds, { min: [1, 2, 3], max: [1, 2, 3] });
  assert.ok(requested.includes(Math.floor(16 * 1024 * 1024 / 9656) * 9656));
  // The old admission stopped at the comment, seeing only 14 floats (56 bytes).
  // Replay that old chunk calculation against the REAL reader, refusing its
  // oversized numeric allocation before construction rather than allocating it.
  const oldChunk = Math.min(65_536, 1800, Math.floor(16 * 1024 * 1024 / 56));
  await assert.rejects(boundedScratch(() => rawUpstream(file, oldChunk)), /Scratch allocation refused: 17380800/);
});

for (const name of ['end_header', 'element', 'property', 'format']) {
  it(`header keyword property name ${name} retains the full record layout (#8565 review r2)`, async () => {
    const file = await changeHeader(layoutPly(1, 1200), header => header.replace('double e0', `double ${name}`));
    const { result, requested } = await boundedScratch(() => decodeGaussianFile(file));
    assert.deepEqual(result.centerBounds.min, [1, 2, 3]);
    assert.ok(requested.includes(9656));
  });
}

it('complete header governs count and element order despite keyword names/comments (#8565 review r2)', async () => {
  const trailing = await changeHeader(layoutPly(1, 0, 'after'), header => header.replace('element metadata', 'element end_header'));
  assert.deepEqual((await decodeGaussianFile(trailing)).centerBounds.min, [1, 2, 3]);
  const preceding = await changeHeader(layoutPly(1, 0, 'before'), header => header.replace('element metadata', 'element end_header'));
  await assert.rejects(decodeGaussianFile(preceding), /element before vertex/);
  const duplicate = await changeHeader(layoutPly(1), header => header.replace('\nend_header\n', '\ncomment end_header\nelement vertex 1\nend_header\n'));
  await assert.rejects(decodeGaussianFile(duplicate), /Malformed/);
  const commented = await changeHeader(layoutPly(1), header => header.replace('element vertex 1', 'comment end_header element vertex 999 property double x\nelement vertex 1'));
  assert.equal((await decodeGaussianFile(commented)).count, 1);
});

it('decoder refuses unsupported grammar while dispatch keeps its PLY compatibility (#8565 review r2)', async () => {
  for (const edit of [
    (header: string) => '\ufeff' + header,
    (header: string) => header.replace('ply\n', 'ply \n'),
    (header: string) => header.replace('property float x', 'property \tfloat x'),
    (header: string) => header.replace('end_header\n', '\fend_header\n'),
    (header: string) => header.replace('binary_little_endian', 'ascii'),
    (header: string) => header.replace('property float x', 'property float32 x'),
  ]) {
    const file = await changeHeader(layoutPly(1), edit);
    assert.equal((await inspectGaussianAdmission(file, await file.slice(0, 4096).arrayBuffer())).kind, 'disabled');
    await assert.rejects(decodeGaussianFile(file), /Unsupported|Malformed|header/);
  }
  const late = await changeHeader(layoutPly(1), header => header.replace('\nend_header\n', '\ncomment end_header\ncomment ' + 'x'.repeat(65536) + '\nend_header\n'));
  await assert.rejects(decodeGaussianFile(late), /64 KiB/);
});

async function packedPly(chunkCount: string, packed = ['packed_position', 'packed_rotation', 'packed_scale', 'packed_color']) {
  const file = await changeHeader(layoutPly(1), header => header.replace('\nend_header\n', '\n'
    + packed.map(name => `property uint ${name}\n`).join('')
    + `element chunk ${chunkCount}\nproperty float min_x\nend_header\n`));
  // Only the single vertex is present; the claimed chunk payload is absent.
  return new File([file, new Uint8Array(packed.length * 4)], 'hybrid.ply');
}

async function boundedFloat32<T>(run: () => Promise<T>) {
  const original = globalThis.Float32Array;
  const requested: number[] = [];
  globalThis.Float32Array = new Proxy(original, {
    construct(target, args: unknown[]) {
      if (typeof args[0] === 'number') {
        const bytes = args[0] * 4;
        requested.push(bytes);
        if (bytes > 16 * 1024 * 1024) throw new Error(`Float32 allocation refused: ${bytes}`);
      }
      return Reflect.construct(target, args);
    },
  });
  try { return { result: await run(), requested }; }
  finally { globalThis.Float32Array = original; }
}

it('refuses compressed-reader selection before body reads or chunk bounds allocation (#8565 review r3)', async () => {
  for (const count of ['100000000', '-1', 'NaN', '9007199254740992']) {
    for (const packed of [['packed_position'], ['packed_position', 'packed_rotation', 'packed_scale', 'packed_color']]) {
      const file = await packedPly(count, packed);
      let wholeFileReads = 0;
      const read = file.arrayBuffer.bind(file);
      file.arrayBuffer = () => { wholeFileReads++; return read(); };
      const { requested } = await boundedFloat32(async () => {
        await assert.rejects(decodeGaussianFile(file), /Unsupported compressed Gaussian PLY/);
      });
      assert.equal(wholeFileReads, 0, 'refuse in bounded admission before opening the upstream reader');
      assert.deepEqual(requested, [], 'no decoded or compressed bounds Float32 storage is allocated');
    }
  }
});

it('negative control intercepts real compressed chunk allocation before constructing it (#8565 review r3)', async () => {
  const file = await packedPly('100000000');
  assert.ok(file.size < 1024, 'tiny malformed input, no huge fixture allocation');
  await assert.rejects(boundedFloat32(() => rawUpstream(file, 1)), /Float32 allocation refused: 400000000/);
});

it('reader discriminator is vertex-scoped and ordinary PLY dispatch remains compatible (#8565 review r3)', async () => {
  const file = await changeHeader(layoutPly(1), header => header.replace('\nend_header\n',
    '\ncomment packed_position\nelement chunk 0\nproperty float packed_position\nend_header\n'));
  assert.deepEqual((await decodeGaussianFile(file)).centerBounds.min, [1, 2, 3]);
  const ordinary = new File(['ply\nformat binary_little_endian 1.0\nelement vertex 1\n'
    + ['x', 'y', 'z', 'packed_position'].map(name => `property float ${name}\n`).join('')
    + 'end_header\n', new Uint8Array(16)], 'ordinary.ply');
  assert.deepEqual(await inspectGaussianAdmission(ordinary, await ordinary.arrayBuffer()), { kind: 'ordinary' });
});

it('other upstream PLY model discriminators cannot reach materialization (#8565 review r3)', async () => {
  for (const comment of ['SplatRenderMode: mip', 'SplatRenderMode: 2dgs', 'antialiased 1']) {
    const file = await changeHeader(layoutPly(1), header => header.replace('element vertex', `comment ${comment}\nelement vertex`));
    const { requested } = await boundedFloat32(async () => {
      await assert.rejects(decodeGaussianFile(file), /Unsupported or inconsistent/);
    });
    assert.deepEqual(requested, []);
  }
  const twoDimensional = await changeHeader(layoutPly(1), header => header.replace('property float scale_2\n', ''));
  await assert.rejects(decodeGaussianFile(twoDimensional), /Malformed/);
});

// #8613 review r4: decoder admission must read the header exactly as the pinned
// reader does. Its readHeader drops empty lines and empty words, i.e.
// split('\n').filter(Boolean) and split(' ').filter(Boolean).
async function decodeAdmission(file: File) {
  const { inspectGaussianDecodeAdmission } = await import('./gaussianAdmission.js');
  assert.ok(inspectGaussianDecodeAdmission, 'Gaussian decoding needs its own bounded admission');
  return inspectGaussianDecodeAdmission(file, await file.slice(0, 4096).arrayBuffer());
}

async function upstreamMeta(file: File) {
  const fs = new MemoryReadFileSystem();
  fs.set('capture', new Uint8Array(await file.arrayBuffer()));
  const input = await fs.createSource('capture');
  const pool = createChunkDataPool({ chunkSize: 1, maxPooledBytes: 1024 * 1024 });
  let source: Awaited<ReturnType<typeof readPly>> | undefined;
  try { source = await readPly(input, pool); return source.meta; }
  finally { try { await (source ?? input).close(); } finally { pool.destroy(); } }
}

const tableColumns = (table: Awaited<ReturnType<typeof rawUpstream>>) =>
  table.columns.map(({ name, data }) => [name, Array.from(data)]);

it('repeated, leading and trailing spaces decode as the pinned reader tokenizes them (#8613 review r4)', async () => {
  const canonical = layoutPly(2, 2);
  const upstream = tableColumns(await rawUpstream(canonical, 2));
  const decoded = await decodeGaussianFile(canonical);
  const admitted = { kind: 'disabled', format: 'gaussian-ply', count: 2, shDegree: 0, recordStride: 14 * 4 + 2 * 8 };
  assert.deepEqual(await decodeAdmission(canonical), admitted);
  for (const edit of [
    (header: string) => header.replace('property float x', 'property  float x'),
    (header: string) => header.replace('element vertex 2', 'element  vertex 2        '),
    (header: string) => header.replace('property double e1', '   property   double  e1   '),
    (header: string) => header.replace('format binary_little_endian 1.0', 'format  binary_little_endian 1.0 '),
  ]) {
    const file = await changeHeader(canonical, edit);
    // The real pinned reader keeps the canonical layout; it does not shift tokens.
    assert.deepEqual(tableColumns(await rawUpstream(file, 2)), upstream);
    assert.deepEqual(await decodeAdmission(file), admitted);
    assert.deepEqual(await decodeGaussianFile(file), decoded);
  }
});

it('headers the pinned reader rejects stop at bounded admission before any body read (#8613 review r4)', async () => {
  const cases: [(header: string) => string, RegExp][] = [
    [header => header.replace('element vertex', '   \nelement vertex'), /unrecognized header line/],
    [header => header.replace('\nend_header\n', '\nelement\nend_header\n'), /invalid element line/],
    [header => header.replace('\nend_header\n', '\nelement face 0\nproperty list uchar int vertex_indices\nend_header\n'), /invalid property line/],
    [header => header.replace('\nend_header\n', '\nelement face 0\nproperty float32 area\nend_header\n'), /invalid property line/],
    [header => header.replace('format', 'property float orphan\nformat'), /invalid property line/],
  ];
  for (const [edit, upstreamError] of cases) {
    const file = await changeHeader(layoutPly(1), edit);
    // Negative control: the real pinned reader refuses the same bytes.
    await assert.rejects(upstreamMeta(file), upstreamError);
    assert.equal((await inspectGaussianAdmission(file, await file.slice(0, 4096).arrayBuffer())).kind, 'disabled');
    let wholeFileReads = 0;
    const read = file.arrayBuffer.bind(file);
    file.arrayBuffer = () => { wholeFileReads++; return read(); };
    await assert.rejects(decodeGaussianFile(file), /Unsupported Gaussian decoder (?:header directive|element or property)/);
    assert.equal(wholeFileReads, 0, 'refuse in bounded admission, not inside the upstream reader');
  }
});

it('indented comments cannot hide a render model from the decoder (#8613 review r4)', async () => {
  for (const comment of ['SplatRenderMode: mip', 'antialiased 1']) {
    const flush = await changeHeader(layoutPly(1), header => header.replace('element vertex', `comment ${comment}\nelement vertex`));
    const indented = await changeHeader(layoutPly(1), header => header.replace('element vertex', `  comment ${comment}\nelement vertex`));
    // Real pinned reader: comments are line.substring(8), so indentation loses the model.
    assert.equal((await upstreamMeta(flush)).model, 'antialiased');
    assert.equal((await upstreamMeta(indented)).model, 'default');
    await assert.rejects(decodeGaussianFile(indented), /indented Gaussian decoder header comment/);
  }
  const spaced = await changeHeader(layoutPly(1), header => header.replace('element vertex', 'comment  exported   by tool\nelement vertex'));
  assert.deepEqual((await decodeGaussianFile(spaced)).centerBounds.min, [1, 2, 3]);
});

it('public admission keeps a preceding-element Gaussian PLY disabled; only the decoder refuses it (#8613 review r4)', async () => {
  const before = layoutPly(1, 0, 'before');
  assert.deepEqual(await inspectGaussianAdmission(before, await before.slice(0, 4096).arrayBuffer()),
    { kind: 'disabled', format: 'gaussian-ply', count: 1, shDegree: 0 });
  assert.deepEqual(await decodeAdmission(before), { kind: 'invalid', reason: 'Unsupported Gaussian PLY element before vertex.' });
  await assert.rejects(decodeGaussianFile(before), /element before vertex/);
});
