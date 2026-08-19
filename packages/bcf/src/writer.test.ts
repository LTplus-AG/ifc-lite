/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { writeBCF } from './writer.js';
import { readBCF } from './reader.js';
import type { BCFProject, BCFTopic, BCFViewpoint } from './types.js';
import { generateUuid } from '@ifc-lite/encoding';

// Helper to convert Blob to ArrayBuffer for Node.js environment
async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

describe('BCF Writer', () => {
  it('should create valid bcf.version file', async () => {
    const project: BCFProject = {
      version: '2.1',
      topics: new Map(),
    };

    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    const versionContent = await zip.file('bcf.version')?.async('string');
    expect(versionContent).toContain('VersionId="2.1"');
    expect(versionContent).toContain('<DetailedVersion>2.1</DetailedVersion>');
    expect(versionContent).toContain('xmlns:xsd');
  });

  it('should create project.bcfp file when project has name', async () => {
    const project: BCFProject = {
      version: '2.1',
      name: 'Test Project',
      projectId: 'test-project-id',
      topics: new Map(),
    };

    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    const projectContent = await zip.file('project.bcfp')?.async('string');
    expect(projectContent).toContain('Test Project');
    expect(projectContent).toContain('test-project-id');
  });

  it('should create topic folder with markup.bcf', async () => {
    const topicGuid = generateUuid();
    const topic: BCFTopic = {
      guid: topicGuid,
      title: 'Test Topic',
      creationDate: new Date().toISOString(),
      creationAuthor: 'test@example.com',
      viewpoints: [],
      comments: [],
    };

    const project: BCFProject = {
      version: '2.1',
      topics: new Map([[topicGuid, topic]]),
    };

    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    const markupContent = await zip.file(`${topicGuid}/markup.bcf`)?.async('string');
    expect(markupContent).toContain('Test Topic');
    expect(markupContent).toContain(`Guid="${topicGuid}"`);
  });

  it('should use consistent filenames between markup and viewpoint files', async () => {
    const topicGuid = generateUuid();
    const viewpointGuid = generateUuid();

    const viewpoint: BCFViewpoint = {
      guid: viewpointGuid,
      perspectiveCamera: {
        cameraViewPoint: { x: 0, y: 0, z: 10 },
        cameraDirection: { x: 0, y: 0, z: -1 },
        cameraUpVector: { x: 0, y: 1, z: 0 },
        fieldOfView: 60,
      },
    };

    const topic: BCFTopic = {
      guid: topicGuid,
      title: 'Viewpoint Test',
      creationDate: new Date().toISOString(),
      creationAuthor: 'test@example.com',
      viewpoints: [viewpoint],
      comments: [],
    };

    const project: BCFProject = {
      version: '2.1',
      topics: new Map([[topicGuid, topic]]),
    };

    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    // Check markup references
    const markupContent = await zip.file(`${topicGuid}/markup.bcf`)?.async('string');
    expect(markupContent).toContain(`<Viewpoint>Viewpoint_${viewpointGuid}.bcfv</Viewpoint>`);

    // Check actual viewpoint file exists with same name
    const viewpointFile = zip.file(`${topicGuid}/Viewpoint_${viewpointGuid}.bcfv`);
    expect(viewpointFile).not.toBeNull();

    const viewpointContent = await viewpointFile?.async('string');
    expect(viewpointContent).toContain(`Guid="${viewpointGuid}"`);
    expect(viewpointContent).toContain('PerspectiveCamera');
  });

  it('should use consistent snapshot filenames', async () => {
    const topicGuid = generateUuid();
    const viewpointGuid = generateUuid();

    const viewpoint: BCFViewpoint = {
      guid: viewpointGuid,
      perspectiveCamera: {
        cameraViewPoint: { x: 0, y: 0, z: 10 },
        cameraDirection: { x: 0, y: 0, z: -1 },
        cameraUpVector: { x: 0, y: 1, z: 0 },
        fieldOfView: 60,
      },
      // Minimal PNG data (1x1 pixel)
      snapshotData: new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]),
    };

    const topic: BCFTopic = {
      guid: topicGuid,
      title: 'Snapshot Test',
      creationDate: new Date().toISOString(),
      creationAuthor: 'test@example.com',
      viewpoints: [viewpoint],
      comments: [],
    };

    const project: BCFProject = {
      version: '2.1',
      topics: new Map([[topicGuid, topic]]),
    };

    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    // Check markup references snapshot with correct name
    const markupContent = await zip.file(`${topicGuid}/markup.bcf`)?.async('string');
    expect(markupContent).toContain(`<Snapshot>Snapshot_${viewpointGuid}.png</Snapshot>`);

    // Check actual snapshot file exists with same name
    const snapshotFile = zip.file(`${topicGuid}/Snapshot_${viewpointGuid}.png`);
    expect(snapshotFile).not.toBeNull();
  });

  it('should handle multiple viewpoints with unique filenames', async () => {
    const topicGuid = generateUuid();
    const viewpoint1Guid = generateUuid();
    const viewpoint2Guid = generateUuid();

    const viewpoint1: BCFViewpoint = {
      guid: viewpoint1Guid,
      perspectiveCamera: {
        cameraViewPoint: { x: 0, y: 0, z: 10 },
        cameraDirection: { x: 0, y: 0, z: -1 },
        cameraUpVector: { x: 0, y: 1, z: 0 },
        fieldOfView: 60,
      },
    };

    const viewpoint2: BCFViewpoint = {
      guid: viewpoint2Guid,
      perspectiveCamera: {
        cameraViewPoint: { x: 10, y: 0, z: 0 },
        cameraDirection: { x: -1, y: 0, z: 0 },
        cameraUpVector: { x: 0, y: 1, z: 0 },
        fieldOfView: 45,
      },
    };

    const topic: BCFTopic = {
      guid: topicGuid,
      title: 'Multiple Viewpoints',
      creationDate: new Date().toISOString(),
      creationAuthor: 'test@example.com',
      viewpoints: [viewpoint1, viewpoint2],
      comments: [],
    };

    const project: BCFProject = {
      version: '2.1',
      topics: new Map([[topicGuid, topic]]),
    };

    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    // Check both viewpoints exist
    expect(zip.file(`${topicGuid}/Viewpoint_${viewpoint1Guid}.bcfv`)).not.toBeNull();
    expect(zip.file(`${topicGuid}/Viewpoint_${viewpoint2Guid}.bcfv`)).not.toBeNull();

    // Check markup references both
    const markupContent = await zip.file(`${topicGuid}/markup.bcf`)?.async('string');
    expect(markupContent).toContain(`<Viewpoint>Viewpoint_${viewpoint1Guid}.bcfv</Viewpoint>`);
    expect(markupContent).toContain(`<Viewpoint>Viewpoint_${viewpoint2Guid}.bcfv</Viewpoint>`);
  });

  it('should write components in BCF 2.1 schema order', async () => {
    const topicGuid = generateUuid();
    const viewpointGuid = generateUuid();

    // Create viewpoint with selection, visibility, and coloring
    const viewpoint: BCFViewpoint = {
      guid: viewpointGuid,
      perspectiveCamera: {
        cameraViewPoint: { x: 0, y: 0, z: 10 },
        cameraDirection: { x: 0, y: 0, z: -1 },
        cameraUpVector: { x: 0, y: 1, z: 0 },
        fieldOfView: 60,
      },
      components: {
        selection: [{ ifcGuid: '0abc123def456789012345' }],
        visibility: {
          defaultVisibility: true,
          exceptions: [{ ifcGuid: '1abc123def456789012345' }],
        },
      },
    };

    const topic: BCFTopic = {
      guid: topicGuid,
      title: 'Components Test',
      creationDate: new Date().toISOString(),
      creationAuthor: 'test@example.com',
      viewpoints: [viewpoint],
      comments: [],
    };

    const project: BCFProject = {
      version: '2.1',
      topics: new Map([[topicGuid, topic]]),
    };

    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    const viewpointContent = await zip.file(`${topicGuid}/Viewpoint_${viewpointGuid}.bcfv`)?.async('string');
    expect(viewpointContent).toBeDefined();

    // BCF 2.1 schema requires: Selection BEFORE Visibility
    const selectionIndex = viewpointContent!.indexOf('<Selection>');
    const visibilityIndex = viewpointContent!.indexOf('<Visibility');
    expect(selectionIndex).toBeGreaterThan(-1);
    expect(visibilityIndex).toBeGreaterThan(-1);
    expect(selectionIndex).toBeLessThan(visibilityIndex); // Selection must come first!

    // Visibility must have DefaultVisibility attribute
    expect(viewpointContent).toContain('DefaultVisibility="true"');

    // Component IfcGuid must be an attribute (not element)
    expect(viewpointContent).toContain('IfcGuid="0abc123def456789012345"');
    expect(viewpointContent).toContain('IfcGuid="1abc123def456789012345"');
  });

  it('should roundtrip through reader', async () => {
    const topicGuid = generateUuid();
    const viewpointGuid = generateUuid();

    const viewpoint: BCFViewpoint = {
      guid: viewpointGuid,
      perspectiveCamera: {
        cameraViewPoint: { x: 1, y: 2, z: 3 },
        cameraDirection: { x: 0.5, y: 0.5, z: -0.707 },
        cameraUpVector: { x: 0, y: 1, z: 0 },
        fieldOfView: 60,
      },
    };

    const topic: BCFTopic = {
      guid: topicGuid,
      title: 'Roundtrip Test',
      description: 'Testing roundtrip',
      creationDate: new Date().toISOString(),
      creationAuthor: 'test@example.com',
      topicType: 'Issue',
      topicStatus: 'Open',
      viewpoints: [viewpoint],
      comments: [],
    };

    const project: BCFProject = {
      version: '2.1',
      name: 'Roundtrip Project',
      topics: new Map([[topicGuid, topic]]),
    };

    // Write
    const blob = await writeBCF(project);

    // Read back
    const arrayBuffer = await blob.arrayBuffer();
    const readProject = await readBCF(arrayBuffer);

    // Verify
    expect(readProject.version).toBe('2.1');
    expect(readProject.topics.size).toBe(1);

    const readTopic = readProject.topics.get(topicGuid);
    expect(readTopic).toBeDefined();
    expect(readTopic?.title).toBe('Roundtrip Test');
    expect(readTopic?.viewpoints.length).toBe(1);

    const readViewpoint = readTopic?.viewpoints[0];
    expect(readViewpoint?.guid).toBe(viewpointGuid);
    expect(readViewpoint?.perspectiveCamera).toBeDefined();
    expect(readViewpoint?.perspectiveCamera?.fieldOfView).toBe(60);
  });

  // Regression: writer.escapeXml() and reader.extractElement() must be inverses.
  // Before the fix, extractElement() used a plain "grab text between tags" regex
  // with no entity unescaping, so a title of `A & B` came back as the literal
  // string "A &amp; B" instead of "A & B".
  it('should roundtrip XML special characters in title, description, and comment (escapeXml/unescapeXml)', async () => {
    const topicGuid = generateUuid();
    const commentGuid = generateUuid();
    const nasty = `A & B <C> "quoted" 'apos' end`;

    const topic: BCFTopic = {
      guid: topicGuid,
      title: nasty,
      description: nasty,
      creationDate: new Date().toISOString(),
      creationAuthor: 'test@example.com',
      viewpoints: [],
      comments: [
        {
          guid: commentGuid,
          date: new Date().toISOString(),
          author: 'test@example.com',
          comment: nasty,
        },
      ],
    };

    const project: BCFProject = {
      version: '2.1',
      topics: new Map([[topicGuid, topic]]),
    };

    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    // The emitted XML must be well-formed: the raw special characters must not
    // appear unescaped inside element text (only inside their escaped forms).
    const markupContent = await zip.file(`${topicGuid}/markup.bcf`)?.async('string');
    expect(markupContent).toBeDefined();
    const titleMatch = markupContent!.match(/<Title>([\s\S]*?)<\/Title>/);
    expect(titleMatch?.[1]).toBe('A &amp; B &lt;C&gt; &quot;quoted&quot; &apos;apos&apos; end');
    // No raw '<' or '>' from the payload leaked in as unescaped markup delimiters.
    expect(titleMatch?.[1]).not.toContain('<C>');

    const readProject = await readBCF(await blob.arrayBuffer());
    const readTopic = readProject.topics.get(topicGuid);

    expect(readTopic?.title).toBe(nasty);
    expect(readTopic?.description).toBe(nasty);
    expect(readTopic?.comments[0]?.comment).toBe(nasty);
  });

  it('should roundtrip Lines, ClippingPlanes, Bitmaps, BimSnippet, and DocumentReferences', async () => {
    const topicGuid = generateUuid();
    const viewpointGuid = generateUuid();

    const viewpoint: BCFViewpoint = {
      guid: viewpointGuid,
      lines: [
        {
          startPoint: { x: 0, y: 0, z: 0 },
          endPoint: { x: 1, y: 2, z: 3 },
        },
      ],
      clippingPlanes: [
        {
          location: { x: 0, y: 0, z: 1.5 },
          direction: { x: 0, y: 0, z: -1 },
        },
      ],
      bitmaps: [
        {
          format: 'PNG',
          reference: 'bitmap1.png',
          location: { x: 1, y: 1, z: 1 },
          normal: { x: 0, y: 0, z: 1 },
          up: { x: 0, y: 1, z: 0 },
          height: 2.5,
        },
      ],
    };

    const topic: BCFTopic = {
      guid: topicGuid,
      title: 'Markup elements test',
      creationDate: new Date().toISOString(),
      creationAuthor: 'test@example.com',
      viewpoints: [viewpoint],
      comments: [],
      bimSnippet: {
        snippetType: 'IFC',
        isExternal: true,
        reference: 'https://example.com/snippet.ifc',
        referenceSchema: 'https://example.com/schema.xsd',
      },
      documentReferences: [
        {
          guid: generateUuid(),
          isExternal: true,
          referencedDocument: 'https://example.com/spec.pdf',
          description: 'Spec & Requirements',
        },
      ],
    };

    const project: BCFProject = {
      version: '2.1',
      topics: new Map([[topicGuid, topic]]),
    };

    const blob = await writeBCF(project);
    const readProject = await readBCF(await blob.arrayBuffer());
    const readTopic = readProject.topics.get(topicGuid);
    expect(readTopic).toBeDefined();

    // Lines
    const readViewpoint = readTopic!.viewpoints[0];
    expect(readViewpoint.lines).toHaveLength(1);
    expect(readViewpoint.lines?.[0]).toEqual({
      startPoint: { x: 0, y: 0, z: 0 },
      endPoint: { x: 1, y: 2, z: 3 },
    });

    // ClippingPlanes
    expect(readViewpoint.clippingPlanes).toHaveLength(1);
    expect(readViewpoint.clippingPlanes?.[0]).toEqual({
      location: { x: 0, y: 0, z: 1.5 },
      direction: { x: 0, y: 0, z: -1 },
    });

    // Bitmaps
    expect(readViewpoint.bitmaps).toHaveLength(1);
    expect(readViewpoint.bitmaps?.[0]).toMatchObject({
      format: 'PNG',
      reference: 'bitmap1.png',
      location: { x: 1, y: 1, z: 1 },
      normal: { x: 0, y: 0, z: 1 },
      up: { x: 0, y: 1, z: 0 },
      height: 2.5,
    });

    // BimSnippet
    expect(readTopic!.bimSnippet).toEqual({
      snippetType: 'IFC',
      isExternal: true,
      reference: 'https://example.com/snippet.ifc',
      referenceSchema: 'https://example.com/schema.xsd',
    });

    // DocumentReferences
    expect(readTopic!.documentReferences).toHaveLength(1);
    expect(readTopic!.documentReferences?.[0]).toMatchObject({
      isExternal: true,
      referencedDocument: 'https://example.com/spec.pdf',
      description: 'Spec & Requirements',
    });
  });

  // Federation provenance (#1591): a topic that spans multiple models must
  // round-trip one <Header><File> per source model so the topic re-anchors to
  // every model it touches, for BCF 2.1 and 3.0.
  it.each(['2.1', '3.0'] as const)(
    'should roundtrip header source files (BCF %s)',
    async (version) => {
      const topicGuid = generateUuid();
      const topic: BCFTopic = {
        guid: topicGuid,
        title: 'Federated topic',
        creationDate: '2026-07-04T00:00:00.000Z',
        creationAuthor: 'test@example.com',
        viewpoints: [],
        comments: [],
        header: [
          {
            ifcProject: '0YvCT2_$X3_xJG3rzD8L_8',
            isExternal: true,
            filename: 'architecture.ifc',
            date: '2026-07-01T10:00:00.000Z',
            reference: 'architecture.ifc',
          },
          {
            ifcProject: '3aB9cd_ef2Gh1Ij4Kl5Mn6',
            isExternal: false,
            filename: 'structure.ifc',
            date: '2026-07-02T11:30:00.000Z',
            reference: 'structure.ifc',
          },
        ],
      };

      const project: BCFProject = {
        version,
        topics: new Map([[topicGuid, topic]]),
      };

      const blob = await writeBCF(project);
      const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
      const markupContent = await zip.file(`${topicGuid}/markup.bcf`)?.async('string');
      expect(markupContent).toBeDefined();

      // Version-specific container: 3.0 wraps <File> in <Files>, 2.1 does not.
      if (version === '3.0') {
        expect(markupContent).toContain('<Files>');
      } else {
        expect(markupContent).not.toContain('<Files>');
      }
      // Header must precede Topic per the markup schema sequence.
      expect(markupContent!.indexOf('<Header>')).toBeLessThan(markupContent!.indexOf('<Topic'));

      const readProject = await readBCF(await blob.arrayBuffer());
      const readTopic = readProject.topics.get(topicGuid);
      expect(readTopic?.header).toHaveLength(2);
      expect(readTopic?.header?.[0]).toEqual({
        ifcProject: '0YvCT2_$X3_xJG3rzD8L_8',
        ifcSpatialStructureElement: undefined,
        isExternal: true,
        filename: 'architecture.ifc',
        date: '2026-07-01T10:00:00.000Z',
        reference: 'architecture.ifc',
      });
      expect(readTopic?.header?.[1]).toMatchObject({
        ifcProject: '3aB9cd_ef2Gh1Ij4Kl5Mn6',
        isExternal: false,
        filename: 'structure.ifc',
      });
    },
  );

  it('should not emit a Header element for topics without source files', async () => {
    const topicGuid = generateUuid();
    const topic: BCFTopic = {
      guid: topicGuid,
      title: 'No header',
      creationDate: new Date().toISOString(),
      creationAuthor: 'test@example.com',
      viewpoints: [],
      comments: [],
    };
    const project: BCFProject = {
      version: '2.1',
      topics: new Map([[topicGuid, topic]]),
    };

    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
    const markupContent = await zip.file(`${topicGuid}/markup.bcf`)?.async('string');
    expect(markupContent).not.toContain('<Header>');

    const readProject = await readBCF(await blob.arrayBuffer());
    expect(readProject.topics.get(topicGuid)?.header).toBeUndefined();
  });

  it('sanitizes a path-traversal topic GUID so no zip entry escapes the archive root (zip-slip)', async () => {
    // A topic GUID parsed from untrusted markup can contain `../`; using it as a
    // folder name verbatim would let a read-modify-save write outside the archive.
    const evilGuid = '../../evil';
    const topic: BCFTopic = {
      guid: evilGuid,
      title: 'Malicious Topic',
      creationDate: new Date().toISOString(),
      creationAuthor: 'attacker@example.com',
      viewpoints: [],
      comments: [],
    };
    const project: BCFProject = {
      version: '2.1',
      topics: new Map([[evilGuid, topic]]),
    };

    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    const paths: string[] = [];
    zip.forEach((relativePath) => paths.push(relativePath));

    // No entry may contain a parent-directory traversal segment.
    for (const p of paths) {
      expect(p.split('/')).not.toContain('..');
      expect(p.startsWith('/')).toBe(false);
    }
    // The real GUID is still preserved as the markup Topic attribute.
    const markupPath = paths.find((p) => p.endsWith('markup.bcf'));
    expect(markupPath).toBeDefined();
    const markup = await zip.file(markupPath!)?.async('string');
    expect(markup).toContain(`Guid="${evilGuid}"`);
  });

  it('sanitizes a path-traversal viewpoint GUID so no zip entry escapes the archive root (zip-slip), and markup agrees with the entry name', async () => {
    // A viewpoint GUID is parsed unvalidated from untrusted markup XML on read
    // (reader.ts parseViewpointContent), so it can carry the same `../` hazard
    // as a topic GUID. Using it verbatim in `Viewpoint_${guid}.bcfv` would let
    // a crafted GUID write outside the archive root on a read-modify-save.
    const evilGuid = '../../evil';
    const topic: BCFTopic = {
      guid: generateUuid(),
      title: 'Topic with malicious viewpoint',
      creationDate: new Date().toISOString(),
      creationAuthor: 'attacker@example.com',
      viewpoints: [
        {
          guid: evilGuid,
        } as BCFViewpoint,
      ],
      comments: [],
    };
    const project: BCFProject = {
      version: '2.1',
      topics: new Map([[topic.guid, topic]]),
    };

    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    const paths: string[] = [];
    zip.forEach((relativePath) => paths.push(relativePath));

    // No entry may contain a parent-directory traversal segment, and none may
    // be an absolute path.
    for (const p of paths) {
      expect(p.split('/')).not.toContain('..');
      expect(p.startsWith('/')).toBe(false);
    }

    // The markup's <Viewpoint>filename</Viewpoint> reference must name an
    // entry that actually exists in the archive (writer computes the sanitized
    // name once and reuses it in both places -- they must not diverge).
    const markupPath = paths.find((p) => p.endsWith('markup.bcf'));
    expect(markupPath).toBeDefined();
    const markup = await zip.file(markupPath!)?.async('string');
    expect(markup).toContain(`Guid="${evilGuid}"`);

    const viewpointFilenameMatch = markup?.match(/<Viewpoint>([^<]+)<\/Viewpoint>/);
    expect(viewpointFilenameMatch).toBeTruthy();
    const referencedFilename = viewpointFilenameMatch![1];

    // The referenced filename must not itself carry a traversal segment...
    expect(referencedFilename).not.toContain('..');
    expect(referencedFilename).not.toContain('/');

    // ...and the archive must actually contain an entry under this topic's
    // folder with that exact filename (markup reference and zip entry agree).
    const topicFolder = markupPath!.slice(0, markupPath!.length - 'markup.bcf'.length);
    const viewpointEntry = zip.file(`${topicFolder}${referencedFilename}`);
    expect(viewpointEntry).not.toBeNull();
  });

  it('keeps distinct GUIDs that sanitize identically in distinct folders (no silent overwrite)', async () => {
    // 'a?b' and 'a:b' both sanitize to 'a_b'; without disambiguation the
    // second topic folder would overwrite the first inside the archive.
    const makeTopic = (guid: string, title: string): BCFTopic => ({
      guid,
      title,
      creationDate: new Date().toISOString(),
      creationAuthor: 'author@example.com',
      viewpoints: [],
      comments: [],
    });
    const guids = ['a?b', 'a:b', 'a_b', '../../evil', '..\\..\\evil'];
    const project: BCFProject = {
      version: '2.1',
      topics: new Map(guids.map((g, i) => [g, makeTopic(g, `Topic ${i}`)])),
    };

    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));

    const markupPaths: string[] = [];
    zip.forEach((relativePath) => {
      if (relativePath.endsWith('markup.bcf')) markupPaths.push(relativePath);
      expect(relativePath.split('/')).not.toContain('..');
    });
    // One folder per topic: no collision collapsed two topics into one.
    expect(markupPaths).toHaveLength(guids.length);

    // Round-trip: every original GUID survives as its own topic.
    const readProject = await readBCF(await blob.arrayBuffer());
    expect([...readProject.topics.keys()].sort()).toEqual([...guids].sort());
    for (const g of guids) {
      expect(readProject.topics.get(g)?.guid).toBe(g);
    }
  });

  // --------------------------------------------------------------------------
  // Fields that a BCF consumer reads but that no fixture pinned. Each of these
  // survived a mutation of the writer: the file stayed readable, so nothing on
  // our side errored — the receiving tool just got the wrong answer.
  // --------------------------------------------------------------------------

  /** Wrap a single topic in a minimal project and return its markup.bcf text. */
  async function markupFor(topic: BCFTopic, version: '2.1' | '3.0' = '2.1'): Promise<string> {
    const project: BCFProject = { version, topics: new Map([[topic.guid, topic]]) };
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(await writeBCF(project)));
    const content = await zip.file(`${topic.guid}/markup.bcf`)?.async('string');
    expect(content).toBeDefined();
    return content!;
  }

  function baseTopic(overrides: Partial<BCFTopic> = {}): BCFTopic {
    return {
      guid: generateUuid(),
      title: 'T',
      creationDate: '2026-01-01T00:00:00.000Z',
      creationAuthor: 'creator@example.com',
      viewpoints: [],
      comments: [],
      ...overrides,
    };
  }

  it('defaults DefaultVisibility to true when a viewpoint has components but no visibility', async () => {
    // Visibility is REQUIRED inside Components, so the writer synthesises one.
    // Emitting false instead of true would tell the receiving tool to hide the
    // entire model and show only the selection.
    const vp: BCFViewpoint = {
      guid: generateUuid(),
      components: { selection: [{ ifcGuid: '0abc123def456789012345' }] },
    };
    const topic = baseTopic({ viewpoints: [vp] });
    const project: BCFProject = { version: '2.1', topics: new Map([[topic.guid, topic]]) };
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(await writeBCF(project)));
    const content = await zip.file(`${topic.guid}/Viewpoint_${vp.guid}.bcfv`)?.async('string');

    expect(content).toContain('DefaultVisibility="true"');
    expect(content).not.toContain('DefaultVisibility="false"');
  });

  it('writes DefaultVisibility="false" when isolation is explicitly requested', async () => {
    // The other half of the two-valued signal: an explicit false must survive the
    // `?? true` default rather than being coerced back to true.
    const vp: BCFViewpoint = {
      guid: generateUuid(),
      components: {
        visibility: { defaultVisibility: false, exceptions: [{ ifcGuid: '1abc123def456789012345' }] },
      },
    };
    const topic = baseTopic({ viewpoints: [vp] });
    const project: BCFProject = { version: '2.1', topics: new Map([[topic.guid, topic]]) };
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(await writeBCF(project)));
    const content = await zip.file(`${topic.guid}/Viewpoint_${vp.guid}.bcfv`)?.async('string');

    expect(content).toContain('DefaultVisibility="false"');
  });

  it('round-trips both visibility modes so isolation is not inverted on read', async () => {
    // Reader side: DefaultVisibility is parsed as `!== 'false'`. Inverting that
    // comparison silently turns an isolation viewpoint into a hide-list and vice
    // versa — the viewer then shows exactly the elements it should have hidden.
    const isolate: BCFViewpoint = {
      guid: generateUuid(),
      components: { visibility: { defaultVisibility: false, exceptions: [{ ifcGuid: 'ISOLATED0000000000000a' }] } },
    };
    const hide: BCFViewpoint = {
      guid: generateUuid(),
      components: { visibility: { defaultVisibility: true, exceptions: [{ ifcGuid: 'HIDDEN00000000000000ab' }] } },
    };
    const topic = baseTopic({ viewpoints: [isolate, hide] });
    const project: BCFProject = { version: '2.1', topics: new Map([[topic.guid, topic]]) };

    const readProject = await readBCF(await (await writeBCF(project)).arrayBuffer());
    const readVps = readProject.topics.get(topic.guid)!.viewpoints;
    const readIsolate = readVps.find((v) => v.guid === isolate.guid)!;
    const readHide = readVps.find((v) => v.guid === hide.guid)!;

    expect(readIsolate.components?.visibility?.defaultVisibility).toBe(false);
    expect(readIsolate.components?.visibility?.exceptions?.[0].ifcGuid).toBe('ISOLATED0000000000000a');
    expect(readHide.components?.visibility?.defaultVisibility).toBe(true);
    expect(readHide.components?.visibility?.exceptions?.[0].ifcGuid).toBe('HIDDEN00000000000000ab');
  });

  it('names a JPEG snapshot .jpg and a PNG snapshot .png, consistently in markup and archive', async () => {
    // The extension is derived from the snapshot data-URL prefix. Hard-coding
    // 'png' still produces a readable archive, but the entry then advertises PNG
    // while carrying JPEG bytes — a consumer that trusts the extension misdecodes.
    const jpegVp: BCFViewpoint = {
      guid: generateUuid(),
      // 'AAAA' is valid base64, so the data-URL branch writes real bytes.
      snapshot: 'data:image/jpeg;base64,AAAA',
    };
    const pngVp: BCFViewpoint = { guid: generateUuid(), snapshot: 'data:image/png;base64,AAAA' };
    const topic = baseTopic({ viewpoints: [jpegVp, pngVp] });
    const project: BCFProject = { version: '2.1', topics: new Map([[topic.guid, topic]]) };
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(await writeBCF(project)));
    const markup = await zip.file(`${topic.guid}/markup.bcf`)?.async('string');

    expect(markup).toContain(`<Snapshot>Snapshot_${jpegVp.guid}.jpg</Snapshot>`);
    expect(markup).toContain(`<Snapshot>Snapshot_${pngVp.guid}.png</Snapshot>`);
    // The referenced entries must actually exist under those names.
    expect(zip.file(`${topic.guid}/Snapshot_${jpegVp.guid}.jpg`)).not.toBeNull();
    expect(zip.file(`${topic.guid}/Snapshot_${pngVp.guid}.png`)).not.toBeNull();
  });

  it('falls back to CreationAuthor for ModifiedAuthor, which the schema requires alongside ModifiedDate', async () => {
    // ModifiedAuthor is mandatory once ModifiedDate is present. Writing an empty
    // element instead of the fallback yields schema-invalid markup that a
    // validating consumer rejects outright.
    const noAuthor = await markupFor(baseTopic({ modifiedDate: '2026-02-02T00:00:00.000Z' }));
    expect(noAuthor).toContain('<ModifiedAuthor>creator@example.com</ModifiedAuthor>');

    // An explicit modifiedAuthor must win over the fallback.
    const withAuthor = await markupFor(
      baseTopic({ modifiedDate: '2026-02-02T00:00:00.000Z', modifiedAuthor: 'editor@example.com' }),
    );
    expect(withAuthor).toContain('<ModifiedAuthor>editor@example.com</ModifiedAuthor>');
    expect(withAuthor).not.toContain('creator@example.com</ModifiedAuthor>');
  });

  it('omits a BimSnippet that is missing the schema-required ReferenceSchema', async () => {
    // ReferenceSchema is required inside BimSnippet; emitting the snippet without
    // it would produce markup that fails XSD validation.
    const incomplete = await markupFor(
      baseTopic({ bimSnippet: { snippetType: 'IFC', isExternal: true, reference: 'a.ifc' } }),
    );
    expect(incomplete).not.toContain('<BimSnippet');

    // A complete snippet is still emitted — the guard must not drop everything.
    const complete = await markupFor(
      baseTopic({
        bimSnippet: {
          snippetType: 'IFC',
          isExternal: true,
          reference: 'a.ifc',
          referenceSchema: 'https://example.com/schema.xsd',
        },
      }),
    );
    expect(complete).toContain('<BimSnippet SnippetType="IFC"');
    expect(complete).toContain('<ReferenceSchema>https://example.com/schema.xsd</ReferenceSchema>');
  });

  it('writes ViewSetupHints with the spec attribute names, only for the hints that are set', async () => {
    const vp: BCFViewpoint = {
      guid: generateUuid(),
      components: {
        visibility: {
          defaultVisibility: true,
          viewSetupHints: { spacesVisible: true, spaceBoundariesVisible: false },
        },
      },
    };
    const topic = baseTopic({ viewpoints: [vp] });
    const project: BCFProject = { version: '2.1', topics: new Map([[topic.guid, topic]]) };
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(await writeBCF(project)));
    const content = await zip.file(`${topic.guid}/Viewpoint_${vp.guid}.bcfv`)?.async('string');

    // Exact spec spellings — a typo'd attribute is silently ignored by consumers.
    expect(content).toContain('SpacesVisible="true"');
    expect(content).toContain('SpaceBoundariesVisible="false"');
    // An unset hint must be omitted, not emitted as "undefined".
    expect(content).not.toContain('OpeningsVisible');
    // ViewSetupHints belongs at Components level, before Selection/Visibility.
    expect(content!.indexOf('<ViewSetupHints')).toBeLessThan(content!.indexOf('<Visibility'));
  });

  it('round-trips Coloring with the spec Color attribute name', async () => {
    // The coloring write path had no fixture at all; renaming the `Color`
    // attribute produced an archive that reads back with no coloring at all.
    const vp: BCFViewpoint = {
      guid: generateUuid(),
      components: {
        visibility: { defaultVisibility: true },
        coloring: [{ color: 'FFFF0000', components: [{ ifcGuid: 'REDELEMENT00000000000a' }] }],
      },
    };
    const topic = baseTopic({ viewpoints: [vp] });
    const project: BCFProject = { version: '2.1', topics: new Map([[topic.guid, topic]]) };
    const blob = await writeBCF(project);
    const zip = await JSZip.loadAsync(await blobToArrayBuffer(blob));
    const content = await zip.file(`${topic.guid}/Viewpoint_${vp.guid}.bcfv`)?.async('string');
    expect(content).toContain('<Color Color="FFFF0000">');

    const readVp = (await readBCF(await blob.arrayBuffer())).topics.get(topic.guid)!.viewpoints[0];
    expect(readVp.components?.coloring).toEqual([
      { color: 'FFFF0000', components: [{ ifcGuid: 'REDELEMENT00000000000a', authoringToolId: undefined, originatingSystem: undefined }] },
    ]);
  });

  it('round-trips a JPG bitmap format rather than collapsing every bitmap to PNG', async () => {
    // The reader normalises Format to JPG|PNG. Collapsing to PNG unconditionally
    // stayed green because the only bitmap fixture was already a PNG.
    const vp: BCFViewpoint = {
      guid: generateUuid(),
      bitmaps: [
        {
          format: 'JPG',
          reference: 'b.jpg',
          location: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
          up: { x: 0, y: 1, z: 0 },
          height: 1,
        },
      ],
    };
    const topic = baseTopic({ viewpoints: [vp] });
    const project: BCFProject = { version: '2.1', topics: new Map([[topic.guid, topic]]) };

    const readVp = (await readBCF(await (await writeBCF(project)).arrayBuffer()))
      .topics.get(topic.guid)!.viewpoints[0];
    expect(readVp.bitmaps?.[0].format).toBe('JPG');
  });

  it('folder disambiguation is deterministic across writes of the same project', async () => {
    const makeTopic = (guid: string): BCFTopic => ({
      guid,
      title: 'T',
      creationDate: '2026-01-01T00:00:00Z',
      creationAuthor: 'a@example.com',
      viewpoints: [],
      comments: [],
    });
    const project: BCFProject = {
      version: '2.1',
      topics: new Map([['x?y', makeTopic('x?y')], ['x:y', makeTopic('x:y')]]),
    };
    const paths = async (): Promise<string[]> => {
      const zip = await JSZip.loadAsync(await blobToArrayBuffer(await writeBCF(project)));
      const out: string[] = [];
      zip.forEach((p) => out.push(p));
      return out.sort();
    };
    expect(await paths()).toEqual(await paths());
  });

  it('writes BimSnippet IsExternal with BCF 3.0 casing, and round-trips it back to true', async () => {
    // BCF 2.1 spells the attribute `isExternal`; 3.0 renamed it `IsExternal`
    // (buildingSMART/BCF-XML markup.xsd). Writing lowercase at version 3.0
    // produces schema-invalid markup, and a reader that only recognizes
    // lowercase would silently read a spec-correct 3.0 file's flag as false.
    const topic = baseTopic({
      bimSnippet: {
        snippetType: 'IFC',
        isExternal: true,
        reference: 'a.ifc',
        referenceSchema: 'https://example.com/schema.xsd',
      },
    });

    const markup30 = await markupFor(topic, '3.0');
    expect(markup30).toContain('IsExternal="true"');
    expect(markup30).not.toContain(' isExternal="true"');

    const project: BCFProject = { version: '3.0', topics: new Map([[topic.guid, topic]]) };
    const readTopic = (await readBCF(await (await writeBCF(project)).arrayBuffer()))
      .topics.get(topic.guid)!;
    expect(readTopic.bimSnippet?.isExternal).toBe(true);
  });

  it('reads a genuine BCF 3.0 BimSnippet (IsExternal, capital I) authored by a third-party tool', async () => {
    // Not a round trip through our own writer: this is the shape a spec-correct
    // external BCF 3.0 tool actually emits, straight into our reader.
    const zip = new JSZip();
    zip.file('bcf.version', '<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="3.0"></Version>');
    zip.folder('t1')!.file(
      'markup.bcf',
      `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Topic Guid="t1">
    <Title>Vendor topic</Title>
    <CreationDate>2026-01-01T00:00:00Z</CreationDate>
    <CreationAuthor>vendor@example.com</CreationAuthor>
    <BimSnippet SnippetType="IFC" IsExternal="true">
      <Reference>ref.ifc</Reference>
      <ReferenceSchema>ifcXML</ReferenceSchema>
    </BimSnippet>
  </Topic>
</Markup>`,
    );
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const readProject = await readBCF(bytes);
    expect(readProject.topics.get('t1')?.bimSnippet?.isExternal).toBe(true);
  });

  it('writes and round-trips a BCF 3.0 DocumentReference as DocumentGuid/Url, not the 2.1 shape', async () => {
    // BCF 3.0 replaced <ReferencedDocument>+isExternal with <DocumentGuid> (an
    // internal reference into project.bcfp's Documents) or <Url> (external),
    // and dropped isExternal. Writing the 2.1 shape at version 3.0 is
    // schema-invalid; a strict 3.0 consumer would reject the archive.
    const topic = baseTopic({
      documentReferences: [
        { guid: generateUuid(), url: 'https://example.com/spec.pdf', description: 'Spec' },
      ],
    });

    const markup30 = await markupFor(topic, '3.0');
    expect(markup30).toContain('<Url>https://example.com/spec.pdf</Url>');
    expect(markup30).not.toContain('<ReferencedDocument>');
    expect(markup30).not.toContain('isExternal');
    // Presence of both tags alone doesn't prove containment: a regression
    // that emits <DocumentReference> as a sibling of an empty
    // <DocumentReferences></DocumentReferences> would still satisfy plain
    // toContain checks. Require the entry to appear NESTED inside the
    // container, matching buildingSMART/BCF-XML markup.xsd for 3.0.
    expect(markup30).toMatch(/<DocumentReferences>[\s\S]*<DocumentReference[\s\S]*<\/DocumentReferences>/);

    const project: BCFProject = { version: '3.0', topics: new Map([[topic.guid, topic]]) };
    const readTopic = (await readBCF(await (await writeBCF(project)).arrayBuffer()))
      .topics.get(topic.guid)!;
    expect(readTopic.documentReferences?.[0]).toMatchObject({
      url: 'https://example.com/spec.pdf',
      description: 'Spec',
    });
  });

  it('reads a genuine BCF 3.0 DocumentReference (DocumentGuid/Url) authored by a third-party tool', async () => {
    // Not a round trip through our own writer: this is the shape a spec-correct
    // external BCF 3.0 tool actually emits. The 2.1-only reader used to require
    // <ReferencedDocument> to exist at all, so this whole reference was dropped.
    const zip = new JSZip();
    zip.file('bcf.version', '<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="3.0"></Version>');
    zip.folder('t1')!.file(
      'markup.bcf',
      `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Topic Guid="t1">
    <Title>Vendor topic</Title>
    <CreationDate>2026-01-01T00:00:00Z</CreationDate>
    <CreationAuthor>vendor@example.com</CreationAuthor>
    <DocumentReferences>
      <DocumentReference Guid="docref-1">
        <DocumentGuid>doc-guid-1</DocumentGuid>
        <Url>https://example.com/doc.pdf</Url>
        <Description>Spec doc</Description>
      </DocumentReference>
    </DocumentReferences>
  </Topic>
</Markup>`,
    );
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const readProject = await readBCF(bytes);
    const refs = readProject.topics.get('t1')?.documentReferences;
    expect(refs).toHaveLength(1);
    expect(refs?.[0]).toMatchObject({
      guid: 'docref-1',
      documentGuid: 'doc-guid-1',
      url: 'https://example.com/doc.pdf',
      description: 'Spec doc',
    });
  });

  it('groups BCF 3.0 DocumentReferences under the container element, and round-trips two of them', async () => {
    // The two versions differ in CONTAINMENT as well as in each entry's shape:
    // 3.0's <Topic> holds a single <DocumentReferences> element wrapping the
    // entries, while 2.1 repeats <DocumentReference> directly under <Topic>
    // (buildingSMART/BCF-XML markup.xsd, Topic). Emitting the 2.1 containment
    // at version 3.0 stays schema-invalid even once each entry is correct.
    const topic = baseTopic({
      documentReferences: [
        { guid: 'dr-1', documentGuid: 'doc-guid-1', description: 'internal' },
        { guid: 'dr-2', url: 'https://example.com/spec.pdf', description: 'external' },
      ],
    });

    const markup30 = await markupFor(topic, '3.0');
    expect(markup30).toContain('<DocumentReferences>');
    expect(markup30).toContain('</DocumentReferences>');
    // toContain alone doesn't prove containment: a regression that emits both
    // entries as siblings of an empty <DocumentReferences></DocumentReferences>
    // would still satisfy the two checks above. Require both entries to sit
    // between the container's open and close tags.
    const containerMatch = markup30.match(/<DocumentReferences>([\s\S]*)<\/DocumentReferences>/);
    expect(containerMatch).not.toBeNull();
    const containerBody = containerMatch![1];
    expect(containerBody).toContain('Guid="dr-1"');
    expect(containerBody).toContain('Guid="dr-2"');

    // Control: 2.1 must NOT gain the wrapper, so this pins the version split
    // rather than just "the wrapper is always emitted".
    const markup21 = await markupFor(topic, '2.1');
    expect(markup21).not.toContain('<DocumentReferences>');

    // Both entries must survive the wrapper on the way back in, with their own
    // guids: a reader that treats the container as if it were an entry loses
    // or misattributes the first one.
    const project: BCFProject = { version: '3.0', topics: new Map([[topic.guid, topic]]) };
    const readTopic = (await readBCF(await (await writeBCF(project)).arrayBuffer()))
      .topics.get(topic.guid)!;
    expect(readTopic.documentReferences).toHaveLength(2);
    expect(readTopic.documentReferences?.[0]).toMatchObject({
      guid: 'dr-1',
      documentGuid: 'doc-guid-1',
    });
    expect(readTopic.documentReferences?.[1]).toMatchObject({
      guid: 'dr-2',
      url: 'https://example.com/spec.pdf',
    });
  });

  it('nests Comments and Viewpoints INSIDE <Topic> for BCF 3.0, using singular <ViewPoint>', async () => {
    // BCF 3.0's markup.xsd moves Comments and Viewpoints inside <Topic>
    // (each wrapped in its own plural container), after RelatedTopics; 2.1
    // keeps them as top-level <Markup> siblings after </Topic>, using
    // <Viewpoints Guid="..."> itself as the per-entry element. Confirmed
    // against buildingSMART/BCF-XML's own release_3_0 conformance fixture
    // (Test Cases/v3.0/Visualization/Perspective camera/unzipped/.../markup.bcf),
    // whose markup reads:
    //   <Topic ...>
    //     ...
    //     <Comments> <Comment Guid="...">...</Comment> </Comments>
    //     <Viewpoints> <ViewPoint Guid="...">...</ViewPoint> </Viewpoints>
    //   </Topic>
    // A prior writer emitted the 2.1-shaped flat siblings unconditionally
    // (Viewpoints then Comment, both after </Topic>) regardless of version --
    // schema-invalid at 3.0, and undetected because our own reader was
    // equally unconditional about the flat shape, so a self round-trip
    // could never see the mismatch against a real 3.0 consumer.
    const topic = baseTopic({
      comments: [{ guid: 'c-1', date: '2026-01-01T00:00:00.000Z', author: 'a@x.com', comment: 'hi' }],
      viewpoints: [{ guid: 'vp-1', snapshot: 'data:image/png;base64,AA==' }],
    });

    const markup30 = await markupFor(topic, '3.0');

    // Comments/Viewpoints must sit between </RelatedTopics-or-whatever-comes-
    // last> and </Topic>, not after it.
    const topicMatch = markup30.match(/<Topic\b[^>]*>([\s\S]*)<\/Topic>/);
    expect(topicMatch).not.toBeNull();
    const topicBody = topicMatch![1];
    expect(topicBody).toContain('<Comments>');
    expect(topicBody).toContain('Guid="c-1"');
    expect(topicBody).toContain('<Viewpoints>');
    expect(topicBody).toContain('<ViewPoint Guid="vp-1">');
    expect(topicBody).not.toContain('<Viewpoints Guid="vp-1">');

    // Nothing pointing to Comments/Viewpoints should remain outside </Topic>.
    const afterTopic = markup30.slice(markup30.indexOf('</Topic>'));
    expect(afterTopic).not.toContain('<Comment ');
    expect(afterTopic).not.toContain('<Viewpoints');

    // Control: 2.1 keeps the old flat shape, but Comment must now precede
    // Viewpoints per its own schema sequence (Header, Topic, Comment*,
    // Viewpoints*) -- the reverse of what a prior writer emitted.
    const markup21 = await markupFor(topic, '2.1');
    expect(markup21.indexOf('<Comment Guid="c-1">')).toBeLessThan(
      markup21.indexOf('<Viewpoints Guid="vp-1">'),
    );
    expect(markup21).not.toContain('<ViewPoint ');

    // And it must still round-trip through our own reader for both versions.
    for (const version of ['2.1', '3.0'] as const) {
      const project: BCFProject = { version, topics: new Map([[topic.guid, topic]]) };
      const readTopic = (await readBCF(await (await writeBCF(project)).arrayBuffer()))
        .topics.get(topic.guid)!;
      expect(readTopic.comments).toHaveLength(1);
      expect(readTopic.comments[0].guid).toBe('c-1');
      expect(readTopic.viewpoints).toHaveLength(1);
      expect(readTopic.viewpoints[0].guid).toBe('vp-1');
    }
  });
});
