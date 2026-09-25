/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JSZip's `ZipFileWorker` hardcodes "version needed to extract" to 0x000A
 * (1.0) for every entry it writes, in both the local file header and the
 * central directory header, regardless of compression method. `writeBCF`
 * always uses DEFLATE (method 8), which the ZIP APPNOTE (4.4.3) requires
 * 0x0014 (2.0) for, so the archives this package writes are out of spec on
 * their own terms. Found while investigating #3612; whether this explains
 * the import failures reported there is not established. The writer now
 * packs with fflate (writer-archive.ts), which writes 2.0 itself.
 *
 * This test parses the REAL writer's REAL output with a hand-written parser
 * — never JSZip. A self round-trip (write with JSZip, read back with JSZip)
 * cannot see this defect: JSZip does not check the field it wrote, so
 * writer and reader agree with each other while disagreeing with every
 * other implementation of the format. That is exactly the trap #3612's
 * comment thread got stuck on.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { createBCFProject, createBCFTopic, addTopicToProject, writeBCF, readBCF } from './index.js';

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIRECTORY_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

interface ParsedEntry {
  name: string;
  lfhOffset: number;
  cd: { versionNeeded: number; flags: number; method: number; crc32: number; compSize: number; uncompSize: number };
  lfh: { versionNeeded: number; flags: number; method: number; crc32: number; compSize: number; uncompSize: number };
}

/** Hand-written ZIP structure parser: EOCD -> central directory -> local headers. */
function parseZip(buf: Uint8Array): ParsedEntry[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let eocdOffset = -1;
  const minPos = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('EOCD not found');

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const entries: ParsedEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    const sig = view.getUint32(p, true);
    if (sig !== CENTRAL_DIRECTORY_SIG) {
      throw new Error(`expected central directory sig at 0x${p.toString(16)}, got 0x${sig.toString(16)}`);
    }
    const versionNeeded = view.getUint16(p + 6, true);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc32 = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const lfhOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.slice(p + 46, p + 46 + nameLength));

    const lfhSig = view.getUint32(lfhOffset, true);
    if (lfhSig !== LOCAL_FILE_HEADER_SIG) {
      throw new Error(`expected local file header sig at 0x${lfhOffset.toString(16)}, got 0x${lfhSig.toString(16)}`);
    }
    const lfhVersionNeeded = view.getUint16(lfhOffset + 4, true);
    const lfhFlags = view.getUint16(lfhOffset + 6, true);
    const lfhMethod = view.getUint16(lfhOffset + 8, true);
    const lfhCrc32 = view.getUint32(lfhOffset + 14, true);
    const lfhCompSize = view.getUint32(lfhOffset + 18, true);
    const lfhUncompSize = view.getUint32(lfhOffset + 22, true);

    entries.push({
      name,
      lfhOffset,
      cd: { versionNeeded, flags, method, crc32, compSize, uncompSize },
      lfh: {
        versionNeeded: lfhVersionNeeded,
        flags: lfhFlags,
        method: lfhMethod,
        crc32: lfhCrc32,
        compSize: lfhCompSize,
        uncompSize: lfhUncompSize,
      },
    });

    p += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function buildSampleProject() {
  const project = createBCFProject({ name: 'ZIP metadata test', version: '2.1' });
  const topic = createBCFTopic({ title: 'Sample topic', author: 'tester@example.com' });
  addTopicToProject(project, topic);
  return project;
}

