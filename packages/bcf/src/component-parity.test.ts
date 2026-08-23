/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `<Component>` writer/reader agreement.
 *
 * BCF 2.1 and 3.0 both model `OriginatingSystem` and `AuthoringToolId` as
 * child ELEMENTS of `<Component>` — only `IfcGuid` is an attribute. The
 * writer has always emitted the element form (its own docstring says so);
 * the reader matched them as attributes, so the two halves of one format
 * never agreed. Every component carrying either field lost it on read,
 * whether the archive came from ifc-lite or from another tool.
 *
 * The existing writer tests could not see this: no fixture set either field,
 * so the reader's `undefined` looked like a faithful round-trip of an empty
 * input rather than a dropped value.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { writeBCF } from './writer.js';
import { readBCF } from './reader.js';
import type { BCFProject, BCFTopic, BCFViewpoint } from './types.js';
import { generateUuid } from '@ifc-lite/encoding';

function projectWith(viewpoint: BCFViewpoint): { project: BCFProject; topic: BCFTopic } {
  const topic: BCFTopic = {
    guid: generateUuid(),
    title: 'component parity',
    creationDate: '2026-01-01T00:00:00.000Z',
    creationAuthor: 'test',
    comments: [],
    viewpoints: [viewpoint],
  };
  return { project: { version: '2.1', topics: new Map([[topic.guid, topic]]) }, topic };
}

async function roundTrip(viewpoint: BCFViewpoint): Promise<BCFViewpoint> {
  const { project, topic } = projectWith(viewpoint);
  const blob = await writeBCF(project);
  const read = await readBCF(await blob.arrayBuffer());
  return read.topics.get(topic.guid)!.viewpoints[0];
}

describe('BCF <Component> writer/reader agreement', () => {
  it('round-trips OriginatingSystem and AuthoringToolId on a selection component', async () => {
    const out = await roundTrip({
      guid: generateUuid(),
      components: {
        selection: [
          {
            ifcGuid: 'SELECTED00000000000001',
            authoringToolId: 'internal-4711',
            originatingSystem: 'SomeAuthoringTool',
          },
        ],
      },
    });

    expect(out.components?.selection).toEqual([
      {
        ifcGuid: 'SELECTED00000000000001',
        authoringToolId: 'internal-4711',
        originatingSystem: 'SomeAuthoringTool',
      },
    ]);
  });

  it('keeps a component identified only by AuthoringToolId', async () => {
    // Per spec `IfcGuid` is optional; a component whose only identity is the
    // authoring tool's internal id must survive. Reading the field as an
    // attribute made this component look empty, and it was discarded whole.
    const out = await roundTrip({
      guid: generateUuid(),
      components: { selection: [{ authoringToolId: 'no-guid-here' }] },
    });

    expect(out.components?.selection).toEqual([
      { ifcGuid: undefined, authoringToolId: 'no-guid-here', originatingSystem: undefined },
    ]);
  });

  it('round-trips the fields on visibility exceptions and coloring members too', async () => {
    const out = await roundTrip({
      guid: generateUuid(),
      components: {
        visibility: {
          defaultVisibility: true,
          exceptions: [{ ifcGuid: 'HIDDEN0000000000000001', originatingSystem: 'ExceptionSys' }],
        },
        coloring: [
          {
            color: 'FFFF0000',
            components: [{ ifcGuid: 'REDELEMENT00000000000a', authoringToolId: 'red-1' }],
          },
        ],
      },
    });

    expect(out.components?.visibility?.exceptions?.[0].originatingSystem).toBe('ExceptionSys');
    expect(out.components?.coloring?.[0].components[0].authoringToolId).toBe('red-1');
  });

  it('unescapes XML entities in the element text', async () => {
    const out = await roundTrip({
      guid: generateUuid(),
      components: {
        selection: [{ ifcGuid: 'ENTITY00000000000000a', originatingSystem: 'A & B <tool>' }],
      },
    });

    expect(out.components?.selection?.[0].originatingSystem).toBe('A & B <tool>');
  });
});

