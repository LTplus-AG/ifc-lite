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
