/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * XML attribute order is not semantically significant, but several of
 * reader.ts's regexes required `Guid="..."` to be the FIRST attribute on an
 * opening tag. Our own writer.ts always emits Guid first, so a self
 * round-trip never caught this -- only a file from another tool, where the
 * attribute order differs, exposes it. These tests build markup with
 * attributes deliberately reordered before Guid.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readBCF } from './reader.js';

async function readMarkup(markup: string) {
  const zip = new JSZip();
  zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
  zip.file('topic-1/markup.bcf', markup);
  const buffer = await zip.generateAsync({ type: 'arraybuffer' });
  return readBCF(buffer);
}

describe('interop: attribute order independence', () => {
  it('reads a Topic whose Guid is not the first attribute', async () => {
    const markup = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Markup>',
      '  <Topic TopicType="Issue" TopicStatus="Open" Guid="topic-1">',
      '    <Title>Reordered attrs</Title>',
      '  </Topic>',
      '</Markup>',
    ].join('\n');

    const project = await readMarkup(markup);

    expect(project.topics.size).toBe(1);
    const topic = project.topics.get('topic-1');
    expect(topic).toBeDefined();
    expect(topic?.title).toBe('Reordered attrs');
    expect(topic?.topicType).toBe('Issue');
    expect(topic?.topicStatus).toBe('Open');
  });

  it('reads a RelatedTopic whose Guid is not the first attribute', async () => {
    const markup = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Markup>',
      '  <Topic Guid="topic-1">',
      '    <Title>Has related</Title>',
      '    <RelatedTopic Foo="bar" Guid="topic-2"/>',
      '  </Topic>',
      '</Markup>',
    ].join('\n');

    const project = await readMarkup(markup);
    const topic = project.topics.get('topic-1');
    expect(topic?.relatedTopics).toEqual(['topic-2']);
  });

  it('reads a Comment whose Guid is not the first attribute', async () => {
    const markup = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Markup>',
      '  <Topic Guid="topic-1">',
      '    <Title>Has comment</Title>',
      '  </Topic>',
      '  <Comment Foo="bar" Guid="comment-1">',
      '    <Date>2026-01-01T00:00:00Z</Date>',
      '    <Author>alice@example.com</Author>',
      '    <Comment>hello</Comment>',
      '  </Comment>',
      '</Markup>',
    ].join('\n');

    const project = await readMarkup(markup);
    const topic = project.topics.get('topic-1');
    expect(topic?.comments.length).toBe(1);
    expect(topic?.comments[0].guid).toBe('comment-1');
    expect(topic?.comments[0].comment).toBe('hello');
  });

  it('reads a Comment\'s Viewpoint reference whose Guid is not the first attribute', async () => {
    const markup = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Markup>',
      '  <Topic Guid="topic-1">',
      '    <Title>Has comment viewpoint ref</Title>',
      '  </Topic>',
      '  <Comment Guid="comment-1">',
      '    <Date>2026-01-01T00:00:00Z</Date>',
      '    <Author>alice@example.com</Author>',
      '    <Comment>hello</Comment>',
      '    <Viewpoint Foo="bar" Guid="vp-1"/>',
      '  </Comment>',
      '</Markup>',
    ].join('\n');

    const project = await readMarkup(markup);
    const topic = project.topics.get('topic-1');
    expect(topic?.comments[0].viewpointGuid).toBe('vp-1');
  });
});