describe('BCF <Component> splitting, mixed self-closing and full forms', () => {
  // `writeComponent` emits `<Component .../>` when a component has no child
  // elements and `<Component ...>...</Component>` when it does, so an ORDINARY
  // selection holding one of each produces a mixed list. Every fixture above
  // holds one shape, and the defect below cannot be reached by a uniform list.
  it('reads a self-closing component followed by a full one as TWO components', async () => {
    const out = await roundTrip({
      guid: generateUuid(),
      components: {
        selection: [
          { ifcGuid: 'PLAIN00000000000000001' },
          { ifcGuid: 'FANCY00000000000000002', authoringToolId: 'tool-b' },
        ],
      },
    });

    // Why the pair used to come back as one component, and why that is
    // misattribution rather than a dropped field: see `COMPONENT_ELEMENT` in
    // `reader-components.ts`.
    expect(out.components?.selection).toEqual([
      { ifcGuid: 'PLAIN00000000000000001', authoringToolId: undefined, originatingSystem: undefined },
      { ifcGuid: 'FANCY00000000000000002', authoringToolId: 'tool-b', originatingSystem: undefined },
    ]);
  });

  it('splits the same mixed pair inside a <Coloring> entry', async () => {
    // The identical splitter lived at a second call site. One shared helper
    // parses both now, so this pins that the coloring path got the fix too
    // rather than being left on its own copy.
    const out = await roundTrip({
      guid: generateUuid(),
      components: {
        coloring: [
          {
            color: 'FF0000',
            components: [
              { ifcGuid: 'PLAIN00000000000000001' },
              { ifcGuid: 'FANCY00000000000000002', authoringToolId: 'tool-b' },
            ],
          },
        ],
      },
    });

    expect(out.components?.coloring?.[0].components).toEqual([
      { ifcGuid: 'PLAIN00000000000000001', authoringToolId: undefined, originatingSystem: undefined },
      { ifcGuid: 'FANCY00000000000000002', authoringToolId: 'tool-b', originatingSystem: undefined },
    ]);
  });

  it('a uniform list of self-closing components is unaffected', async () => {
    // The control. This shape always worked, because the engine backtracks and
    // gives the `/` back when no later `</Component>` exists. If this ever
    // fails, the fix broke the common case rather than the rare one.
    const out = await roundTrip({
      guid: generateUuid(),
      components: {
        selection: [{ ifcGuid: 'ONE0000000000000000001' }, { ifcGuid: 'TWO0000000000000000002' }],
      },
    });

    expect(out.components?.selection?.length).toBe(2);
  });
});

describe('BCF <Component> attribute fallbacks decode entities', () => {
  // The spec puts OriginatingSystem and AuthoringToolId in child ELEMENTS, and
  // the attribute spellings are accepted as a fallback for tools that emit the
  // non-spec form. Both spellings must yield the SAME value: which one a file
  // happens to use is not supposed to change the data.
  async function readSelection(componentXml: string) {
    return (await readComponents(`<Selection>${componentXml}</Selection>`))?.selection;
  }

  /** Read a hand-written `<Components>` body back through the real `readBCF`. */
  async function readComponents(componentsBody: string) {
    const bcfv = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<VisualizationInfo Guid="vp-1">',
      '  <Components>',
      `    ${componentsBody}`,
      '  </Components>',
      '</VisualizationInfo>',
    ].join('\n');
    const markup = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Markup>',
      '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
      '    <Title>entity fallback</Title>',
      '  </Topic>',
      '  <Viewpoints Guid="vp-1">',
      '    <Viewpoint>viewpoint.bcfv</Viewpoint>',
      '  </Viewpoints>',
      '</Markup>',
    ].join('\n');
    const zip = new JSZip();
    zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
    zip.file('topic-1/markup.bcf', markup);
    zip.file('topic-1/viewpoint.bcfv', bcfv);
    const project = await readBCF(await zip.generateAsync({ type: 'arraybuffer' }));
    return Array.from(project.topics.values())[0].viewpoints[0].components;
  }

  it('gives the same value whether the field is an attribute or an element', async () => {
    const fromAttribute = await readSelection(
      '<Component IfcGuid="G00000000000000000001" AuthoringToolId="A &amp; B"/>',
    );
    const fromElement = await readSelection(
      '<Component IfcGuid="G00000000000000000001"><AuthoringToolId>A &amp; B</AuthoringToolId></Component>',
    );
    // Before the fix the attribute path returned the literal "A &amp; B".
    expect(fromAttribute?.[0].authoringToolId).toBe('A & B');
    expect(fromElement?.[0].authoringToolId).toBe('A & B');
  });

  it('the element form still wins when a file carries both', async () => {
    const out = await readSelection(
      '<Component IfcGuid="G00000000000000000001" AuthoringToolId="from-attribute">'
      + '<AuthoringToolId>from-element</AuthoringToolId></Component>',
    );
    expect(out?.[0].authoringToolId).toBe('from-element');
  });
});

