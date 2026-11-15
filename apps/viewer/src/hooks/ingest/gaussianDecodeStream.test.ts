// SPDX-License-Identifier: MPL-2.0
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeGaussianFile } from './gaussianDecode.js';
import { gaussianSummaryRanges, openGaussianDecodeStream, summarizeGaussianRange, type GaussianRangeSummarizer } from './gaussianDecodeStream.js';
import { gaussianSummaryHelpers } from './gaussianSummaryHelpers.js';
import { createGaussianDecodeSession, summarizeGaussianDecoded } from './gaussianDecodeSession.js';

// #9018: the worker streams the capture by range reads instead of decoding it whole.
// Every value must match the whole-file decoder (still used by export), and no read
// may hold the file or a full table.

const BASE = ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
  'scale_0', 'scale_1', 'scale_2', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
const SH = [0, 9, 24, 45];

/** A deterministic `count`-row Gaussian PLY; `double` stores centres as f64 at a survey origin. */
function ply(count: number, degree: number, options: { double?: boolean; poison?: { row: number; name: string; value: number } } = {}): File {
  const names = [...BASE, ...Array.from({ length: SH[degree] }, (_, i) => `f_rest_${i}`)];
  const width = (name: string) => (options.double && ['x', 'y', 'z'].includes(name) ? 8 : 4);
  const stride = names.reduce((sum, name) => sum + width(name), 0);
  const body = new DataView(new ArrayBuffer(stride * count));
  for (let row = 0; row < count; row++) {
    let offset = row * stride;
    for (const [i, name] of names.entries()) {
      const axis = ['x', 'y', 'z'].indexOf(name);
      let value = axis >= 0 ? (options.double ? 2_600_000 + axis * 1_000_000 : 0) + row * 0.37 + axis * 1.1 + 0.0012345
        : name === 'rot_0' ? 1 + row / count
          : name.startsWith('scale_') ? Math.log(0.01 + (row % 7) / 100)
            : name.startsWith('f_rest_') ? Math.sin(row * 13 + i) * 0.4 * (Number(name.slice(7)) % 5 === 4 ? 0 : 1)
              : Math.cos(row + i) * 0.5;
      if (options.poison && options.poison.row === row && options.poison.name === name) value = options.poison.value;
      if (width(name) === 8) body.setFloat64(offset, value, true); else body.setFloat32(offset, value, true);
      offset += width(name);
    }
  }
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n`
    + names.map(name => `property ${width(name) === 8 ? 'double' : 'float'} ${name}\n`).join('') + 'end_header\n';
  return new File([header, body.buffer], 'stream.ply');
}

/** Record every byte range the stream reads from `file`. */
function watched(file: File) {
  const ranges: number[] = [];
  const slice = file.slice.bind(file);
  file.slice = ((start?: number, end?: number, type?: string) => {
    ranges.push(Math.min(end ?? file.size, file.size) - (start ?? 0));
    return slice(start, end, type);
  }) as File['slice'];
  file.arrayBuffer = () => { throw new Error('the stream read the whole file'); };
  return ranges;
}

async function readAll(file: File, windowRows: number, requestRows: number) {
  const stream = await openGaussianDecodeStream(file, windowRows);
  try {
    const columns: Record<string, number[]> = {};
    for (let start = 0; start < stream.summary.count; start += requestRows) {
      const rows = await stream.rows(start, Math.min(requestRows, stream.summary.count - start));
      for (const [name, data] of Object.entries(rows)) (columns[name] ??= []).push(...data);
    }
    return { summary: stream.summary, columns };
  } finally { await stream.close(); }
}

for (const degree of [0, 1, 2, 3]) for (const double of [false, true]) {
  it(`streams SH${degree}${double ? ' f64-centre' : ''} rows identical to the whole-file decode, at any window/request alignment (#9018)`, async () => {
    const count = 23;
    const decoded = await decodeGaussianFile(ply(count, degree, { double }));
    for (const [windowRows, requestRows] of [[4, 4], [4, 3], [5, 7], [64, 32]]) {
      const file = ply(count, degree, { double });
      watched(file);
      const { summary, columns } = await readAll(file, windowRows, requestRows);
      assert.deepEqual(summary, summarizeGaussianDecoded(decoded), `summary at window ${windowRows}`);
      assert.deepEqual(Object.keys(columns).sort(), Object.keys(decoded.columns).sort());
      for (const [name, data] of Object.entries(decoded.columns)) assert.deepEqual(columns[name], [...data], `${name} at window ${windowRows}/${requestRows}`);
    }
  });
}

