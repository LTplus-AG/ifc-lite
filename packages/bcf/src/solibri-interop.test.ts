/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3612: Solibri 26.6.1 imported zero topics from ifc-lite's BCF 2.1 archives.
 *
 * The archives were schema-valid. What separated every archive Solibri accepts
 * (its own export, BIMcollab's, usBIM's) from every ifc-lite archive it
 * rejected was the XML root shape: accepted files carry
 * `xsi:noNamespaceSchemaLocation`, declare no `xmlns:xsd`, and never write
 * `isExternal="true"` on `<Header><File>`.
 *
 * `__fixtures__/solibri-26.6.1-bcf2.1/` is Solibri's own export from that
 * thread, with personal author addresses replaced by `example@email.com`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { validateXML } from 'xmllint-wasm';
import { writeBCF } from './writer.js';
import { readBCF } from './reader.js';
import type { BCFProject, BCFTopic } from './types.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SOLIBRI_DIR = path.join(DIR, '__fixtures__', 'solibri-26.6.1-bcf2.1');
const SOLIBRI_TOPIC = 'd9a8d60e-c04f-4a83-a914-b0f395673eac';

const TOPIC_GUID = '23e6e0d2-83e4-4cb6-87a2-6d96dd5e854d';
const VIEWPOINT_GUID = '2645a56f-31dc-4f11-8ff2-a20bf884d198';

/** The reporter's "Test" topic from #3612, as ifc-lite exported it. */
function reporterTopic(): BCFTopic {
  return {
    guid: TOPIC_GUID,
    title: 'Test',
    topicType: 'Issue',
    topicStatus: 'Open',
    priority: 'Medium',
    labels: ['ARC'],
    creationDate: '2026-09-17T09:17:35.921Z',
    creationAuthor: 'example@email.com',
    modifiedDate: '2026-09-17T09:23:27.610Z',
    modifiedAuthor: 'example@email.com',
    dueDate: '2026-09-18T00:00:00Z',
    assignedTo: 'example@email.com',
    header: [
      {
        ifcProject: '2Ndyd$OSX7s9A04nc4lyye',
        filename: 'Building-Architecture.ifc',
        date: '2026-09-17T09:17:35.921Z',
        reference: 'Building-Architecture.ifc',
      },
    ],
    comments: [
      {
        guid: '81615a75-319d-457b-977f-42eafa56e830',
        date: '2026-09-17T09:23:27.610Z',
        author: 'example@email.com',
        comment: 'Test comment',
        viewpointGuid: VIEWPOINT_GUID,
      },
    ],
    viewpoints: [
      {
        guid: VIEWPOINT_GUID,
        perspectiveCamera: {
          cameraViewPoint: { x: 25.662789431190163, y: -26.013005024736316, z: 25.22065308666599 },
          cameraDirection: { x: -0.6092076990801715, y: 0.6092076990801715, z: -0.5076730825668095 },
          cameraUpVector: { x: 0, y: 0, z: 1 },
          fieldOfView: 45,
        },
        components: {
          selection: [{ ifcGuid: '12UVOn4wvAJPMUExKdZLb8' }],
          visibility: { defaultVisibility: true },
        },
        clippingPlanes: [
          {
            location: { x: -10.371266663074493, y: 3, z: 2.2000001426786184 },
            direction: { x: 0, y: 1, z: 0 },
          },
        ],
      },
    ],
  };
}

function reporterProject(version: '2.1' | '3.0' = '2.1'): BCFProject {
  const topic = reporterTopic();
  // 3.0 requires Camera/AspectRatio; 2.1 has no such element.
  if (version === '3.0') topic.viewpoints[0].perspectiveCamera!.aspectRatio = 16 / 9;
  return {
    version,
    projectId: '8cf01c69-d25c-4729-a028-4b51f5a347c5',
    name: 'Building-Architecture_Topics',
    topics: new Map([[TOPIC_GUID, topic]]),
  };
}

async function entries(blob: Blob): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const out = new Map<string, string>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir && !name.endsWith('.png')) out.set(name, await entry.async('string'));
  }
  return out;
}