describe('BCF <Component> attribute reading is scoped and anchored', () => {
  async function readSel(componentXml: string) {
    const bcfv = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<VisualizationInfo Guid="vp-1">',
      '  <Components>',
      `    <Selection>${componentXml}</Selection>`,
      '  </Components>',
      '</VisualizationInfo>',
    ].join('\n');
    const markup = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Markup>',
      '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open"><Title>t</Title></Topic>',
      '  <Viewpoints Guid="vp-1"><Viewpoint>viewpoint.bcfv</Viewpoint></Viewpoints>',
      '</Markup>',
    ].join('\n');
    const zip = new JSZip();
    zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
    zip.file('topic-1/markup.bcf', markup);
    zip.file('topic-1/viewpoint.bcfv', bcfv);
    const project = await readBCF(await zip.generateAsync({ type: 'arraybuffer' }));
    return Array.from(project.topics.values())[0].viewpoints[0].components;
  }

  it('an IfcGuid carrying an entity decodes, matching what the writer escaped', async () => {
    // `writeComponent` writes `IfcGuid="${escapeXml(...)}"`, so the reader has
    // to decode it or the pair disagrees. A real IFC GUID has no `&`, which is
    // why nothing else here reaches this.
    const out = await readSel('<Component IfcGuid="A &amp; B"/>');
    expect(out?.selection?.[0].ifcGuid).toBe('A & B');
  });

  it('reads no attribute belonging to a CHILD element', async () => {
    const out = await readSel(
      '<Component IfcGuid="G00000000000000000001"><Child OriginatingSystem="fromchild"/></Component>',
    );
    expect(out?.selection?.[0].originatingSystem).toBeUndefined();
  });

  it('does not match an attribute whose name merely ENDS with the one asked for', async () => {
    const out = await readSel('<Component IfcGuid="G00000000000000000001" XAuthoringToolId="sneaky"/>');
    expect(out?.selection?.[0].authoringToolId).toBeUndefined();
  });

  it('an empty value reads as absent whichever spelling carries it', async () => {
    // Three spellings of "nothing" have to agree. The element form used to
    // return '', which survived the identity guard with no identity at all.
    const attr = await readSel('<Component IfcGuid="G00000000000000000001" AuthoringToolId=""/>');
    const elem = await readSel(
      '<Component IfcGuid="G00000000000000000001"><AuthoringToolId></AuthoringToolId></Component>',
    );
    expect(attr?.selection?.[0].authoringToolId).toBeUndefined();
    expect(elem?.selection?.[0].authoringToolId).toBeUndefined();
  });
});

