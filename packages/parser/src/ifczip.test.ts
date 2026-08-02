/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  isZipBuffer,
  unwrapIfcZip,
  unwrapIfcZipWithLimit,
  unwrapIfcZipView,
  unwrapIfcZipWithResources,
} from './ifczip.js';

const STEP_HEADER = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";

async function makeZip(entries: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: 'arraybuffer' });
}

function toArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('isZipBuffer', () => {
  it('is false for a plain STEP file', () => {
    expect(isZipBuffer(toArrayBuffer(STEP_HEADER))).toBe(false);
  });

  it('is false for a buffer shorter than 4 bytes', () => {
    expect(isZipBuffer(new Uint8Array([0x50, 0x4b]).buffer)).toBe(false);
  });

  it('is true for the zip local-file-header signature', async () => {
    const zip = await makeZip({ 'model.ifc': STEP_HEADER });
    expect(isZipBuffer(zip)).toBe(true);
  });
});

describe('unwrapIfcZip', () => {
  it('returns non-zip buffers unchanged', async () => {
    const buffer = toArrayBuffer(STEP_HEADER);
    const result = await unwrapIfcZip(buffer);
    expect(new TextDecoder().decode(result)).toBe(STEP_HEADER);
  });

  it('extracts the single .ifc entry from an .ifcZIP container', async () => {
    const zip = await makeZip({ 'model.ifc': STEP_HEADER });
    const result = await unwrapIfcZip(zip);
    expect(new TextDecoder().decode(result)).toBe(STEP_HEADER);
  });

  it('is case-insensitive and matches .ifcxml too, from a nested path', async () => {
    const zip = await makeZip({ 'nested/dir/Model.IFCXML': '<ifcXML/>' });
    const result = await unwrapIfcZip(zip);
    expect(new TextDecoder().decode(result)).toBe('<ifcXML/>');
  });

  it('ignores referenced resources alongside the model entry', async () => {
    const zip = await makeZip({
      'model.ifc': STEP_HEADER,
      'resources/texture.png': 'not-a-real-png-but-fine-for-this-test',
    });
    const result = await unwrapIfcZip(zip);
    expect(new TextDecoder().decode(result)).toBe(STEP_HEADER);
  });

  it('throws when the archive has no .ifc/.ifcxml entry', async () => {
    const zip = await makeZip({ 'readme.txt': 'hello' });
    await expect(unwrapIfcZip(zip)).rejects.toThrow(/no \.ifc\/\.ifcxml entry/);
  });

  it('throws when the archive has multiple model entries (ambiguous)', async () => {
    const zip = await makeZip({ 'a.ifc': STEP_HEADER, 'b.ifc': STEP_HEADER });
    await expect(unwrapIfcZip(zip)).rejects.toThrow(/expected exactly one/);
  });

  it('rejects a model entry whose declared uncompressed size exceeds the limit (zip-bomb guard)', async () => {
    const zip = await makeZip({ 'model.ifc': STEP_HEADER });
    // STEP_HEADER is ~60 bytes; a 10-byte limit forces the guard to fire
    // without needing a real multi-gigabyte fixture.
    await expect(unwrapIfcZipWithLimit(zip, 10)).rejects.toThrow(/refusing to decompress/);
  });

  it('allows a model entry within the size limit', async () => {
    const zip = await makeZip({ 'model.ifc': STEP_HEADER });
    const result = await unwrapIfcZipWithLimit(zip, STEP_HEADER.length + 1);
    expect(new TextDecoder().decode(result)).toBe(STEP_HEADER);
  });
});

