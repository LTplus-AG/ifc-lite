/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { assembleStepBlob, assembleStepBytes } from './step-serialization.js';

/**
 * Reference implementation of the OLD (pre-rewrite) `assembleStepBytes`:
 * single-pass `encoder.encode()` per entity, keeping every encoded chunk
 * alive in a persistent `Uint8Array[]` until the final copy. Kept here
 * (rather than trusting a snapshot) so the byte-identity test fails loudly
 * if the new two-pass `encodeInto` assembler ever drifts from it, on a
 * UTF-8 corpus that specifically exercises multi-byte characters.
 */
function assembleStepBytesReference(header: string, entities: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const headBytes = encoder.encode(`${header}DATA;\n`);
  const tailBytes = encoder.encode('ENDSEC;\nEND-ISO-10303-21;\n');
  const newline = encoder.encode('\n');

  let totalSize = headBytes.byteLength + tailBytes.byteLength;
  const entityBytes: Uint8Array[] = new Array(entities.length);
  for (let i = 0; i < entities.length; i++) {
    entityBytes[i] = encoder.encode(entities[i]);
    totalSize += entityBytes[i].byteLength + newline.byteLength;
  }

  const result = new Uint8Array(totalSize);
  let offset = 0;
  result.set(headBytes, offset);
  offset += headBytes.byteLength;
  for (let i = 0; i < entityBytes.length; i++) {
    result.set(entityBytes[i], offset);
    offset += entityBytes[i].byteLength;
    result.set(newline, offset);
    offset += newline.byteLength;
  }
  result.set(tailBytes, offset);
  return result;
}

const HEADER = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nENDSEC;\n";

/** UTF-8 corpus: ASCII, Latin-1 accents, 2/3-byte BMP chars, and a 4-byte
 * surrogate-pair emoji, all inside STEP entity strings (the realistic case:
 * IFCLABEL/IFCTEXT attribute values carry user text). */
const UTF8_ENTITIES = [
  "#1=IFCWALL('0000000000000000000001',$,'Plain ASCII wall',$,$,$,$,$,$);",
  "#2=IFCLABEL('Wand mit Umlauten: äöüÄÖÜß und Zeichen: café, naïve');",
  "#3=IFCTEXT('日本語のテキスト and 中文文本 mixed with ASCII');",
  "#4=IFCLABEL('Emoji stress test: 🏗️🏢🧱🪟 and combining marks: é');",
  "#5=IFCLABEL('');", // empty string entity
  `#6=IFCTEXT('${'x'.repeat(5000)}${'ü'.repeat(2000)}${'文'.repeat(1000)}');`, // forces scratch-buffer growth
];

describe('assembleStepBytes', () => {
  it('is byte-identical to the pre-rewrite single-pass reference on ASCII-only entities', () => {
    const entities = [
      "#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);",
      "#2=IFCWALL('0000000000000000000002',$,'Wall 1',$,$,$,$,$,$);",
    ];
    const expected = assembleStepBytesReference(HEADER, entities);
    const actual = assembleStepBytes(HEADER, entities);
    expect(actual).toEqual(expected);
  });

  it('is byte-identical to the pre-rewrite reference on a multi-byte UTF-8 corpus', () => {
    const expected = assembleStepBytesReference(HEADER, UTF8_ENTITIES);
    const actual = assembleStepBytes(HEADER, UTF8_ENTITIES);
    expect(actual.length).toBe(expected.length);
    expect(actual).toEqual(expected);
  });

  it('handles zero entities', () => {
    const expected = assembleStepBytesReference(HEADER, []);
    const actual = assembleStepBytes(HEADER, []);
    expect(actual).toEqual(expected);
  });

  it('round-trips through TextDecoder back to the original entity text', () => {
    const bytes = assembleStepBytes(HEADER, UTF8_ENTITIES);
    const text = new TextDecoder('utf-8').decode(bytes);
    for (const entity of UTF8_ENTITIES) {
      expect(text).toContain(entity);
    }
  });
});

describe('assembleStepBlob', () => {
  it('has byte content identical to assembleStepBytes on a multi-byte UTF-8 corpus', async () => {
    const blob = assembleStepBlob(HEADER, UTF8_ENTITIES);
    const blobBytes = new Uint8Array(await blob.arrayBuffer());
    const bytes = assembleStepBytes(HEADER, UTF8_ENTITIES);
    expect(blobBytes).toEqual(bytes);
  });

  it('has byte content identical to assembleStepBytes on ASCII-only entities', async () => {
    const entities = [
      "#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);",
      "#2=IFCWALL('0000000000000000000002',$,'Wall 1',$,$,$,$,$,$);",
    ];
    const blob = assembleStepBlob(HEADER, entities);
    const blobBytes = new Uint8Array(await blob.arrayBuffer());
    const bytes = assembleStepBytes(HEADER, entities);
    expect(blobBytes).toEqual(bytes);
  });

  it('handles zero entities identically to assembleStepBytes', async () => {
    const blob = assembleStepBlob(HEADER, []);
    const blobBytes = new Uint8Array(await blob.arrayBuffer());
    const bytes = assembleStepBytes(HEADER, []);
    expect(blobBytes).toEqual(bytes);
  });

  it('reports the combined byte size via blob.size', async () => {
    const blob = assembleStepBlob(HEADER, UTF8_ENTITIES);
    const bytes = assembleStepBytes(HEADER, UTF8_ENTITIES);
    expect(blob.size).toBe(bytes.byteLength);
  });
});
