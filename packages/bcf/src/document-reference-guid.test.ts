/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `DocumentReference/@Guid` is OPTIONAL in BCF 2.1 and REQUIRED in BCF 3.0.
 *
 * 2.1's markup.xsd declares it `<xs:attribute name="Guid" type="Guid"/>` with
 * no `use`, i.e. optional; 3.0's `DocumentReferenceAttributes` declares the
 * same attribute `use="required"`. `BCFDocumentReference.guid` is optional to
 * match 2.1, and the writer omitted the attribute whenever it was unset — so
 * any 3.0 topic carrying a document reference without one produced a
 * `markup.bcf` that fails validation ("The attribute 'Guid' is required but
 * missing"), and `markup.bcf` IS the issue: a viewer that rejects it drops
 * the topic entirely (#3612).
 *
 * The remedy is to mint one rather than to refuse. A `DocumentReference`
 * guid names only itself — nothing else in the archive refers to it, unlike
 * `RelatedTopic/@Guid` or `Comment/Viewpoint/@Guid` — so a generated value
 * loses nothing. Refusing, the policy used for `AspectRatio` and `TopicType`,
 * is wrong here: those assert something about the view or the issue that only
 * the caller knows, and refusing would fail the whole export over a field 2.1
 * says is optional.
 *
 * The minted value must be DERIVED, not random. `generateUuid()` would make
 * two exports of one unchanged project differ in bytes, which breaks the
 * `bcfzip` diffing and content-addressing that a stable export supports, and
 * it would silently mint a THIRD identity on the next write because the value
 * was never written back. `uuidFromSeed` (shared with `@ifc-lite/clash`, which
 * anchors its topic guids the same way) makes the guid a pure function of the
 * topic, the document it points at, and its position, and the writer stores it
 * back on the object so the in-memory project matches the file.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { validateXML } from 'xmllint-wasm';
import { isValidUuid, uuidFromSeed } from '@ifc-lite/encoding';
import { writeBCF } from './writer.js';
import type { BCFDocumentReference, BCFProject } from './types.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function schema(version: '2.1' | '3.0', file: string): string {
  const dir = version === '2.1' ? 'v2_1' : 'v3_0';
  return readFileSync(path.join(DIR, '__fixtures__', 'schemas', dir, file), 'utf8');
}

const TOPIC_GUID = '11111111-1111-4111-8111-111111111111';

function projectWith(
  version: '2.1' | '3.0',
  documentReferences: BCFDocumentReference[]
): BCFProject {
  return {
    version,
    projectId: '99999999-9999-4999-8999-999999999999',
    topics: new Map([
      [
        TOPIC_GUID,
        {
          guid: TOPIC_GUID,
          title: 'Topic with an attached document',
          topicType: 'Issue',
          topicStatus: 'Open',
          creationDate: '2026-01-02T03:04:05Z',
          creationAuthor: 'author@example.invalid',
          documentReferences,
          comments: [],
          viewpoints: [],
        },
      ],
    ]),
  };
}

async function markupOf(project: BCFProject): Promise<string> {
  const zip = await JSZip.loadAsync(Buffer.from(await (await writeBCF(project)).arrayBuffer()));
  const name = Object.keys(zip.files).find((n) => n.endsWith('markup.bcf'))!;
  return zip.files[name].async('string');
}


async function markupErrors(version: '2.1' | '3.0', xml: string): Promise<string[]> {
  const result = await validateXML({
    xml: [{ fileName: 'subject.xml', contents: xml }],
    schema: [schema(version, 'markup.xsd')],
    preload:
      version === '3.0'
        ? [{ fileName: 'shared-types.xsd', contents: schema('3.0', 'shared-types.xsd') }]
        : [],
  });
  return result.valid ? [] : result.errors.map((e) => e.message);
}

const DOC_URL = 'https://example.invalid/spec.pdf';

/**
 * No `guid` — what a caller writing to the 2.1-shaped optional field gives.
 *
 * A FACTORY, not a shared constant: the 3.0 writer stores the guid it minted
 * back onto the object, so a shared literal would carry one test's guid into
 * the next and quietly turn every later assertion into a check of the FIRST
 * write. That is the fixture confound, not a defect in the write-back.
 */
function withoutGuid(): BCFDocumentReference {
  return { isExternal: true, url: DOC_URL, description: 'Cladding specification' };
}

const CALLER_GUID = '33333333-3333-4333-8333-333333333333';

describe('DocumentReference/@Guid', () => {
  it('is supplied for BCF 3.0 when the caller left it unset', async () => {
    const xml = await markupOf(projectWith('3.0', [withoutGuid()]));
    const guid = /<DocumentReference Guid="([^"]+)"/.exec(xml)?.[1];
    expect(guid, 'BUG: 3.0 requires the attribute and the writer omitted it').toBeTruthy();
    expect(isValidUuid(guid!), `generated guid ${guid} must satisfy the schema Guid type`).toBe(
      true
    );
    expect(await markupErrors('3.0', xml)).toEqual([]);
  });

  it('keeps the caller\'s own guid rather than overwriting it', async () => {
    const xml = await markupOf(projectWith('3.0', [{ ...withoutGuid(), guid: CALLER_GUID }]));
    expect(xml).toContain(`<DocumentReference Guid="${CALLER_GUID}"`);
    expect(await markupErrors('3.0', xml)).toEqual([]);
  });

  /**
   * Two references in one topic must not collide: a single generated guid
   * reused for both would still validate against the attribute's type, and
   * would still be wrong.
   */
  it('gives two guid-less references distinct guids', async () => {
    const xml = await markupOf(
      projectWith('3.0', [withoutGuid(), { ...withoutGuid(), description: 'Second document' }])
    );
    const guids = [...xml.matchAll(/<DocumentReference Guid="([^"]+)"/g)].map((m) => m[1]);
    expect(guids).toHaveLength(2);
    expect(new Set(guids).size).toBe(2);
    expect(await markupErrors('3.0', xml)).toEqual([]);
  });

  /**
   * 2.1 keeps the attribute optional. Emitting a fabricated guid there would
   * put an identifier the caller never chose into the file a user downloads,
   * for no schema reason — and would make this fix invisible to a reader
   * trying to tell the two versions apart.
   */
  /**
   * Two exports of one unchanged project must be byte-identical here. A random
   * `generateUuid()` passes every other test in this file and still fails
   * this one, which is the whole reason it exists.
   */
  it('is stable across two writes of the same project', async () => {
    const project = projectWith('3.0', [withoutGuid()]);
    const first = await markupOf(project);
    const second = await markupOf(project);
    const line = (xml: string) => /<DocumentReference Guid="[^"]+"/.exec(xml)![0];
    expect(line(second)).toBe(line(first));
  });

  /**
   * ...and across two SEPARATE project objects built the same way, not merely
   * across two writes of one object. Writing the guid back onto `docRef` alone
   * would satisfy the test above while still minting a fresh identifier for
   * every fresh in-memory project, so a second export from a reloaded file
   * would differ.
   */
  it('is a pure function of the topic, the document and the position', async () => {
    const a = await markupOf(projectWith('3.0', [withoutGuid()]));
    const b = await markupOf(projectWith('3.0', [withoutGuid()]));
    const guidOf = (xml: string) => /<DocumentReference Guid="([^"]+)"/.exec(xml)![1];
    expect(guidOf(b)).toBe(guidOf(a));
    expect(guidOf(a)).toBe(
      uuidFromSeed(`${TOPIC_GUID}|${DOC_URL}|0`)
    );
  });

  /**
   * A different document under the same topic, and the same document under a
   * different topic, must both land on different guids -- otherwise the seed
   * is ignoring an input and every reference in a project could collide.
   */
  it('separates references that differ in topic, document or position', async () => {
    const other = { ...withoutGuid(), url: 'https://example.invalid/other.pdf' };
    const guidsOf = (xml: string) =>
      [...xml.matchAll(/<DocumentReference Guid="([^"]+)"/g)].map((m) => m[1]);

    const twoDocs = guidsOf(await markupOf(projectWith('3.0', [withoutGuid(), other])));
    expect(new Set(twoDocs).size).toBe(2);

    // Same document twice under one topic: only the index differs.
    const sameDocTwice = guidsOf(await markupOf(projectWith('3.0', [withoutGuid(), withoutGuid()])));
    expect(new Set(sameDocTwice).size).toBe(2);

    const otherTopic = projectWith('3.0', [withoutGuid()]);
    const topic = otherTopic.topics.get(TOPIC_GUID)!;
    otherTopic.topics.delete(TOPIC_GUID);
    topic.guid = '44444444-4444-4444-8444-444444444444';
    otherTopic.topics.set(topic.guid, topic);
    expect(guidsOf(await markupOf(otherTopic))[0]).not.toBe(twoDocs[0]);
  });

  /**
   * The writer stores what it wrote back on the object, so the in-memory
   * project is not left claiming a reference has no guid while the file on
   * disk says otherwise.
   */
  it('writes the minted guid back onto the caller\'s document reference', async () => {
    const docRef = withoutGuid();
    const project = projectWith('3.0', [docRef]);
    expect(docRef.guid, 'fixture sanity: unset before the write').toBeUndefined();
    const xml = await markupOf(project);
    expect(docRef.guid).toBeTruthy();
    expect(xml).toContain(`<DocumentReference Guid="${docRef.guid}"`);
  });

  /**
   * 2.1 mints nothing, so it must not acquire a guid by the write-back either.
   */
  it('leaves the caller\'s object untouched for BCF 2.1', async () => {
    const docRef = withoutGuid();
    await markupOf(projectWith('2.1', [docRef]));
    expect(docRef.guid).toBeUndefined();
  });

  it('is left absent for BCF 2.1, whose schema makes it optional', async () => {
    const xml = await markupOf(projectWith('2.1', [withoutGuid()]));
    expect(xml).toContain('<DocumentReference isExternal="true">');
    expect(xml).not.toMatch(/<DocumentReference Guid=/);
    expect(await markupErrors('2.1', xml)).toEqual([]);
  });
});
