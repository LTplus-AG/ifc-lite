/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3960: `readTopics` keys topics by their internal `Topic/@Guid` in a
 * `Map`. Two distinct topic folders whose `markup.bcf` both declare the same
 * `Topic Guid` used to collide silently -- the second folder read overwrote
 * the first in the map with no warning and no error, so a caller could not
 * tell "the archive had one topic" from "the archive had two topics and we
 * dropped one".
 *
 * `readBCF`'s own writer can never produce this input (`BCFProject.topics`
 * is itself a `Map<string, BCFTopic>`, so two topics sharing a guid are
 * structurally impossible at the writer's boundary), which is why a hand
 * assembled archive is used here rather than a round trip.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import JSZip from 'jszip';
import { readBCF } from './reader.js';

function versionFile(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Version VersionId="2.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><DetailedVersion>2.1</DetailedVersion></Version>`;
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#3960: colliding topic Guid across two folders', () => {
  it('keeps the first topic, drops the second, and warns -- rather than silently overwriting', async () => {
    const guid = 'aaaaaaaa-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    zip.file('folder-one/markup.bcf', markupFile(guid, 'Topic in folder-one'));
    zip.file('folder-two/markup.bcf', markupFile(guid, 'Topic in folder-two'));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = await readBCF(buf);

    // Both folders existed; exactly one topic must survive under the shared
    // guid, and the caller must be told a collision happened rather than
    // seeing a plain 1-topic archive.
    expect(project.topics.size).toBe(1);
    expect(warn).toHaveBeenCalled();
    const warned = warn.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes(guid) && /duplicate|collis/i.test(arg)),
    );
    expect(warned).toBe(true);

    // Deterministic: folder set iteration is insertion order, so the FIRST
    // folder read (folder-one) is the one kept.
    const topic = project.topics.get(guid);
    expect(topic?.title).toBe('Topic in folder-one');
  });

  it('control: two topics with distinct guids both survive, untouched by the collision guard', async () => {
    const guidA = 'aaaaaaaa-1111-2222-3333-444444444444';
    const guidB = 'bbbbbbbb-1111-2222-3333-444444444444';
    const zip = new JSZip();
    zip.file('bcf.version', versionFile());
    zip.file('folder-one/markup.bcf', markupFile(guidA, 'Topic A'));
    zip.file('folder-two/markup.bcf', markupFile(guidB, 'Topic B'));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const project = await readBCF(buf);

    expect(project.topics.size).toBe(2);
    expect(project.topics.get(guidA)?.title).toBe('Topic A');
    expect(project.topics.get(guidB)?.title).toBe('Topic B');
    expect(warn).not.toHaveBeenCalled();
  });
});