it('streams .splat captures identically (#9018)', async () => {
  const count = 9;
  const bytes = new Uint8Array(32 * count);
  const view = new DataView(bytes.buffer);
  for (let row = 0; row < count; row++) {
    [row * 0.5 + 1, -2 + row, 3, 0.02, 0.03, 0.04].forEach((value, i) => view.setFloat32(row * 32 + i * 4, value, true));
    bytes.set([128, 64 + row, 255, 128, 255, 128 - row, 128, 128], row * 32 + 24);
  }
  const decoded = await decodeGaussianFile(new File([bytes], 'c.splat'));
  const file = new File([bytes], 'c.splat');
  watched(file);
  const { summary, columns } = await readAll(file, 4, 3);
  assert.deepEqual(summary, summarizeGaussianDecoded(decoded));
  for (const [name, data] of Object.entries(decoded.columns)) assert.deepEqual(columns[name], [...data], name);
});

it('never reads more than the header probe or one decode window at a time (#9018)', async () => {
  const count = 800; // 189 KB of records: a whole-file read cannot hide under upstream's 128 KiB header probe
  const file = ply(count, 3);
  const ranges = watched(file);
  const stride = (BASE.length + 45) * 4;
  const allowance = Math.max(128 * 1024, 8 * stride); // the header probe, or one decode window
  assert.ok(file.size > allowance);
  await readAll(file, 8, 8);
  assert.ok(ranges.length > count / 8, 'the capture is read in ranges');
  assert.ok(Math.max(...ranges) <= allowance, `largest read ${Math.max(...ranges)} B`);
});

for (const [name, value, pattern] of [['opacity', NaN, /Non-finite/], ['y', Infinity, /Non-finite/], ['scale_1', 100, /covariance/], ['f_rest_7', NaN, /Non-finite/]] as const) {
  it(`rejects ${name}=${value} in the last window at open, before any row is served (#9018)`, async () => {
    const file = ply(21, 2, { poison: { row: 20, name, value } });
    await assert.rejects(decodeGaussianFile(file), pattern);
    await assert.rejects(openGaussianDecodeStream(file, 4), pattern);
  });
}

it('a re-read with the known summary skips the summary pass but still rejects a different capture (#9018)', async () => {
  const file = ply(2000, 1); // 184 KB of records
  const ranges = watched(file);
  const bytes = () => ranges.splice(0).reduce((sum, length) => sum + length, 0);
  const first = await openGaussianDecodeStream(file, 256);
  await first.close();
  const summarized = bytes();
  const again = await openGaussianDecodeStream(file, 256, first.summary);
  assert.equal(again.summary, first.summary);
  const reopened = bytes();
  assert.ok(summarized - reopened >= 2000 * 92, `the summary pass read every record (${summarized} B); the re-open did not (${reopened} B)`);
  assert.deepEqual([...(await again.rows(4, 4)).x], [...(await decodeGaussianFile(ply(2000, 1))).columns.x.subarray(4, 8)]);
  await again.close();
  await assert.rejects(openGaussianDecodeStream(ply(2001, 1), 256, first.summary), /changed/);
});

it('the worker session streams through the protocol and transfers each slice (#9018)', async () => {
  const file = ply(10, 0);
  const session = createGaussianDecodeSession((input, summary) => openGaussianDecodeStream(input, 4, summary));
  const opened = await session({ type: 'open', file });
  assert.ok(opened.reply.ok && opened.reply.type === 'summary' && opened.reply.summary.count === 10);
  const rows = await session({ type: 'rows', start: 3, count: 5 });
  assert.ok(rows.reply.ok && rows.reply.type === 'rows');
  assert.equal(rows.reply.columns.x.length, 5);
  assert.equal(rows.transfer.length, Object.keys(rows.reply.columns).length, 'one owned buffer per column');
  const outside = await session({ type: 'rows', start: 8, count: 5 });
  assert.equal(outside.reply.ok, false);
  const twice = await session({ type: 'open', file });
  assert.equal(twice.reply.ok, false);
});

