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
});