describe('writeBCF ZIP "version needed to extract" field (#3612)', () => {
  it('sets version-needed to 0x0014 (2.0) on both the local and central directory headers for every entry', async () => {
    const blob = await writeBCF(buildSampleProject());
    const buf = new Uint8Array(await blob.arrayBuffer());
    const entries = parseZip(buf);

    // Sanity: this project must produce more than one entry, or the "every
    // entry" assertion below would vacuously pass on a single-entry archive.
    expect(entries.length).toBeGreaterThan(1);

    for (const entry of entries) {
      expect(entry.cd.versionNeeded, `central directory header for ${entry.name}`).toBe(0x0014);
      expect(entry.lfh.versionNeeded, `local file header for ${entry.name}`).toBe(0x0014);
    }
  });

  it('writes no data descriptors, DEFLATE on every entry, and matching sizes and CRCs in both headers', async () => {
    const blob = await writeBCF(buildSampleProject());
    const buf = new Uint8Array(await blob.arrayBuffer());
    const entries = parseZip(buf);

    for (const entry of entries) {
      // The whole general-purpose flag field is 0x0000: no data descriptor
      // (bit 3), no encryption, and no UTF-8 bit (entry names are ASCII).
      expect(entry.cd.flags, `CD flags for ${entry.name}`).toBe(0x0000);
      expect(entry.lfh.flags, `LFH flags for ${entry.name}`).toBe(0x0000);

      expect(entry.cd.method, `CD method for ${entry.name}`).toBe(8);
      expect(entry.lfh.method, `LFH method for ${entry.name}`).toBe(8);

      // Sizes and CRC are known up front, so both headers carry them.
      expect(entry.lfh.crc32, `CRC mismatch for ${entry.name}`).toBe(entry.cd.crc32);
      expect(entry.lfh.compSize, `compSize mismatch for ${entry.name}`).toBe(entry.cd.compSize);
      expect(entry.lfh.uncompSize, `uncompSize mismatch for ${entry.name}`).toBe(entry.cd.uncompSize);
    }
  });

  it('negative control: the header parser does see JSZip\'s 1.0 on a DEFLATE entry', async () => {
    // Proves the assertions above can fail: JSZip, which the writer used
    // before, still writes 0x000A here.
    const zip = new JSZip();
    zip.file('bcf.version', '<Version VersionId="2.1"/>');
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const [entry] = parseZip(bytes);
    expect(entry.cd.method).toBe(8);
    expect(entry.cd.versionNeeded).toBe(0x000a);
    expect(entry.lfh.versionNeeded).toBe(0x000a);
  });

  it('packs a large (400 kB) snapshot byte-exactly, at version 2.0', async () => {
    const snapshotData = new Uint8Array(400_000);
    let x = 12345;
    for (let i = 0; i < snapshotData.length; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      snapshotData[i] = x >>> 24;
    }
    const project = createBCFProject({ name: 'Large snapshot', version: '2.1' });
    const topic = createBCFTopic({ title: 'Large snapshot', author: 'tester@example.com' });
    topic.viewpoints.push({
      guid: 'b0646c0b-0000-4000-8000-000000000002',
      perspectiveCamera: {
        cameraViewPoint: { x: 0, y: 0, z: 10 },
        cameraDirection: { x: 0, y: 1, z: 0 },
        cameraUpVector: { x: 0, y: 0, z: 1 },
        fieldOfView: 45,
        aspectRatio: 1,
      },
      snapshotData,
    });
    addTopicToProject(project, topic);

    const blob = await writeBCF(project);
    const entries = parseZip(new Uint8Array(await blob.arrayBuffer()));
    const png = entries.find((e) => e.name.endsWith('.png'));
    expect(png?.cd.uncompSize).toBe(snapshotData.length);
    expect(png?.cd.versionNeeded).toBe(0x0014);
    expect(png?.lfh.versionNeeded).toBe(0x0014);

    const archive = await JSZip.loadAsync(blob);
    const back = await archive.file(png!.name)!.async('uint8array');
    expect(back).toEqual(snapshotData);
  });

  it.each(['2.1', '3.0'] as const)(
    'writes 2.0 on every entry kind, including viewpoint and snapshot, and reads back (BCF %s)',
    async (version) => {
      const project = createBCFProject({ name: 'ZIP metadata test', version });
      const topic = createBCFTopic({ title: 'With viewpoint', author: 'tester@example.com' });
      topic.viewpoints.push({
        guid: 'b0646c0b-0000-4000-8000-000000000001',
        perspectiveCamera: {
          cameraViewPoint: { x: 0, y: 0, z: 10 },
          cameraDirection: { x: 0, y: 1, z: 0 },
          cameraUpVector: { x: 0, y: 0, z: 1 },
          fieldOfView: 45,
          aspectRatio: 16 / 9,
        },
        // 1x1 PNG
        snapshot:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      });
      addTopicToProject(project, topic);

      const blob = await writeBCF(project);
      const entries = parseZip(new Uint8Array(await blob.arrayBuffer()));
      const names = entries.map((e) => e.name);
      expect(names.some((n) => n.endsWith('.bcfv'))).toBe(true);
      expect(names.some((n) => n.endsWith('.png'))).toBe(true);
      for (const entry of entries) {
        expect(entry.cd.versionNeeded, `central directory header for ${entry.name}`).toBe(0x0014);
        expect(entry.lfh.versionNeeded, `local file header for ${entry.name}`).toBe(0x0014);
        expect(entry.name.endsWith('/'), `directory entry ${entry.name}`).toBe(false);
      }

      const read = await readBCF(blob);
      const back = read.topics.get(topic.guid);
      expect(back?.title).toBe('With viewpoint');
      expect(back?.viewpoints).toHaveLength(1);
    },
  );
});