it('prefetches the next window but serves any request order correctly (#9018)', async () => {
  const file = ply(30, 2);
  const decoded = await decodeGaussianFile(ply(30, 2));
  const stream = await openGaussianDecodeStream(file, 4);
  try {
    // 4..8 is prefetched after 0..4; asking for 20..26 instead must not return it, nor race the pool.
    const order: Array<[number, number]> = [[0, 4], [20, 6], [4, 4], [26, 4], [8, 3], [8, 3], [11, 9]];
    const results = await Promise.all(order.map(([start, rows]) => stream.rows(start, rows)));
    order.forEach(([start, rows], index) => {
      for (const [name, data] of Object.entries(decoded.columns)) assert.deepEqual([...results[index][name]], [...data.subarray(start, start + rows)], `${name} ${start}+${rows}`);
    });
  } finally { await stream.close(); }
});

it('decodes later windows into columns the consumer hands back (#9018)', async () => {
  const file = ply(20, 1);
  const decoded = await decodeGaussianFile(ply(20, 1));
  const stream = await openGaussianDecodeStream(file, 4);
  try {
    const first = await stream.rows(0, 4); // 4..8 is being prefetched meanwhile
    const firstX = first.x;
    stream.recycle(first);
    const second = await stream.rows(4, 4);
    const third = await stream.rows(8, 4);
    assert.ok(second.x === firstX || third.x === firstX, 'a later window decodes into the handed-back array');
    for (const [name, data] of Object.entries(decoded.columns)) {
      assert.deepEqual([...second[name]], [...data.subarray(4, 8)], name);
      assert.deepEqual([...third[name]], [...data.subarray(8, 12)], name);
    }
    stream.recycle({ x: new Float32Array(0) }); // a detached or empty array is ignored
  } finally { await stream.close(); }
});

/** In-process stand-in for the helper workers: the real range summary, optionally refusing some ranges. */
const inProcessHelpers = (file: File, windowRows: number, refuse = new Set<number>()): GaussianRangeSummarizer =>
  ranges => Promise.all(ranges.map(([start, end], index) => (refuse.has(index) ? Promise.resolve(null) : summarizeGaussianRange(file, windowRows, start, end))));

for (const helpers of [1, 2, 5]) it(`a summary pass split across ${helpers} helper(s) equals the whole-file summary (#9018)`, async () => {
  const decoded = await decodeGaussianFile(ply(37, 3, { double: true }));
  const file = ply(37, 3, { double: true });
  const stream = await openGaussianDecodeStream(file, 4, undefined, { count: helpers, summarize: inProcessHelpers(file, 4) });
  try {
    assert.deepEqual(stream.summary, summarizeGaussianDecoded(decoded));
    assert.deepEqual([...(await stream.rows(30, 7)).z], [...decoded.columns.z.subarray(30, 37)]);
  } finally { await stream.close(); }
});

it('summarizes locally a range no helper could take (#9018)', async () => {
  const decoded = await decodeGaussianFile(ply(30, 1));
  const file = ply(30, 1);
  const stream = await openGaussianDecodeStream(file, 4, undefined, { count: 2, summarize: inProcessHelpers(file, 4, new Set([0, 1])) });
  try { assert.deepEqual(stream.summary, summarizeGaussianDecoded(decoded)); } finally { await stream.close(); }
});

it('rejects the open when a helper finds an invalid row (#9018)', async () => {
  const file = ply(30, 2, { poison: { row: 29, name: 'rot_0', value: Number.NaN } });
  await assert.rejects(openGaussianDecodeStream(file, 4, undefined, { count: 2, summarize: inProcessHelpers(file, 4) }), /Non-finite/);
});

it('summary ranges tile the capture on chunk boundaries (#9018)', () => {
  for (const [count, chunk, parts] of [[1, 4, 3], [10, 4, 3], [37, 4, 3], [100, 16, 2], [5, 16, 3]] as const) {
    const ranges = gaussianSummaryRanges(count, chunk, parts);
    assert.equal(ranges[0][0], 0);
    assert.equal(ranges.at(-1)![1], count);
    ranges.forEach(([from, to], i) => {
      assert.ok(to > from && from % chunk === 0, `${count}/${chunk}/${parts}: [${from}, ${to})`);
      if (i > 0) assert.equal(from, ranges[i - 1][1]);
    });
    assert.ok(ranges.length <= parts);
  }
  assert.deepEqual([2, 3, 4, 8, 32].map(cores => gaussianSummaryHelpers(new File([], 'x'), cores).count), [0, 1, 2, 2, 2]);
});
