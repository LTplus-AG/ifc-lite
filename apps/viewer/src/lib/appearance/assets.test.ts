/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { AppearanceAssetInventory, AppearanceAssetError, type AppearanceAssetOwner } from './assets.js';

// Real encoded one-pixel PNG; tests inspect byte/resource ownership, not mocked return values.
const png = () => new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
const source: AppearanceAssetOwner = { kind: 'source', id: 'upload' };
const draft: AppearanceAssetOwner = { kind: 'draft', id: 'panel' };
const history: AppearanceAssetOwner = { kind: 'history', id: 'apply-1' };
function bitmap(width = 1, height = 1) { return { width, height, closes: 0, close() { this.closes++; } }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// #4243: assets must survive all render/export/history consumers and close exactly once.
it('deduplicates concurrent imports, preserves original bytes and decodes only on demand', async () => {
  let calls = 0;
  const image = bitmap();
  const assets = new AppearanceAssetInventory({ decode: async () => { calls++; return image; } });
  const input = png();
  const [a, b] = await Promise.all([assets.add(input, { owner: source }), assets.add(input, { owner: draft })]);
  assert.equal(a, b);
  assert.equal(calls, 0);
  assert.match(a.exportName, /^textures\/[0-9a-f]{64}\.png$/);
  input.fill(0);
  const copy = assets.encoded(a.id);
  assert.deepEqual(copy, png());
  copy.fill(0);
  assert.deepEqual(assets.encoded(a.id), png());
  const resources = assets.exportResources([a.id, b.id]);
  assert.equal(resources.size, 1);
  assert.deepEqual(resources.get(a.exportName), png());
  await Promise.all([assets.decode(a.id, source), assets.decode(a.id, draft)]);
  assert.equal(calls, 1);
  assets.retain(a.id, history);
  assets.release(a.id, source);
  assets.releaseOwner(draft);
  assert.equal(image.closes, 0);
  assert.deepEqual(assets.encoded(a.id), png(), 'undo history retains encoded resources');
  assets.releaseOwner(history);
  assert.equal(image.closes, 1);
  assert.equal(assets.get(a.id), undefined);
  assets.clear();
  assert.equal(image.closes, 1);
});

it('content names distinguish different complete hashes and disregard user filenames', async () => {
  const assets = new AppearanceAssetInventory({ decode: async () => bitmap() });
  const one = png(), two = png();
  two[45] ^= 1; // Different encoded image payload; its signature/header prefix is identical.
  const a = await assets.add(one, { owner: source });
  const b = await assets.add(two, { owner: source });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.exportName, b.exportName);
  assert.equal(assets.exportResources([a.id, b.id]).size, 2);
  assets.clear();
});

it('one cancelled waiter leaves another owner’s shared decode intact', async () => {
  const work = deferred<ReturnType<typeof bitmap>>();
  const assets = new AppearanceAssetInventory({ decode: () => work.promise });
  const a = await assets.add(png(), { owner: source });
  assets.retain(a.id, draft);
  const controller = new AbortController();
  const first = assets.decode(a.id, draft, controller.signal);
  const second = assets.decode(a.id, source);
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assets.releaseOwner(draft);
  const image = bitmap();
  work.resolve(image);
  await second;
  assert.equal(image.closes, 0);
  assets.releaseOwner(source);
  assert.equal(image.closes, 1);
});

it('final release closes late decoded results and prevents stale replacement of reimported content', async () => {
  const work = deferred<ReturnType<typeof bitmap>>();
  const assets = new AppearanceAssetInventory({ decode: () => work.promise });
  const a = await assets.add(png(), { owner: source });
  const pending = assets.decode(a.id, source);
  assets.releaseOwner(source);
  const replacement = await assets.add(png(), { owner: draft });
  const image = bitmap();
  work.resolve(image);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(image.closes, 1);
  assert.equal(assets.get(replacement.id), replacement);
  assets.clear();
});

it('decoder failure is retryable and releases its budget, including synchronous throws', async () => {
  let calls = 0;
  const assets = new AppearanceAssetInventory({ decode: () => {
    if (++calls === 1) throw new Error('bad decoder');
    return Promise.resolve(bitmap());
  }, limits: { maxDecodedBytes: 4 } });
  const a = await assets.add(png(), { owner: source });
  await assert.rejects(assets.decode(a.id, source), /Cannot decode this image/);
  await assets.decode(a.id, source);
  assert.equal(calls, 2);
  assets.clear();
});

