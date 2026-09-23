/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5213: two independent silent-drop bugs in `readTopics`/`parseViewpoints`.
 *
 * 1. The topic-folder regex was anchored at the archive root
 *    (`^([^/]+)\/markup\.bcf$`), so an archive shaped
 *    `MyProject/<guid>/markup.bcf` -- the ordinary result of zipping a
 *    *folder* rather than its contents -- matched nothing and the topic
 *    vanished with no warning.
 * 2. The viewpoint-file scan used a case-sensitive `endsWith('.bcfv')`,
 *    three lines from a topic-folder match that already carries `/i`, so a
 *    `markup.bcf` explicitly naming `viewpoint.BCFV` still lost its
 *    viewpoint silently.
 *
 * Widening the topic-folder match to any depth reopens a third hazard:
 * `__MACOSX/<guid>/markup.bcf`, the AppleDouble resource-fork shadow a
 * macOS-made zip commonly carries alongside real content. Matched at any
 * depth without exclusion, that shadow path would manufacture a phantom
 * topic with no corresponding real data -- worse than the bug being fixed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import JSZip from 'jszip';
import { readBCF } from './reader.js';

function versionFile(versionId = '2.1'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Version VersionId="${versionId}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><DetailedVersion>${versionId}</DetailedVersion></Version>`;
}

function markupFile(guid: string, title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Topic Guid="${guid}" TopicType="Issue" TopicStatus="Open">
    <Title>${title}</Title>
    <CreationDate>2026-01-01T00:00:00Z</CreationDate>
    <CreationAuthor>tester@example.com</CreationAuthor>
  </Topic>
</Markup>`;
}

function markupFileWithViewpoint(guid: string, title: string, vpGuid: string, vpFileName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Topic Guid="${guid}" TopicType="Issue" TopicStatus="Open">
    <Title>${title}</Title>
    <CreationDate>2026-01-01T00:00:00Z</CreationDate>
    <CreationAuthor>tester@example.com</CreationAuthor>
  </Topic>
  <Viewpoints Guid="${vpGuid}">
    <Viewpoint>${vpFileName}</Viewpoint>
  </Viewpoints>
</Markup>`;
}