describe('BCF <Visibility> parsing', () => {
  async function readComps(body: string) {
    const bcfv = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<VisualizationInfo Guid="vp-1">',
      `  <Components>${body}</Components>`,
      '</VisualizationInfo>',
    ].join('\n');
    const markup = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Markup>',
      '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open"><Title>t</Title></Topic>',
      '  <Viewpoints Guid="vp-1"><Viewpoint>viewpoint.bcfv</Viewpoint></Viewpoints>',
      '</Markup>',
    ].join('\n');
    const zip = new JSZip();
    zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
    zip.file('topic-1/markup.bcf', markup);
    zip.file('topic-1/viewpoint.bcfv', bcfv);
    const project = await readBCF(await zip.generateAsync({ type: 'arraybuffer' }));
    return Array.from(project.topics.values())[0].viewpoints[0].components;
  }

  it('takes DefaultVisibility from <Visibility>, not from an earlier element', async () => {
    // The attribute was matched against the whole <Components> string, so a
    // DefaultVisibility anywhere ahead of <Visibility> won, and a file saying
    // show-all hid every element.
    const out = await readComps(
      '<Selection><Component IfcGuid="G00000000000000000001" DefaultVisibility="false"/></Selection>'
      + '<Visibility DefaultVisibility="true"></Visibility>',
    );
    expect(out?.visibility?.defaultVisibility).toBe(true);
  });

  it('accepts a self-closing <Visibility/> without discarding the block', async () => {
    // <Exceptions> and <ViewSetupHints> are optional, so this is schema-legal.
    // Matching only the paired form returned undefined for the WHOLE
    // <Components> block, taking the selection with it.
    const out = await readComps(
      '<Selection><Component IfcGuid="G00000000000000000001"/></Selection>'
      + '<Visibility DefaultVisibility="false"/>',
    );
    expect(out?.visibility?.defaultVisibility).toBe(false);
    expect(out?.selection?.length).toBe(1);
  });
});

describe('XML character references decode on the way in', () => {
  it('decodes numeric references, not just the five named entities', async () => {
    // `escapeXml` writes named entities, but other authoring tools emit the
    // numeric forms and both are legal XML. Leaving them encoded put a literal
    // "&#38;" in the data.
    const zip = new JSZip();
    zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
    zip.file('topic-1/markup.bcf', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Markup>',
      '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
      '    <Title>Fire &#38; Smoke &#x3C;Wall&#x3E;</Title>',
      '  </Topic>',
      '</Markup>',
    ].join('\n'));
    const project = await readBCF(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(Array.from(project.topics.values())[0].title).toBe('Fire & Smoke <Wall>');
  });

  it('does not re-scan its own output', async () => {
    // The reason this is one pass. A literal "&lt;" can be written either as
    // "&amp;lt;" or as "&#38;lt;"; decoding the ampersand first and then
    // sweeping again would turn both into "<" and lose the author's text.
    const zip = new JSZip();
    zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
    zip.file('topic-1/markup.bcf', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Markup>',
      '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
      '    <Title>A &amp;lt; B &#38;gt; C</Title>',
      '  </Topic>',
      '</Markup>',
    ].join('\n'));
    const project = await readBCF(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(Array.from(project.topics.values())[0].title).toBe('A &lt; B &gt; C');
  });

  it('leaves an unrecognised or out-of-range reference untouched', async () => {
    // Losing a character is worse than leaving one encoded, when the file came
    // from someone else's tool.
    const zip = new JSZip();
    zip.file('bcf.version', '<?xml version="1.0"?><Version VersionId="2.1"></Version>');
    zip.file('topic-1/markup.bcf', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Markup>',
      '  <Topic Guid="topic-1" TopicType="Issue" TopicStatus="Open">',
      '    <Title>A &# B &#9999999; C</Title>',
      '  </Topic>',
      '</Markup>',
    ].join('\n'));
    const project = await readBCF(await zip.generateAsync({ type: 'arraybuffer' }));
    expect(Array.from(project.topics.values())[0].title).toBe('A &# B &#9999999; C');
  });
});