it('mismatched decoded dimensions close the rejected bitmap and retain encoded source for recovery', async () => {
  const image = bitmap(2, 1);
  const assets = new AppearanceAssetInventory({ decode: async () => image });
  const a = await assets.add(png(), { owner: source });
  await assert.rejects(assets.decode(a.id, source), /dimensions do not match/);
  assert.equal(image.closes, 1);
  assert.deepEqual(assets.encoded(a.id), png());
  assets.clear();
  assert.equal(image.closes, 1);
});

it('rejects malformed headers, MIME mismatch and oversized dimensions before decoding', async () => {
  let calls = 0;
  const assets = new AppearanceAssetInventory({ decode: async () => { calls++; return bitmap(); } });
  await assert.rejects(assets.add(png(), { owner: source, mimeType: 'image/svg+xml' }), AppearanceAssetError);
  await assert.rejects(assets.add(png().slice(0, 24), { owner: source }), /supported image header/);
  await assert.rejects(assets.add(png().slice(0, -3), { owner: source }), /truncated/);
  const huge = png();
  new DataView(huge.buffer).setUint32(16, 0x7fffffff);
  await assert.rejects(assets.add(huge, { owner: source }), /Resize this image/);
  const invalidJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0, 0xff, 0xd9]);
  await assert.rejects(assets.add(invalidJpeg, { owner: source }), /supported image header/);
  assert.equal(calls, 0);
});

it('enforces inventory and in-flight decoded budgets, reclaiming them after final completion', async () => {
  const work = deferred<ReturnType<typeof bitmap>>();
  const bytes = png();
  const assets = new AppearanceAssetInventory({ decode: () => work.promise, limits: { maxEncodedBytes: bytes.length, maxDecodedBytes: 4 } });
  const a = await assets.add(bytes, { owner: source });
  const other = png(); other[45] ^= 1;
  await assert.rejects(assets.add(other, { owner: draft }), /storage budget/);
  const pending = assets.decode(a.id, source);
  assets.releaseOwner(source);
  const b = await assets.add(other, { owner: draft });
  await assert.rejects(assets.decode(b.id, draft), /Decoded image budget/);
  work.resolve(bitmap());
  await assert.rejects(pending, { name: 'AbortError' });
  assets.clear();
});

it('clear invalidates imports in flight and decode requires a live caller lease', async () => {
  const assets = new AppearanceAssetInventory({ decode: async () => bitmap() });
  const pending = assets.add(png(), { owner: source });
  assets.clear();
  await assert.rejects(pending, { name: 'AbortError' });
  const a = await assets.add(png(), { owner: source });
  await assert.rejects(assets.decode(a.id, draft), /Retain this image/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(assets.add(png(), { owner: draft, signal: controller.signal }), { name: 'AbortError' });
  assets.clear();
});

it('reads real JPEG dimensions lazily and rejects a truncated scan header before decode', async () => {
  const bytes = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDx/9k=', 'base64'));
  let calls = 0;
  const assets = new AppearanceAssetInventory({ decode: async () => { calls++; return bitmap(2, 1); } });
  const asset = await assets.add(bytes, { owner: source, mimeType: 'image/jpeg' });
  assert.equal(asset.width, 2);
  assert.equal(asset.height, 1);
  assert.equal(calls, 0);
  assert.match(asset.exportName, /\.jpg$/);
  const sof = bytes.findIndex((value, index) => value === 0xff && bytes[index + 1] === 0xc0);
  const end = sof + 2 + ((bytes[sof + 2] << 8) | bytes[sof + 3]);
  const truncated = new Uint8Array(end + 2);
  truncated.set(bytes.subarray(0, end)); truncated.set([0xff, 0xd9], end);
  await assert.rejects(assets.add(truncated, { owner: source }), /supported image header/);
  assert.equal(calls, 0);
  const decoded = await assets.decode(asset.id, source);
  assets.releaseOwner(source);
  assert.equal(decoded.closes, 1);
});