function viewpointFile(vpGuid: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${vpGuid}">
  <Components/>
</VisualizationInfo>`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#5213: topic folder nested below archive root', () => {
  it('reads a matched uppercase Markup.BCF entry using its actual archive path', async () => {
    const guid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('MyProject/bcf.version', versionFile());
    zip.file(`MyProject/${guid}/Markup.BCF`, markupFile(guid, 'Uppercase markup'));

    const project = await readBCF(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(project.topics.get(guid)?.title).toBe('Uppercase markup');
  });

  it('reports duplicate case variants of markup in one topic folder', async () => {
    const guid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    zip.file(`${guid}/markup.bcf`, markupFile(guid, 'First markup'));
    zip.file(`${guid}/Markup.BCF`, markupFile(guid, 'Second markup'));
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const project = await readBCF(await zip.generateAsync({ type: 'nodebuffer' }), {
      onWarning: (message) => warnings.push(message),
    });

    expect(project.topics.get(guid)?.title).toBe('First markup');
    expect(warnings).toEqual([expect.stringMatching(/Multiple markup\.bcf entries/)]);
  });

  it('reports a skipped duplicate topic through the import callback', async () => {
    const guid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    zip.file('first/markup.bcf', markupFile(guid, 'First topic'));
    zip.file('second/markup.bcf', markupFile(guid, 'Duplicate topic'));
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const project = await readBCF(await zip.generateAsync({ type: 'nodebuffer' }), {
      onWarning: (message) => warnings.push(message),
    });

    expect(project.topics.size).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Duplicate topic Guid/);
  });

  it('reads metadata and topics when the entire project folder is zipped', async () => {
    const guid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('MyProject/bcf.version', versionFile());
    zip.file('MyProject/project.bcfp', '<ProjectInfo><Project ProjectId="project-a"><Name>Wrapped project</Name></Project></ProjectInfo>');
    zip.file(`MyProject/${guid}/markup.bcf`, markupFile(guid, 'Wrapped topic'));

    const project = await readBCF(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(project.name).toBe('Wrapped project');
    expect(project.topics.get(guid)?.title).toBe('Wrapped topic');
  });

  // The wrapped root is found by a case-insensitive match, so the metadata
  // must be read back by the entry that matched, not by a lowercase name
  // JSZip does not hold (CodeRabbit on c6b9909f0).
  it('reads uppercase metadata entries in a wrapped project folder', async () => {
    const guid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('MyProject/BCF.VERSION', versionFile('3.0'));
    zip.file('MyProject/PROJECT.BCFP', '<ProjectInfo><Project ProjectId="project-a"><Name>Upper project</Name></Project></ProjectInfo>');
    zip.file(`MyProject/${guid}/markup.bcf`, markupFile(guid, 'Wrapped topic'));

    const project = await readBCF(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(project.version).toBe('3.0');
    expect(project.name).toBe('Upper project');
    expect(project.topics.get(guid)?.title).toBe('Wrapped topic');
  });

  it('reads an uppercase BCF.VERSION at the archive root', async () => {
    const guid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('BCF.VERSION', versionFile('3.0'));
    zip.file(`${guid}/markup.bcf`, markupFile(guid, 'Root topic'));

    const project = await readBCF(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(project.version).toBe('3.0');
    expect(project.topics.get(guid)?.title).toBe('Root topic');
  });

  it('reads a topic one level deeper than root (zipped-folder-not-contents shape)', async () => {
    const guid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    zip.file(`MyProject/${guid}/markup.bcf`, markupFile(guid, 'Nested topic'));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const project = await readBCF(buf);

    expect(project.topics.size).toBe(1);
    expect(project.topics.get(guid)?.title).toBe('Nested topic');
  });

  it('reads both a root-level topic and a nested topic in the same archive', async () => {
    const rootGuid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const nestedGuid = 'bbbbbbbb-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    zip.file(`${rootGuid}/markup.bcf`, markupFile(rootGuid, 'Root-level topic'));
    zip.file(`MyProject/${nestedGuid}/markup.bcf`, markupFile(nestedGuid, 'Nested topic'));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const project = await readBCF(buf);

    expect(project.topics.size).toBe(2);
    expect(project.topics.get(rootGuid)?.title).toBe('Root-level topic');
    expect(project.topics.get(nestedGuid)?.title).toBe('Nested topic');
  });

  it('does NOT manufacture a phantom topic from a __MACOSX resource-fork shadow entry', async () => {
    const realGuid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const shadowGuid = 'cccccccc-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    zip.file(`${realGuid}/markup.bcf`, markupFile(realGuid, 'Real topic'));
    // AppleDouble shadow tree a macOS-made zip commonly carries alongside
    // real content -- must never be read as a topic folder.
    zip.file(`__MACOSX/${shadowGuid}/markup.bcf`, markupFile(shadowGuid, 'Should never appear'));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = await readBCF(buffer);

    expect(project.topics.size).toBe(1);
    expect(project.topics.has(shadowGuid)).toBe(false);
    expect(project.topics.get(realGuid)?.title).toBe('Real topic');
  });
});

describe('#5213: import warning categories', () => {
  it('reports an unsupported version separately from skipped items', async () => {
    const zip = new JSZip();
    zip.file('bcf.version', versionFile('4.0'));
    const warnings: Array<{ message: string; kind: 'skipped' | 'version' }> = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const project = await readBCF(await zip.generateAsync({ type: 'nodebuffer' }), {
      onWarning: (message, kind) => warnings.push({ message, kind }),
    });

    expect(project.version).toBe('2.1');
    expect(warnings).toEqual([{
      message: 'Unsupported BCF version: 4.0, treating as 2.1',
      kind: 'version',
    }]);
  });
});

describe('#5213: uppercase .BCFV viewpoint extension', () => {
  it('finds the matching snapshot through the fallback naming pattern', async () => {
    const topicGuid = '33333333-3333-3333-3333-333333333333';
    const vpGuid = '44444444-4444-4444-4444-444444444444';
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    zip.file(`${topicGuid}/markup.bcf`, markupFileWithViewpoint(topicGuid, 'Snapshot fallback', vpGuid, `Viewpoint_${vpGuid}.BCFV`));
    zip.file(`${topicGuid}/Viewpoint_${vpGuid}.BCFV`, viewpointFile(vpGuid));
    zip.file(`${topicGuid}/Snapshot_${vpGuid}.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const project = await readBCF(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(project.topics.get(topicGuid)?.viewpoints[0]?.snapshot).toMatch(/^data:image\/png;base64,/);
  });

  it('reads a viewpoint file named with an uppercase .BCFV extension', async () => {
    const topicGuid = '33333333-3333-3333-3333-333333333333';
    const vpGuid = '44444444-4444-4444-4444-444444444444';
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    zip.file(
      `${topicGuid}/markup.bcf`,
      markupFileWithViewpoint(topicGuid, 'Topic with uppercase viewpoint', vpGuid, 'viewpoint.BCFV'),
    );
    zip.file(`${topicGuid}/viewpoint.BCFV`, viewpointFile(vpGuid));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const project = await readBCF(buffer);
    const topic = project.topics.get(topicGuid);

    expect(topic).toBeDefined();
    expect(topic?.viewpoints).toHaveLength(1);
    expect(topic?.viewpoints[0]?.guid).toBe(vpGuid);
  });

  it('control: lowercase .bcfv still reads (no regression)', async () => {
    const topicGuid = '33333333-3333-3333-3333-333333333333';
    const vpGuid = '44444444-4444-4444-4444-444444444444';
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    zip.file(
      `${topicGuid}/markup.bcf`,
      markupFileWithViewpoint(topicGuid, 'Topic with lowercase viewpoint', vpGuid, 'viewpoint.bcfv'),
    );
    zip.file(`${topicGuid}/viewpoint.bcfv`, viewpointFile(vpGuid));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const project = await readBCF(buffer);
    const topic = project.topics.get(topicGuid);

    expect(topic?.viewpoints).toHaveLength(1);
    expect(topic?.viewpoints[0]?.guid).toBe(vpGuid);
  });
});

describe('#5213: no-regression pin for a correctly-shaped root-level archive', () => {
  it('reads a plain root-level archive identically to before', async () => {
    const guid = '55555555-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    zip.file(`${guid}/markup.bcf`, markupFile(guid, 'Plain topic'));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const project = await readBCF(buffer);

    expect(project.topics.size).toBe(1);
    expect(project.topics.get(guid)?.title).toBe('Plain topic');
  });
});
