/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5188: `readTopics` matched topic folders with `/^([^/]+)\/markup\.bcf$/i`,
 * which requires a literal forward slash. A `.bcfzip` whose entries use
 * backslash separators -- a real historical Windows-zip-writer output, and
 * BCF is an interop format read from other vendors' tools -- produced zero
 * matches, so `readBCF` returned a successful, EMPTY project with no warning
 * and no error. A caller could not distinguish "this archive has no topics"
 * from "every topic in this archive was invisible to the reader".
 *
 * The fix has two halves:
 *  1. Rewrite `\` to `/` in every entry name once, right after the archive
 *     loads (`normalizeEntrySeparators`), so every later lookup (archive
 *     root, topic folders, viewpoints, snapshots) sees one separator. The
 *     writer is untouched and still only emits forward slashes, the usual
 *     tolerant-reader/strict-writer split.
 *  2. Warn, through `onWarning` as well as the console, when the archive
 *     holds a `markup.bcf` that no topic folder claims, so any OTHER layout
 *     the reader can't place is reported instead of silently dropped.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import JSZip from 'jszip';
import { readBCF } from './reader.js';

function versionFile(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Version VersionId="2.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><DetailedVersion>2.1</DetailedVersion></Version>`;
}

function markupFile(guid: string, title: string, viewpointRef?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Topic Guid="${guid}" TopicType="Issue" TopicStatus="Open">
    <Title>${title}</Title>
    <CreationDate>2026-01-01T00:00:00Z</CreationDate>
    <CreationAuthor>tester@example.com</CreationAuthor>
  </Topic>${viewpointRef ? `
  <Viewpoints Guid="vp-1111-2222-3333-444444444444">
    <Viewpoint>${viewpointRef}</Viewpoint>
    <Snapshot>snapshot.png</Snapshot>
  </Viewpoints>` : ''}
</Markup>`;
}

function viewpointFile(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="vp-1111-2222-3333-444444444444" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <PerspectiveCamera>
    <CameraViewPoint><X>0</X><Y>0</Y><Z>0</Z></CameraViewPoint>
    <CameraDirection><X>0</X><Y>0</Y><Z>-1</Z></CameraDirection>
    <CameraUpVector><X>0</X><Y>1</Y><Z>0</Z></CameraUpVector>
    <FieldOfView>60</FieldOfView>
  </PerspectiveCamera>
</VisualizationInfo>`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#5188: backslash-separated .bcfzip entries', () => {
  it('reads a topic whose folder uses a backslash separator (real Windows-zip-writer output)', async () => {
    const guid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    // A single entry name containing a literal backslash, not a nested path
    // -- exactly what a Windows-originated zip writer emits and JSZip does
    // NOT normalise on load (unlike a leading "./").
    zip.file(`${guid}\\markup.bcf`, markupFile(guid, 'Topic behind a backslash path', 'viewpoint.bcfv'));
    zip.file(`${guid}\\viewpoint.bcfv`, viewpointFile());
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = await readBCF(buf);

    expect(project.topics.size).toBe(1);
    const topic = project.topics.get(guid);
    expect(topic?.title).toBe('Topic behind a backslash path');
    expect(topic?.creationAuthor).toBe('tester@example.com');
    expect(topic?.creationDate).toBe('2026-01-01T00:00:00Z');

    // The more important half of the fix: normalisation makes the folder AND
    // everything inside it discoverable, not just the folder. A viewpoint
    // referenced from markup.bcf and stored under the same backslash folder
    // must still resolve (readTopic/parseViewpoints hit the same separator
    // as the topic-folder match).
    expect(topic?.viewpoints).toHaveLength(1);
    expect(topic?.viewpoints[0]?.guid).toBe('vp-1111-2222-3333-444444444444');

    // A correctly read topic is not itself a signal of a problem.
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when a markup.bcf entry exists that no topic folder can claim', async () => {
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    // Root-level markup.bcf, no topic-folder segment at all -- normalisation
    // cannot rescue this shape, and it must not be a silent empty project.
    zip.file('markup.bcf', markupFile('bbbbbbbb-1111-2222-3333-444444444444', 'Orphan topic'));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = await readBCF(buf);

    expect(project.topics.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    const warned = warn.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && /markup\.bcf/i.test(arg) && /is not inside a topic folder/.test(arg)),
    );
    expect(warned).toBe(true);
  });

  it('reads a zipped-folder archive whose root folder is also backslash-separated (#5188 on top of #5213)', async () => {
    const guid = 'cccccccc-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('Project\\bcf.version', versionFile());
    zip.file(`Project\\${guid}\\markup.bcf`, markupFile(guid, 'Nested behind backslashes', 'viewpoint.bcfv'));
    zip.file(`Project\\${guid}\\viewpoint.bcfv`, viewpointFile());
    zip.file(`Project\\${guid}\\snapshot.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onWarning = vi.fn();
    const project = await readBCF(buf, { onWarning });

    const topic = project.topics.get(guid);
    expect(topic?.title).toBe('Nested behind backslashes');
    expect(topic?.viewpoints).toHaveLength(1);
    expect(topic?.viewpoints[0]?.snapshot).toBeTruthy();
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('reports the unclaimed markup.bcf through onWarning, not only the console', async () => {
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    zip.file('markup.bcf', markupFile('dddddddd-1111-2222-3333-444444444444', 'Orphan topic'));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onWarning = vi.fn();
    const project = await readBCF(buf, { onWarning });

    expect(project.topics.size).toBe(0);
    expect(onWarning).toHaveBeenCalledWith(expect.stringMatching(/markup\.bcf entry "markup\.bcf" is not inside a topic folder/), 'skipped');
  });
});