/** Root element name and its attributes, in document order. */
function rootOf(xml: string): { name: string; attrs: Array<[string, string]> } {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  const m = body.match(/^<([\w:]+)((?:\s+[\w:]+="[^"]*")*)\s*\/?>/);
  if (!m) throw new Error(`no root element in: ${body.slice(0, 80)}`);
  const attrs = [...m[2].matchAll(/([\w:]+)="([^"]*)"/g)].map((a): [string, string] => [a[1], a[2]]);
  return { name: m[1], attrs };
}

const SCHEMA_FOR = {
  'bcf.version': 'version.xsd',
  'project.bcfp': 'project.xsd',
  [`${TOPIC_GUID}/markup.bcf`]: 'markup.xsd',
  [`${TOPIC_GUID}/viewpoint.bcfv`]: 'visinfo.xsd',
} as const;

describe('BCF root shape matches what Solibri reads (#3612)', () => {
  for (const version of ['2.1', '3.0'] as const) {
    it(`BCF ${version}: every file declares its XSD, no xmlns:xsd, no default isExternal`, async () => {
      const files = await entries(await writeBCF(reporterProject(version)));
      expect([...files.keys()].sort()).toEqual(Object.keys(SCHEMA_FOR).sort());
      for (const [name, xsd] of Object.entries(SCHEMA_FOR)) {
        const xml = files.get(name)!;
        const attrs = new Map(rootOf(xml).attrs);
        expect(attrs.get('xmlns:xsi'), name).toBe('http://www.w3.org/2001/XMLSchema-instance');
        expect(attrs.get('xsi:noNamespaceSchemaLocation'), name).toBe(xsd);
        expect(xml, name).not.toContain('xmlns:xsd');
      }
      expect(files.get(`${TOPIC_GUID}/markup.bcf`)).not.toMatch(/[Ii]sExternal=/);
    });

    it(`BCF ${version}: the reporter's archive validates against the buildingSMART XSDs`, async () => {
      const dir = version === '2.1' ? 'v2_1' : 'v3_0';
      const schema = (f: string) =>
        readFileSync(path.join(DIR, '__fixtures__', 'schemas', dir, f), 'utf8');
      const preload =
        version === '3.0' ? [{ fileName: 'shared-types.xsd', contents: schema('shared-types.xsd') }] : [];
      const files = await entries(await writeBCF(reporterProject(version)));
      for (const [name, xsd] of Object.entries(SCHEMA_FOR)) {
        const result = await validateXML({
          xml: [{ fileName: 'subject.xml', contents: files.get(name)! }],
          schema: [schema(xsd)],
          preload,
        });
        expect(result.errors.map((e) => `${name}: ${e.message}`)).toEqual([]);
      }
    });
  }

  it("BCF 2.1: root elements carry exactly Solibri's attributes, in Solibri's order", async () => {
    const ours = await entries(await writeBCF(reporterProject('2.1')));
    const pairs: Array<[string, string]> = [
      ['bcf.version', 'bcf.version'],
      [`${SOLIBRI_TOPIC}/markup.bcf`, `${TOPIC_GUID}/markup.bcf`],
      [`${SOLIBRI_TOPIC}/viewpoint.bcfv`, `${TOPIC_GUID}/viewpoint.bcfv`],
    ];
    for (const [solibriName, ourName] of pairs) {
      const solibri = rootOf(readFileSync(path.join(SOLIBRI_DIR, solibriName), 'utf8'));
      const mine = rootOf(ours.get(ourName)!);
      expect(mine.name).toBe(solibri.name);
      expect(mine.attrs.map(([k]) => k), ourName).toEqual(solibri.attrs.map(([k]) => k));
      // Instance data (Guid) differs; the namespace, version and schema values must not.
      const fixed = (a: Array<[string, string]>) => a.filter(([k]) => k !== 'Guid');
      expect(fixed(mine.attrs), ourName).toEqual(fixed(solibri.attrs));
    }
    // Solibri writes no project.bcfp; ours follows the same rule for its XSD.
    expect(rootOf(ours.get('project.bcfp')!).attrs).toEqual([
      ['xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance'],
      ['xsi:noNamespaceSchemaLocation', 'project.xsd'],
    ]);
  });

  it('Header <File>: true is omitted like Solibri, false survives a read/write round trip', async () => {
    const solibriMarkup = readFileSync(path.join(SOLIBRI_DIR, SOLIBRI_TOPIC, 'markup.bcf'), 'utf8');
    expect(solibriMarkup).toMatch(/<File IfcProject="[^"]*">/);

    // An archive in the OLD ifc-lite shape (xmlns:xsd, explicit isExternal on
    // both files, no schema locations) must still be read...
    const legacy = new JSZip();
    const xsiXsd =
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"';
    legacy.file('bcf.version', `<?xml version="1.0" encoding="UTF-8"?>
<Version ${xsiXsd} VersionId="2.1">
  <DetailedVersion>2.1</DetailedVersion>
</Version>`);
    legacy.file(`${TOPIC_GUID}/markup.bcf`, `<?xml version="1.0" encoding="UTF-8"?>
<Markup ${xsiXsd}>
  <Header>
    <File IfcProject="2Ndyd$OSX7s9A04nc4lyye" isExternal="true">
      <Filename>a.ifc</Filename>
    </File>
    <File IfcProject="3aB9cd_ef2Gh1Ij4Kl5Mn6" isExternal="false">
      <Filename>b.ifc</Filename>
    </File>
  </Header>
  <Topic Guid="${TOPIC_GUID}" TopicType="Issue" TopicStatus="Open">
    <Title>Legacy</Title>
    <CreationDate>2026-09-17T09:17:35.921Z</CreationDate>
    <CreationAuthor>example@email.com</CreationAuthor>
  </Topic>
</Markup>`);
    const read = await readBCF(await legacy.generateAsync({ type: 'arraybuffer' }));
    const header = read.topics.get(TOPIC_GUID)!.header!;
    expect(header.map((f) => f.isExternal)).toEqual([true, false]);

    // ...and re-written in the new shape, keeping the explicit false.
    const markup = (await entries(await writeBCF(read))).get(`${TOPIC_GUID}/markup.bcf`)!;
    expect(markup).toContain('<File IfcProject="2Ndyd$OSX7s9A04nc4lyye">');
    expect(markup).toContain('<File IfcProject="3aB9cd_ef2Gh1Ij4Kl5Mn6" isExternal="false">');
    const reread = await readBCF(await (await writeBCF(read)).arrayBuffer());
    expect(reread.topics.get(TOPIC_GUID)!.header!.map((f) => f.isExternal)).toEqual([undefined, false]);
  });

  it("reads Solibri's own export, and round-trips the reporter's topic unchanged", async () => {
    const zip = new JSZip();
    zip.file('bcf.version', readFileSync(path.join(SOLIBRI_DIR, 'bcf.version')));
    for (const f of ['markup.bcf', 'viewpoint.bcfv']) {
      zip.file(`${SOLIBRI_TOPIC}/${f}`, readFileSync(path.join(SOLIBRI_DIR, SOLIBRI_TOPIC, f)));
    }
    const solibri = await readBCF(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(solibri.version).toBe('2.1');
    const topic = solibri.topics.get(SOLIBRI_TOPIC)!;
    expect(topic.title).toBe('Test Issue');
    expect(topic.viewpoints[0].components?.selection?.[0].ifcGuid).toBe('0OfZwWc8j9QP5uX8xPTxDH');

    const original = reporterTopic();
    const back = (await readBCF(await (await writeBCF(reporterProject('2.1'))).arrayBuffer()))
      .topics.get(TOPIC_GUID)!;
    expect(back.title).toBe(original.title);
    expect(back.comments[0]).toMatchObject(original.comments[0]);
    expect(back.viewpoints[0].perspectiveCamera).toMatchObject(original.viewpoints[0].perspectiveCamera!);
    expect(back.viewpoints[0].components?.selection).toEqual(original.viewpoints[0].components?.selection);
    expect(back.viewpoints[0].clippingPlanes).toEqual(original.viewpoints[0].clippingPlanes);
  });
});