describe('unwrapIfcZipView', () => {
  it('unwraps a Uint8Array view that does not span its whole backing buffer', async () => {
    const zip = await makeZip({ 'model.ifc': STEP_HEADER });
    const zipBytes = new Uint8Array(zip);
    // Pad the backing buffer so the view is a slice, not the whole thing —
    // exercises the byteOffset/byteLength handling.
    const padded = new Uint8Array(zipBytes.length + 16);
    padded.set(zipBytes, 8);
    const view = padded.subarray(8, 8 + zipBytes.length);

    const result = await unwrapIfcZipView(view);
    expect(new TextDecoder().decode(result)).toBe(STEP_HEADER);
  });

  it('passes non-zip views through unchanged', async () => {
    const bytes = new TextEncoder().encode(STEP_HEADER);
    const result = await unwrapIfcZipView(bytes);
    expect(new TextDecoder().decode(result)).toBe(STEP_HEADER);
  });

  it('does not copy the backing buffer for a non-zip full-span view', async () => {
    // A fresh Uint8Array spans its whole ArrayBuffer (byteOffset 0, full
    // length) — the common CLI/MCP case for a real IFC file. The view's
    // backing buffer must be returned as-is, not a fresh copy.
    const bytes = new TextEncoder().encode(STEP_HEADER);
    const result = await unwrapIfcZipView(bytes);
    expect(result).toBe(bytes.buffer);
  });

  it('slices a non-zip view that does not span its whole backing buffer', async () => {
    const inner = new TextEncoder().encode(STEP_HEADER);
    const padded = new Uint8Array(inner.length + 16);
    padded.set(inner, 8);
    const view = padded.subarray(8, 8 + inner.length);

    const result = await unwrapIfcZipView(view);
    // Correct bytes, and a fresh buffer sized exactly to the view (not the
    // padded backing buffer).
    expect(new TextDecoder().decode(result)).toBe(STEP_HEADER);
    expect(result.byteLength).toBe(inner.length);
    expect(result).not.toBe(padded.buffer);
  });
});

describe('unwrapIfcZipWithResources (#1781)', () => {
  it('returns non-zip buffers unchanged with an empty resource map', async () => {
    const buffer = toArrayBuffer(STEP_HEADER);
    const { model, resources } = await unwrapIfcZipWithResources(buffer);
    expect(new TextDecoder().decode(model)).toBe(STEP_HEADER);
    expect(resources.size).toBe(0);
  });

  it('extracts sibling raster images keyed by lowercased basename', async () => {
    const zip = await makeZip({
      'model.ifc': STEP_HEADER,
      'Textures/Wood_Grain.JPG': 'jpg-bytes',
      'brick.jpeg': 'jpeg-bytes',
      'logo.png': 'png-bytes',
      'readme.txt': 'not an image',
    });
    const { model, resources } = await unwrapIfcZipWithResources(zip);
    expect(new TextDecoder().decode(model)).toBe(STEP_HEADER);
    expect([...resources.keys()].sort()).toEqual(['brick.jpeg', 'logo.png', 'wood_grain.jpg']);
    expect(new TextDecoder().decode(resources.get('wood_grain.jpg'))).toBe('jpg-bytes');
  });

  it('still enforces the single-model-entry rule', async () => {
    const zip = await makeZip({
      'a.ifc': STEP_HEADER,
      'b.ifc': STEP_HEADER,
      'wood.jpg': 'jpg-bytes',
    });
    await expect(unwrapIfcZipWithResources(zip)).rejects.toThrow(/2 model files/);
  });

  it('first entry wins on a basename collision', async () => {
    const zip = await makeZip({
      'model.ifc': STEP_HEADER,
      'a/wood.jpg': 'first',
      'b/wood.jpg': 'second',
    });
    const { resources } = await unwrapIfcZipWithResources(zip);
    expect(resources.size).toBe(1);
    expect(new TextDecoder().decode(resources.get('wood.jpg'))).toBe('first');
  });
});

describe('unwrapIfcZipWithResources aggregate budgets (#1781)', () => {
  it('caps the number of retained images', async () => {
    const entries: Record<string, string> = { 'model.ifc': STEP_HEADER };
    for (let i = 0; i < 300; i++) entries[`img_${String(i).padStart(3, '0')}.png`] = 'x';
    const zip = await makeZip(entries);
    const { resources } = await unwrapIfcZipWithResources(zip);
    expect(resources.size).toBe(256);
  });
});
