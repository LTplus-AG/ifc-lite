/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF Reader Tests
 *
 * Tests the BCF reader against official buildingSMART test files:
 * - PerspectiveCamera.bcf - Tests perspective camera viewpoint
 * - OrthogonalCamera.bcf - Tests orthogonal camera viewpoint
 *
 * @see https://github.com/buildingSMART/BCF-XML/tree/release_3_0/Test%20Cases/v2.1
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readBCF } from './reader.js';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DATA_DIR = join(__dirname, '..', 'test-data');

describe('BCF Reader - buildingSMART Test Files', () => {
  describe('PerspectiveCamera.bcf', () => {
    it('should parse the BCF file successfully', async () => {
      const filePath = join(TEST_DATA_DIR, 'PerspectiveCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      expect(project).toBeDefined();
      expect(project.version).toBe('2.1');
    });

    it('should have exactly one topic', async () => {
      const filePath = join(TEST_DATA_DIR, 'PerspectiveCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      expect(project.topics.size).toBe(1);
    });

    it('should have a topic with viewpoint containing perspective camera', async () => {
      const filePath = join(TEST_DATA_DIR, 'PerspectiveCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      const topic = Array.from(project.topics.values())[0];
      expect(topic).toBeDefined();
      expect(topic.viewpoints.length).toBeGreaterThan(0);

      const viewpoint = topic.viewpoints[0];
      expect(viewpoint).toBeDefined();
      expect(viewpoint.perspectiveCamera).toBeDefined();
      expect(viewpoint.orthogonalCamera).toBeUndefined();
    });

    it('should have valid perspective camera values', async () => {
      const filePath = join(TEST_DATA_DIR, 'PerspectiveCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      const topic = Array.from(project.topics.values())[0];
      const viewpoint = topic.viewpoints[0];
      const camera = viewpoint.perspectiveCamera!;

      // Camera view point (position)
      expect(camera.cameraViewPoint).toBeDefined();
      expect(typeof camera.cameraViewPoint.x).toBe('number');
      expect(typeof camera.cameraViewPoint.y).toBe('number');
      expect(typeof camera.cameraViewPoint.z).toBe('number');

      // Camera direction
      expect(camera.cameraDirection).toBeDefined();
      expect(typeof camera.cameraDirection.x).toBe('number');
      expect(typeof camera.cameraDirection.y).toBe('number');
      expect(typeof camera.cameraDirection.z).toBe('number');

      // Camera up vector
      expect(camera.cameraUpVector).toBeDefined();
      expect(typeof camera.cameraUpVector.x).toBe('number');
      expect(typeof camera.cameraUpVector.y).toBe('number');
      expect(typeof camera.cameraUpVector.z).toBe('number');

      // Field of view (in degrees)
      expect(camera.fieldOfView).toBeDefined();
      expect(typeof camera.fieldOfView).toBe('number');
      expect(camera.fieldOfView).toBeGreaterThan(0);
      expect(camera.fieldOfView).toBeLessThan(180);
    });

    it('should have a snapshot image', async () => {
      const filePath = join(TEST_DATA_DIR, 'PerspectiveCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      const topic = Array.from(project.topics.values())[0];
      const viewpoint = topic.viewpoints[0];

      // The test file includes a snapshot
      expect(viewpoint.snapshot).toBeDefined();
      expect(viewpoint.snapshot).toMatch(/^data:image\/(png|jpeg);base64,/);
    });
  });

  describe('OrthogonalCamera.bcf', () => {
    it('should parse the BCF file successfully', async () => {
      const filePath = join(TEST_DATA_DIR, 'OrthogonalCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      expect(project).toBeDefined();
      expect(project.version).toBe('2.1');
    });

    it('should have exactly one topic', async () => {
      const filePath = join(TEST_DATA_DIR, 'OrthogonalCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      expect(project.topics.size).toBe(1);
    });

    it('should have a topic with viewpoint containing orthogonal camera', async () => {
      const filePath = join(TEST_DATA_DIR, 'OrthogonalCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      const topic = Array.from(project.topics.values())[0];
      expect(topic).toBeDefined();
      expect(topic.viewpoints.length).toBeGreaterThan(0);

      const viewpoint = topic.viewpoints[0];
      expect(viewpoint).toBeDefined();
      expect(viewpoint.orthogonalCamera).toBeDefined();
      expect(viewpoint.perspectiveCamera).toBeUndefined();
    });

    it('should have valid orthogonal camera values', async () => {
      const filePath = join(TEST_DATA_DIR, 'OrthogonalCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      const topic = Array.from(project.topics.values())[0];
      const viewpoint = topic.viewpoints[0];
      const camera = viewpoint.orthogonalCamera!;

      // Camera view point (position)
      expect(camera.cameraViewPoint).toBeDefined();
      expect(typeof camera.cameraViewPoint.x).toBe('number');
      expect(typeof camera.cameraViewPoint.y).toBe('number');
      expect(typeof camera.cameraViewPoint.z).toBe('number');

      // Camera direction
      expect(camera.cameraDirection).toBeDefined();
      expect(typeof camera.cameraDirection.x).toBe('number');
      expect(typeof camera.cameraDirection.y).toBe('number');
      expect(typeof camera.cameraDirection.z).toBe('number');

      // Camera up vector
      expect(camera.cameraUpVector).toBeDefined();
      expect(typeof camera.cameraUpVector.x).toBe('number');
      expect(typeof camera.cameraUpVector.y).toBe('number');
      expect(typeof camera.cameraUpVector.z).toBe('number');

      // View to world scale (orthogonal specific)
      expect(camera.viewToWorldScale).toBeDefined();
      expect(typeof camera.viewToWorldScale).toBe('number');
      expect(camera.viewToWorldScale).toBeGreaterThan(0);
    });

    it('should have a snapshot image', async () => {
      const filePath = join(TEST_DATA_DIR, 'OrthogonalCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      const topic = Array.from(project.topics.values())[0];
      const viewpoint = topic.viewpoints[0];

      // The test file includes a snapshot
      expect(viewpoint.snapshot).toBeDefined();
      expect(viewpoint.snapshot).toMatch(/^data:image\/(png|jpeg);base64,/);
    });
  });

  describe('Common BCF structure', () => {
    it('should have valid topic GUIDs', async () => {
      const filePath = join(TEST_DATA_DIR, 'PerspectiveCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      for (const topic of project.topics.values()) {
        expect(topic.guid).toBeDefined();
        expect(topic.guid.length).toBeGreaterThan(0);
      }
    });

    it('should have valid viewpoint GUIDs', async () => {
      const filePath = join(TEST_DATA_DIR, 'PerspectiveCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      for (const topic of project.topics.values()) {
        for (const viewpoint of topic.viewpoints) {
          expect(viewpoint.guid).toBeDefined();
          expect(viewpoint.guid.length).toBeGreaterThan(0);
        }
      }
    });

    it('should have topic title', async () => {
      const filePath = join(TEST_DATA_DIR, 'PerspectiveCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      const topic = Array.from(project.topics.values())[0];
      expect(topic.title).toBeDefined();
      expect(topic.title.length).toBeGreaterThan(0);
    });

    it('should have creation date', async () => {
      const filePath = join(TEST_DATA_DIR, 'PerspectiveCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);

      const topic = Array.from(project.topics.values())[0];
      expect(topic.creationDate).toBeDefined();
      // Should be a valid ISO date string
      expect(new Date(topic.creationDate!).toString()).not.toBe('Invalid Date');
    });
  });

  describe('interop: foreign schema element ordering', () => {
    it('reads a comment that precedes the <Viewpoints> block and decodes XML entities', async () => {
      // BCF 2.1 schema order is Comment* then Viewpoints*, so a foreign tool's
      // last comment is followed by <Viewpoints>, not </Markup>. Combined with
      // the nested <Comment>text</Comment> field sharing the wrapper's tag name,
      // a naive parser drops the comment or truncates its text to ''. This guards
      // the parseComments lookahead + the extractElement entity-unescape.
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title>Fire &amp; Smoke &lt;Wall&gt;</Title>',
        '  </Topic>',
        '  <Comment Guid="comment-1">',
        '    <Date>2026-01-01T00:00:00Z</Date>',
        '    <Author>alice@example.com</Author>',
        '    <Comment>Needs REI 90 &amp; a &quot;review&quot;</Comment>',
        '  </Comment>',
        '  <Viewpoints Guid="vp-1">',
        '    <Viewpoint>viewpoint.bcfv</Viewpoint>',
        '  </Viewpoints>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];

      expect(topic).toBeDefined();
      // Title entity-unescape round-trips.
      expect(topic.title).toBe('Fire & Smoke <Wall>');
      // The comment is not dropped despite being followed by <Viewpoints>, and
      // its text is the wrapper's nested field (not '' from the tag collision),
      // with XML entities decoded.
      expect(topic.comments.length).toBe(1);
      expect(topic.comments[0].comment).toBe('Needs REI 90 & a "review"');
    });

    it('reads a comment inside a BCF 3.0 <Comments> container', async () => {
      // BCF 3.0 wraps comments in <Comments>, so the outer </Comment> is
      // followed by </Comments> (not another comment or </Markup>). readBCF
      // accepts version 3.0, so the parser must not drop these.
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title>3.0 topic</Title>',
        '  </Topic>',
        '  <Comments>',
        '    <Comment Guid="comment-1">',
        '      <Date>2026-01-01T00:00:00Z</Date>',
        '      <Author>bob@example.com</Author>',
        '      <Comment>a wrapped 3.0 comment</Comment>',
        '    </Comment>',
        '  </Comments>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="3.0"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.comments.length).toBe(1);
      expect(topic.comments[0].comment).toBe('a wrapped 3.0 comment');
    });

    it('reads a comment followed by an unknown vendor-extension element', async () => {
      // A vendor element between the last comment and </Markup> must not cause
      // the comment to be silently dropped.
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1"><Title>t</Title></Topic>',
        '  <Comment Guid="comment-1">',
        '    <Comment>vendor-followed comment</Comment>',
        '  </Comment>',
        '  <RevitExtensions><Foo>bar</Foo></RevitExtensions>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.comments.length).toBe(1);
      expect(topic.comments[0].comment).toBe('vendor-followed comment');
    });

    it('reads repeated <Labels>text</Labels> elements (BCF 2.1 shape)', async () => {
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title>2.1 labels</Title>',
        '    <Labels>Structural</Labels>',
        '    <Labels>Urgent &amp; Important</Labels>',
        '  </Topic>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.labels).toEqual(['Structural', 'Urgent & Important']);
    });

    it('reads a <Labels><Label>...</Label></Labels> container (BCF 3.0 shape)', async () => {
      // BCF 3.0's markup.xsd wraps repeated <Label> children in ONE <Labels>
      // container, unlike 2.1's repeated <Labels>text</Labels> element. A
      // reader that only matches the 2.1 shape sees `<Labels><Label>` (a `<`
      // immediately after the opening tag, not text) and silently drops
      // every label in a conformant 3.0 archive.
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title>3.0 labels</Title>',
        '    <Labels>',
        '      <Label>Structural</Label>',
        '      <Label>Urgent &amp; Important</Label>',
        '    </Labels>',
        '  </Topic>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="3.0"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.labels).toEqual(['Structural', 'Urgent & Important']);
    });

    it('reads a CDATA label without dropping it or entity-decoding its content', async () => {
      // A CDATA section starts with `<`, so a label content regex of
      // `[^<]*` rejects it outright and the label vanishes. Per the XML
      // spec CDATA content is literal: `&amp;` inside CDATA must stay
      // `&amp;`, while text outside CDATA is still entity-decoded.
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title>CDATA labels</Title>',
        '    <Labels>',
        '      <Label><![CDATA[Urgent & Important]]></Label>',
        '      <Label>plain &amp; decoded <![CDATA[literal &amp; kept]]></Label>',
        '    </Labels>',
        '  </Topic>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="3.0"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.labels).toEqual([
        'Urgent & Important',
        'plain & decoded literal &amp; kept',
      ]);
    });

    it('reads a CDATA label in the BCF 2.1 direct-text shape', async () => {
      // The 2.1 fallback path guarded on `!inner.includes('<')`, so a
      // 2.1 `<Labels><![CDATA[...]]></Labels>` was dropped the same way.
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title>2.1 CDATA label</Title>',
        '    <Labels><![CDATA[Cost < Budget]]></Labels>',
        '    <Labels>Structural</Labels>',
        '  </Topic>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.labels).toEqual(['Cost < Budget', 'Structural']);
    });
  });

  describe('resource caps (zip-bomb guard)', () => {
    const VERSION_XML = '<?xml version="1.0"?><Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>';

    /** Find a byte signature in a buffer, or -1. */
    function findSig(bytes: Uint8Array, sig: number[], from = 0): number {
      outer: for (let i = from; i + sig.length <= bytes.length; i++) {
        for (let j = 0; j < sig.length; j++) {
          if (bytes[i + j] !== sig[j]) continue outer;
        }
        return i;
      }
      return -1;
    }

    const LOCAL_SIG = [0x50, 0x4b, 0x03, 0x04];
    const CENTRAL_SIG = [0x50, 0x4b, 0x01, 0x02];
    const EOCD_SIG = [0x50, 0x4b, 0x05, 0x06];

    /** Split a single-entry zip into its local record, central record and EOCD. */
    async function singleEntryZipParts(name: string, content: string | Uint8Array): Promise<{
      local: Uint8Array; central: Uint8Array; eocd: Uint8Array; bytes: Uint8Array;
    }> {
      const zip = new JSZip();
      zip.file(name, content);
      const bytes = new Uint8Array(await zip.generateAsync({
        type: 'arraybuffer',
        compression: typeof content === 'string' && content.length < 1024 ? 'STORE' : 'DEFLATE',
      }));
      const centralStart = findSig(bytes, CENTRAL_SIG);
      const eocdStart = findSig(bytes, EOCD_SIG);
      return {
        local: bytes.slice(0, centralStart),
        central: bytes.slice(centralStart, eocdStart),
        eocd: bytes.slice(eocdStart),
        bytes,
      };
    }

    it('rejects an archive whose declared size exceeds the compressed-input cap', async () => {
      // Stub a Blob-like object reporting a size past the 250 MB cap; readBCF
      // throws before ever decompressing, so no large allocation is needed.
      const oversized = { size: 300 * 1024 * 1024 } as unknown as Blob;
      await expect(readBCF(oversized)).rejects.toThrow(/exceeds cap/);
    });

    it('still reads a normal, within-cap archive', async () => {
      const zip = new JSZip();
      zip.file('bcf.version', VERSION_XML);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });
      const project = await readBCF(buf);
      expect(project.version).toBe('2.1');
    });

    it('rejects a duplicate-pathname record flood that JSZip dedupes to one visible entry', async () => {
      // 25 central-directory records sharing one name: JSZip's `files` map is
      // keyed by pathname, so an entry-count check over it sees 1 entry. The
      // raw-record scan counts all 25 and rejects.
      const { local, central, eocd } = await singleEntryZipParts('bcf.version', VERSION_XML);
      const n = 25;
      const flood = new Uint8Array(local.length * n + central.length * n + eocd.length);
      for (let i = 0; i < n; i++) flood.set(local, i * local.length);
      const cdStart = local.length * n;
      const dv = new DataView(flood.buffer);
      for (let i = 0; i < n; i++) {
        const pos = cdStart + i * central.length;
        flood.set(central, pos);
        dv.setUint32(pos + 42, i * local.length, true); // offset of local header
      }
      const eocdPos = cdStart + central.length * n;
      flood.set(eocd, eocdPos);
      dv.setUint16(eocdPos + 8, n, true); // entries on this disk
      dv.setUint16(eocdPos + 10, n, true); // total entries
      dv.setUint32(eocdPos + 12, central.length * n, true); // central dir size
      dv.setUint32(eocdPos + 16, cdStart, true); // central dir offset

      // Prove the dedupe premise: JSZip itself surfaces a single entry.
      const zip = await JSZip.loadAsync(flood);
      expect(Object.keys(zip.files)).toHaveLength(1);

      await expect(readBCF(flood, { maxEntries: 10 })).rejects.toThrow(/raw records exceeds cap/);
    });

    it('rejects a deflate bomb by ACTUAL decompressed bytes when declared sizes lie small', async () => {
      // 5 MB markup deflates to a few KB. Patch the declared uncompressedSize
      // (central directory AND local header) down to 100 so the declared-sum
      // pre-check passes; only counting real inflate output catches it.
      const bombMarkup = `<Markup><Topic Guid="bomb-topic"><Title>t</Title></Topic></Markup>${' '.repeat(5 * 1024 * 1024)}`;
      const zip = new JSZip();
      zip.file('bcf.version', VERSION_XML);
      zip.file('deadbeef/markup.bcf', bombMarkup);
      const bytes = new Uint8Array(await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }));
      const dv = new DataView(bytes.buffer);
      const name = new TextEncoder().encode('deadbeef/markup.bcf');
      for (const [sig, sizeOff, nameOff] of [[LOCAL_SIG, 22, 30], [CENTRAL_SIG, 24, 46]] as const) {
        for (let at = findSig(bytes, [...sig]); at !== -1; at = findSig(bytes, [...sig], at + 1)) {
          const entryName = bytes.slice(at + nameOff, at + nameOff + name.length);
          if (entryName.every((b, i) => b === name[i])) dv.setUint32(at + sizeOff, 100, true);
        }
      }

      await expect(readBCF(bytes, { maxExpandedBytes: 1024 * 1024 }))
        .rejects.toThrow(/decompressed output exceeds cap/);
    });

    it('rejects an entry declaring an invalid (negative-reading) uncompressed size', async () => {
      // Sizes past 0x7fffffff read as negative through the pinned JSZip's
      // signed readInt. JSZip itself only rejects the exact -1 (the ZIP64
      // marker 0xFFFFFFFF); any other negative-reading declaration reaches
      // our guard and must be rejected as invalid.
      const zip = new JSZip();
      zip.file('bcf.version', VERSION_XML);
      const bytes = new Uint8Array(await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' }));
      const dv = new DataView(bytes.buffer);
      const central = findSig(bytes, CENTRAL_SIG);
      dv.setUint32(central + 24, 0x80000001, true);

      await expect(readBCF(bytes)).rejects.toThrow(/invalid size/);
    });

    it('tolerates traversal-shaped and absolute entry names without touching them as paths', async () => {
      // The reader only ever addresses entries inside the in-memory zip map;
      // `../../evil` and absolute names must neither crash nor be interpreted.
      const zip = new JSZip();
      zip.file('bcf.version', VERSION_XML);
      zip.file('../../evil', 'boo');
      zip.file('/absolute/path.txt', 'boo');
      zip.file('../markup.bcf', '<Markup><Topic Guid="dotdot-topic"><Title>t</Title></Topic></Markup>');
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buf);
      expect(project.version).toBe('2.1');
    });
  });

  describe('markup.bcf <Viewpoints> element (plural, per BCF 2.1/3.0 schema)', () => {
    it('resolves the markup-declared Snapshot filename even when it does not follow the buildingSMART naming convention', async () => {
      // The <Viewpoints Guid="..."> markup element is the top-level element linking a
      // viewpoint's GUID to its .bcfv file and snapshot image (see writer.ts
      // writeMarkupFile, which emits exactly this plural tag). A prior regex here
      // looked for singular <Viewpoint Guid="..."> -- the tag Comment elements use to
      // *reference* a viewpoint -- which can never match this markup element. That left
      // the reader silently falling back to guessing the snapshot filename from
      // naming-convention patterns (Viewpoint_<guid>.bcfv -> Snapshot_<guid>.png etc.).
      // Third-party BCF files are free to name their entries however they like per
      // spec; when the snapshot filename doesn't match any guessed pattern, the
      // snapshot the markup explicitly names must still be found.
      const zip = new JSZip();
      const topicGuid = '11111111-1111-1111-1111-111111111111';
      const vpGuid = '22222222-2222-2222-2222-222222222222';
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>');
      zip.file(
        `${topicGuid}/markup.bcf`,
        `<?xml version="1.0" encoding="utf-8"?>
<Markup>
  <Topic Guid="${topicGuid}">
    <Title>Custom filenames</Title>
  </Topic>
  <Viewpoints Guid="${vpGuid}">
    <Viewpoint>custom_camera_view.bcfv</Viewpoint>
    <Snapshot>custom_image_export.png</Snapshot>
  </Viewpoints>
</Markup>`
      );
      zip.file(
        `${topicGuid}/custom_camera_view.bcfv`,
        `<?xml version="1.0" encoding="utf-8"?>
<VisualizationInfo Guid="${vpGuid}">
  <PerspectiveCamera>
    <CameraViewPoint><X>0</X><Y>0</Y><Z>0</Z></CameraViewPoint>
    <CameraDirection><X>1</X><Y>0</Y><Z>0</Z></CameraDirection>
    <CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector>
    <FieldOfView>60</FieldOfView>
  </PerspectiveCamera>
</VisualizationInfo>`
      );
      zip.file(`${topicGuid}/custom_image_export.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      const project = await readBCF(buffer);
      const topic = project.topics.get(topicGuid);

      expect(topic?.viewpoints).toHaveLength(1);
      const vp = topic!.viewpoints[0];
      // The viewpoint's own GUID comes from the .bcfv file's VisualizationInfo element,
      // independent of this markup lookup, so it was never at risk -- but the snapshot
      // association was.
      expect(vp.guid).toBe(vpGuid);
      expect(vp.snapshot).toBeDefined();
      expect(vp.snapshotData).toBeDefined();
    });

    it('still finds the buildingSMART-fixture snapshot via the plural tag (regression against PerspectiveCamera.bcf)', async () => {
      const filePath = join(TEST_DATA_DIR, 'PerspectiveCamera.bcf');
      const buffer = await readFile(filePath);
      const project = await readBCF(buffer);
      const topic = [...project.topics.values()][0];

      expect(topic.viewpoints).toHaveLength(1);
      expect(topic.viewpoints[0].guid).toBe('caddfaad-73b0-4751-8d3f-ba2a4a954b7a');
      expect(topic.viewpoints[0].snapshot).toBeDefined();
    });

    it('resolves the markup-declared Snapshot for a genuine BCF 3.0 <ViewPoint> nested inside <Topic>', async () => {
      // Verbatim markup.bcf from buildingSMART/BCF-XML's own conformance
      // fixture (release_3_0, Test Cases/v3.0/Visualization/Perspective
      // camera/unzipped/01777b21-.../markup.bcf), fetched 2026-08-19:
      // https://raw.githubusercontent.com/buildingSMART/BCF-XML/release_3_0/Test%20Cases/v3.0/Visualization/Perspective%20camera/unzipped/01777b21-ba39-4c2b-ad1d-a9320f81214a/markup.bcf
      //
      // BCF 3.0's markup.xsd nests Viewpoints *inside* <Topic>, wrapped in a
      // plural <Viewpoints> container that (unlike 2.1's top-level
      // <Viewpoints Guid="...">) carries NO Guid itself; each entry is a
      // singular <ViewPoint Guid="..."> -- capital P, distinct from the
      // lowercase-p <Viewpoint Guid="..."/> a <Comment> uses to reference a
      // viewpoint. Before this test, parseViewpoints's markup lookup only
      // matched the 2.1-shaped <Viewpoints Guid="...">, so on a real 3.0 file
      // the lookup map was always empty for this shape, and snapshot
      // resolution fell through to guessing OUR OWN "Snapshot_<guid>.png"
      // naming convention -- which this vendor's actual filename
      // ("snapshot-<guid>.png") does not follow, so the snapshot was
      // silently dropped despite being correctly named in markup.bcf.
      const topicGuid = '01777b21-ba39-4c2b-ad1d-a9320f81214a';
      const vpGuid = 'f99eb1ed-6bd2-46da-95f1-663a86d5a38d';
      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Version VersionId="3.0"/>');
      zip.file(
        `${topicGuid}/markup.bcf`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Markup>
    <Header>
      <Files>
        <File IfcProject="2SugUv4EX5LAhcVpDp2dUH" IsExternal="true">
          <Filename>Architectural.ifc</Filename>
          <Date>2021-03-09T09:39:06.000Z</Date>
        </File>
      </Files>
    </Header>
    <Topic Guid="${topicGuid}" ServerAssignedId="3" TopicType="OTHER" TopicStatus="OPEN">
    <Title>Perspective camera</Title>
    <CreationDate>2021-02-17T10:49:50.286Z</CreationDate>
    <CreationAuthor>blackhole@aconex.com</CreationAuthor>
    <ModifiedDate>2021-02-17T10:49:50.559Z</ModifiedDate>
    <ModifiedAuthor>blackhole@aconex.com</ModifiedAuthor>
    <Description>A perspective camera viewpoint</Description>
    <DocumentReferences/>
    <RelatedTopics/>
    <Comments/>
    <Viewpoints>
      <ViewPoint Guid="${vpGuid}">
        <Viewpoint>viewpoint-${vpGuid}.bcfv</Viewpoint>
        <Snapshot>snapshot-${vpGuid}.png</Snapshot>
      </ViewPoint>
    </Viewpoints>
  </Topic>
</Markup>`
      );
      zip.file(
        `${topicGuid}/viewpoint-${vpGuid}.bcfv`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<VisualizationInfo Guid="${vpGuid}">
  <PerspectiveCamera>
    <CameraViewPoint><X>0</X><Y>0</Y><Z>0</Z></CameraViewPoint>
    <CameraDirection><X>1</X><Y>0</Y><Z>0</Z></CameraDirection>
    <CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector>
    <FieldOfView>60</FieldOfView>
  </PerspectiveCamera>
</VisualizationInfo>`
      );
      // Snapshot content itself is irrelevant to this test -- only that the
      // markup-declared filename ("snapshot-<guid>.png", NOT our own
      // "Snapshot_<guid>.png" convention) is the one actually resolved.
      zip.file(`${topicGuid}/snapshot-${vpGuid}.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      const project = await readBCF(buffer);
      const topic = project.topics.get(topicGuid);

      expect(topic?.viewpoints).toHaveLength(1);
      const vp = topic!.viewpoints[0];
      expect(vp.guid).toBe(vpGuid);
      expect(vp.perspectiveCamera).toBeDefined();
      expect(vp.snapshot).toBeDefined();
      expect(vp.snapshotData).toBeDefined();
    });
  });

  describe('viewpoint <Visibility DefaultVisibility> omitted (schema-declared default)', () => {
    // Hand-written to the vendored XSDs (packages/bcf/src/__fixtures__/schemas),
    // not generated with our own writer: writer.ts always emits the
    // DefaultVisibility attribute explicitly (writeVisibility), so a
    // self-round-trip can never exercise the omitted-attribute case and
    // would not have caught this.
    //
    // 2.1's markup.xsd/visinfo.xsd declares
    // `<xs:attribute name="DefaultVisibility" type="xs:boolean"/>` -- no
    // schema default. 3.0's visinfo.xsd changes this to
    // `<xs:attribute name="DefaultVisibility" type="xs:boolean" default="false"/>`.
    // Per XML Schema attribute defaulting, an omitted attribute with a
    // declared default takes that default value, so a spec-legal 3.0 file
    // that omits DefaultVisibility means "hide everything except the listed
    // exceptions" (false), while the same omission on a 2.1 file carries no
    // schema-mandated meaning.

    function buildArchive(versionId: '2.1' | '3.0'): Promise<Buffer | ArrayBuffer> {
      const topicGuid = '33333333-3333-3333-3333-333333333333';
      const vpGuid = '44444444-4444-4444-4444-444444444444';
      const zip = new JSZip();
      zip.file('bcf.version', `<?xml version="1.0"?><Version VersionId="${versionId}"/>`);
      zip.file(
        `${topicGuid}/markup.bcf`,
        `<?xml version="1.0" encoding="UTF-8"?>
<Markup>
  <Topic Guid="${topicGuid}" TopicType="Issue" TopicStatus="Open">
    <Title>Omitted DefaultVisibility</Title>
  </Topic>
  <Viewpoints Guid="${vpGuid}">
    <Viewpoint>viewpoint.bcfv</Viewpoint>
  </Viewpoints>
</Markup>`
      );
      zip.file(
        `${topicGuid}/viewpoint.bcfv`,
        `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${vpGuid}">
  <Components>
    <Visibility>
      <Exceptions>
        <Component IfcGuid="1RvVRIfDrAmhnJqDD6mvGD"/>
      </Exceptions>
    </Visibility>
  </Components>
</VisualizationInfo>`
      );
      return zip.generateAsync({ type: 'nodebuffer' });
    }

    it('reads a BCF 3.0 archive that omits DefaultVisibility as false (the schema-declared default)', async () => {
      const buffer = await buildArchive('3.0');
      const project = await readBCF(buffer);
      const topic = [...project.topics.values()][0];
      const visibility = topic.viewpoints[0].components?.visibility;

      expect(visibility).toBeDefined();
      expect(visibility?.defaultVisibility).toBe(false);
      expect(visibility?.exceptions).toHaveLength(1);
    });

    it('control: a BCF 2.1 archive with the same omission keeps the pre-existing true default', async () => {
      const buffer = await buildArchive('2.1');
      const project = await readBCF(buffer);
      const topic = [...project.topics.values()][0];
      const visibility = topic.viewpoints[0].components?.visibility;

      expect(visibility).toBeDefined();
      expect(visibility?.defaultVisibility).toBe(true);
      expect(visibility?.exceptions).toHaveLength(1);
    });

    it('reads the xs:boolean numeral form DefaultVisibility="0" as false, not inverted to true', async () => {
      // xs:boolean's lexical space is {true, false, 1, 0}, and its
      // whiteSpace facet is `collapse`, so a padded " 0 " is spec-valid
      // too. Comparing only against the literal 'false' read a
      // third-party file's DefaultVisibility="0" as TRUE — inverting the
      // viewpoint from "show only the exceptions" to "show everything".
      for (const rawValue of ['0', ' 0 ']) {
        const topicGuid = '55555555-5555-5555-5555-555555555555';
        const vpGuid = '66666666-6666-6666-6666-666666666666';
        const zip = new JSZip();
        zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"/>');
        zip.file(
          `${topicGuid}/markup.bcf`,
          `<?xml version="1.0" encoding="UTF-8"?>
<Markup>
  <Topic Guid="${topicGuid}" TopicType="Issue" TopicStatus="Open">
    <Title>Numeral xs:boolean</Title>
  </Topic>
  <Viewpoints Guid="${vpGuid}">
    <Viewpoint>viewpoint.bcfv</Viewpoint>
  </Viewpoints>
</Markup>`
        );
        zip.file(
          `${topicGuid}/viewpoint.bcfv`,
          `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${vpGuid}">
  <Components>
    <Visibility DefaultVisibility="${rawValue}">
      <Exceptions>
        <Component IfcGuid="1RvVRIfDrAmhnJqDD6mvGD"/>
      </Exceptions>
    </Visibility>
  </Components>
</VisualizationInfo>`
        );
        const buffer = await zip.generateAsync({ type: 'nodebuffer' });

        const project = await readBCF(buffer);
        const topic = [...project.topics.values()][0];
        const visibility = topic.viewpoints[0].components?.visibility;

        expect(visibility).toBeDefined();
        expect(visibility?.defaultVisibility).toBe(false);
        expect(visibility?.exceptions).toHaveLength(1);
      }
    });

    it('reads a whitespace-only DefaultVisibility as absent, falling back to the version default', async () => {
      // xs:boolean's lexical space is {true, false, 0, 1}; a whitespace-only
      // value collapses (whiteSpace=collapse) to the empty string, which is
      // not a member of that space at all -- the same as the attribute being
      // absent. `defaultVisMatch?.[1].trim()` produces '', and '' !== undefined
      // is true, so the reader fell into the explicit-value branch instead of
      // the version-default fallback, and '' !== 'false' && '' !== '0' both
      // held, so defaultVisibility came back true even for a 3.0 archive
      // whose schema-declared default is false.
      const topicGuid = '77777777-7777-7777-7777-777777777777';
      const vpGuid = '88888888-8888-8888-8888-888888888888';
      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="3.0"/>');
      zip.file(
        `${topicGuid}/markup.bcf`,
        `<?xml version="1.0" encoding="UTF-8"?>
<Markup>
  <Topic Guid="${topicGuid}" TopicType="Issue" TopicStatus="Open">
    <Title>Whitespace-only DefaultVisibility</Title>
  </Topic>
  <Viewpoints Guid="${vpGuid}">
    <Viewpoint>viewpoint.bcfv</Viewpoint>
  </Viewpoints>
</Markup>`
      );
      zip.file(
        `${topicGuid}/viewpoint.bcfv`,
        `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${vpGuid}">
  <Components>
    <Visibility DefaultVisibility="   ">
      <Exceptions>
        <Component IfcGuid="1RvVRIfDrAmhnJqDD6mvGD"/>
      </Exceptions>
    </Visibility>
  </Components>
</VisualizationInfo>`
      );
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      const project = await readBCF(buffer);
      const topic = [...project.topics.values()][0];
      const visibility = topic.viewpoints[0].components?.visibility;

      expect(visibility).toBeDefined();
      // BCF 3.0's schema-declared default (visinfo.xsd) is false.
      expect(visibility?.defaultVisibility).toBe(false);
      expect(visibility?.exceptions).toHaveLength(1);
    });

    it('control: an explicit false/0 DefaultVisibility still reads false', async () => {
      for (const rawValue of ['false', '0']) {
        const topicGuid = `9${rawValue === 'false' ? '1' : '2'}999999-9999-9999-9999-999999999999`;
        const vpGuid = `9${rawValue === 'false' ? '3' : '4'}999999-9999-9999-9999-999999999999`;
        const zip = new JSZip();
        zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="3.0"/>');
        zip.file(
          `${topicGuid}/markup.bcf`,
          `<?xml version="1.0" encoding="UTF-8"?>
<Markup>
  <Topic Guid="${topicGuid}" TopicType="Issue" TopicStatus="Open">
    <Title>Explicit false DefaultVisibility</Title>
  </Topic>
  <Viewpoints Guid="${vpGuid}">
    <Viewpoint>viewpoint.bcfv</Viewpoint>
  </Viewpoints>
</Markup>`
        );
        zip.file(
          `${topicGuid}/viewpoint.bcfv`,
          `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${vpGuid}">
  <Components>
    <Visibility DefaultVisibility="${rawValue}">
      <Exceptions>
        <Component IfcGuid="1RvVRIfDrAmhnJqDD6mvGD"/>
      </Exceptions>
    </Visibility>
  </Components>
</VisualizationInfo>`
        );
        const buffer = await zip.generateAsync({ type: 'nodebuffer' });

        const project = await readBCF(buffer);
        const topic = [...project.topics.values()][0];
        const visibility = topic.viewpoints[0].components?.visibility;

        expect(visibility).toBeDefined();
        expect(visibility?.defaultVisibility).toBe(false);
        expect(visibility?.exceptions).toHaveLength(1);
      }
    });
  });

  describe('CDATA in Topic Title and Comment text', () => {
    // extractElement's content regex is `[^<]*`, which rejects a CDATA
    // section outright (its opener is `<![CDATA[`). parseLabels was given a
    // CDATA-aware extractor in this PR, but Title and Comment still go
    // through plain extractElement, so a conformant CDATA-wrapped Title or
    // Comment silently falls back to 'Untitled' / '' with no warning.
    it('reads a CDATA-wrapped Title instead of falling back to Untitled', async () => {
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title><![CDATA[Fire & Smoke <Wall>]]></Title>',
        '  </Topic>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="3.0"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.title).toBe('Fire & Smoke <Wall>');
    });

    it('control: an ordinary (non-CDATA) Title still reads and entity-decodes', async () => {
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title>Fire &amp; Smoke</Title>',
        '  </Topic>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="3.0"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.title).toBe('Fire & Smoke');
    });

    it('reads a CDATA-wrapped Comment instead of falling back to empty string', async () => {
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title>t</Title>',
        '  </Topic>',
        '  <Comment Guid="comment-1">',
        '    <Date>2026-01-01T00:00:00Z</Date>',
        '    <Author>bob@example.com</Author>',
        '    <Comment><![CDATA[Needs REI 90 & a <review>]]></Comment>',
        '  </Comment>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="3.0"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.comments.length).toBe(1);
      expect(topic.comments[0].comment).toBe('Needs REI 90 & a <review>');
    });

    it('control: an ordinary (non-CDATA) Comment still reads and entity-decodes', async () => {
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title>t</Title>',
        '  </Topic>',
        '  <Comment Guid="comment-1">',
        '    <Date>2026-01-01T00:00:00Z</Date>',
        '    <Author>bob@example.com</Author>',
        '    <Comment>Needs REI 90 &amp; a &quot;review&quot;</Comment>',
        '  </Comment>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="3.0"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.comments.length).toBe(1);
      expect(topic.comments[0].comment).toBe('Needs REI 90 & a "review"');
    });
  });

  describe('DocumentReference isExternal (xs:boolean numeral form)', () => {
    // markup.xsd's DocumentReference isExternal attribute is xs:boolean
    // (2.1: `<xs:attribute name="isExternal" type="xs:boolean" default="false"/>`
    // in the DocumentReferenceAttributes group), whose lexical space is
    // {true, false, 1, 0}. extractDocumentReferences compared only against
    // the literal 'true', so a spec-legal isExternal="1" read back as
    // isExternal: false -- an externally-hosted document misreported as
    // living inside the BCF archive.
    it('reads DocumentReference isExternal="1" as true, not false', async () => {
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title>t</Title>',
        '    <DocumentReference Guid="doc-1" isExternal="1">',
        '      <ReferencedDocument>https://example.com/spec.pdf</ReferencedDocument>',
        '    </DocumentReference>',
        '  </Topic>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.documentReferences?.[0]?.isExternal).toBe(true);
    });

    it('reads DocumentReference isExternal="0" as false', async () => {
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title>t</Title>',
        '    <DocumentReference Guid="doc-1" isExternal="0">',
        '      <DocumentGuid>11111111-1111-1111-1111-111111111111</DocumentGuid>',
        '    </DocumentReference>',
        '  </Topic>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="3.0"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.documentReferences?.[0]?.isExternal).toBe(false);
    });

    it('control: an ordinary true/false DocumentReference isExternal still reads correctly', async () => {
      const markup = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<Markup>',
        '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
        '    <Title>t</Title>',
        '    <DocumentReference Guid="doc-1" isExternal="true">',
        '      <ReferencedDocument>https://example.com/spec.pdf</ReferencedDocument>',
        '    </DocumentReference>',
        '  </Topic>',
        '</Markup>',
      ].join('\n');

      const zip = new JSZip();
      zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
      zip.file('topic-1/markup.bcf', markup);
      const buffer = await zip.generateAsync({ type: 'arraybuffer' });

      const project = await readBCF(buffer);
      const topic = Array.from(project.topics.values())[0];
      expect(topic.documentReferences?.[0]?.isExternal).toBe(true);
    });
  });
});
