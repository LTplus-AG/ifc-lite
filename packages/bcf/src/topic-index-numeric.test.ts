/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3961: `readTopic` parsed `Topic/Index` with a raw `parseInt`, the one
 * numeric field in this reader that was never routed through
 * `parseFiniteFloat` (`numeric.ts`) the way every other numeric field
 * (camera fields, clipping-plane points, field of view, view-to-world scale)
 * already is. `parseInt('not-a-number', 10)` is `NaN`, which is a `number`
 * per `BCFTopic.index?: number` (`types.ts`) -- so a malformed `<Index>`
 * became a value indistinguishable, by type, from a real index, rather than
 * `undefined` the way a missing `<Index>` already reads.
 *
 * The writer independently guards this same field with `xsdInt` (which
 * throws on a non-integer), so a self export/import round trip can never
 * exercise a bad `Index` -- this is only reachable reading a third-party
 * archive, hence the hand-built markup here.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readBCF } from './reader.js';

function archiveWithIndex(indexXml: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('bcf.version', `<?xml version="1.0" encoding="UTF-8"?>
<Version VersionId="2.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><DetailedVersion>2.1</DetailedVersion></Version>`);
  zip.file('topic-a/markup.bcf', `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Topic Guid="bbbbbbbb-1111-2222-3333-444444444444" TopicType="Issue" TopicStatus="Open">
    <Title>Topic</Title>
    ${indexXml}
    <CreationDate>2026-01-01T00:00:00Z</CreationDate>
    <CreationAuthor>tester@example.com</CreationAuthor>
  </Topic>
</Markup>`);
  return zip.generateAsync({ type: 'nodebuffer' }) as unknown as Promise<Uint8Array>;
}

describe('#3961: non-numeric Topic/Index', () => {
  it('parses a non-numeric <Index> to undefined, not NaN', async () => {
    const buf = await archiveWithIndex('<Index>not-a-number</Index>');
    const project = await readBCF(buf);
    const topic = [...project.topics.values()][0];

    expect(topic.index).toBeUndefined();
    expect(Number.isNaN(topic.index)).toBe(false);
  });

  it('control: a valid <Index> still parses to that number', async () => {
    const buf = await archiveWithIndex('<Index>7</Index>');
    const project = await readBCF(buf);
    const topic = [...project.topics.values()][0];

    expect(topic.index).toBe(7);
  });

  it('control: an absent <Index> yields undefined, matching the malformed case', async () => {
    const buf = await archiveWithIndex('');
    const project = await readBCF(buf);
    const topic = [...project.topics.values()][0];

    expect(topic.index).toBeUndefined();
  });
});
