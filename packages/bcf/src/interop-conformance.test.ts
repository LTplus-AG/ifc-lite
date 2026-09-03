/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every entry of a PLAIN export must validate against the official BCF XSDs.
 *
 * `schema-validation.test.ts` validates a deliberately maximal fixture, hand
 * built from the `BCFTopic` type. This file validates the archive a user
 * actually gets: one assembled only through the package's public convenience
 * helpers — `createBCFProject`, `createBCFTopic`, `createBCFComment`,
 * `createViewpoint`, `addTopicToProject`, `addCommentToTopic`,
 * `addViewpointToTopic`, `updateTopicStatus` — which is the exact sequence the
 * viewer's BCF panel, the CLI's `clash --bcf`, and the MCP `bcf` tools all
 * follow.
 *
 * That distinction is not cosmetic. The defect this file was written for
 * (issue #3612: BCF exports imported as empty in Solibri, BIMcollab and BIM+)
 * lived in `project.bcfp`, an entry the maximal fixture also produced — but
 * whose 2.1 invalidity had been pinned as an accepted gap rather than fixed,
 * precisely because no test asked "does the file a user downloads validate,
 * end to end, entry by entry?". This one does, and it fails if ANY entry
 * fails, so a violation cannot be scoped away one entry at a time.
 *
 * The same reporter's archive failed validation a second way: `markup.bcf`'s
 * `DueDate` was a bare `YYYY-MM-DD` (what an HTML `<input type="date">`
 * yields, and exactly what `createBCFTopic`'s public `dueDate` option
 * accepts), which `markup.xsd` types `xs:dateTime` — a plain date is not a
 * valid `xs:dateTime`. `plainTopic` below sets `dueDate` to a bare date for
 * that reason: the original fixture never set a due date at all, so it was
 * structurally incapable of observing this.
 *
 * Several `BCFTopic`/`BCFComment`/`BCFViewpoint` fields (`header`, `index`,
 * `stage`, `bimSnippet`, `documentReferences`, `relatedTopics`,
 * `Comment.modifiedDate`/`modifiedAuthor`, `Components.visibility.
 * viewSetupHints`, `lines`, `bitmaps`) have no dedicated option on any of the
 * helpers above -- but every one of them is a plain, publicly-typed field on
 * the object a helper returns, and real production code already sets several
 * of them exactly this way rather than through a helper option:
 * `BCFPanel.tsx` and `useBcfFromChange.ts` both do `topic.header = ...` after
 * `createBCFTopic`; `packages/bcf-api/src/mapping.ts`'s `topicFromApi` sets
 * `index`/`stage`/`bimSnippet` as object-literal fields, its `commentFromApi`
 * sets `modifiedDate`/`modifiedAuthor` the same way, and its
 * `viewpointFromApi` sets `lines`/`clippingPlanes` directly; `visibilityFromDto`
 * builds `viewSetupHints` the same way. `richTopic` below follows that same,
 * already-shipping pattern for those fields (and extends it to
 * `documentReferences`/`relatedTopics`/`bitmaps`, which are mechanically
 * identical plain-field assignments even though no current caller happens to
 * populate them). `ReferenceLink` is the one exception: `markup.xsd` allows it
 * on `Topic`, but `BCFTopic` has no field for it at all, so no amount of
 * helper-shaped construction can reach it -- see the coverage-gap note above
 * `plainExport`.
 *
 * Validation runs against the vendored buildingSMART schemas through
 * `xmllint-wasm` — an authority independent of this codebase's own reader,
 * which is the only kind that can see an interop bug. A write/read round trip
 * through `readBCF` would pass on every one of these files even when no
 * third-party tool can open them.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { validateXML } from 'xmllint-wasm';
import { writeBCF } from './writer.js';
import { createViewpoint } from './viewpoint.js';
import {
  addCommentToTopic,
  addTopicToProject,
  addViewpointToTopic,
  createBCFComment,
  createBCFProject,
  createBCFTopic,
  updateTopicStatus,
} from './index.js';
import type { BCFProject } from './types.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function schema(version: '2.1' | '3.0', file: string): string {
  const dir = version === '2.1' ? 'v2_1' : 'v3_0';
  return readFileSync(path.join(DIR, '__fixtures__', 'schemas', dir, file), 'utf8');
}

/** The XSD that governs each archive entry, keyed by how the entry is named. */
const SCHEMA_FOR_ENTRY: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\/)bcf\.version$/, 'version.xsd'],
  [/(^|\/)project\.bcfp$/, 'project.xsd'],
  [/(^|\/)markup\.bcf$/, 'markup.xsd'],
  [/\.bcfv$/, 'visinfo.xsd'],
];

/**
 * Text that stresses every free-text element/attribute at once: an XML
 * special character in each of the five `escapeXml` handles (`&`, `<`, `>`,
 * `"`, `'`), plus non-ASCII (accented Latin, a German eszett, and CJK) so a
 * writer that assumes single-byte characters or forgets to escape shows up as
 * a schema failure rather than silently mangled text.
 */
const STRESS_TEXT = `Grüße & <critical> "urgent" 'now' — 通風管 café`;

/**
 * Build the archive a user downloads, using only the public helpers (plus the
 * plain-field-assignment pattern real callers already use for fields no
 * helper option reaches -- see the file-level comment above).
 *
 * `plainTopic`'s camera mirrors what the viewer captures: `Camera.getFOV()`
 * returns radians and defaults to `Math.PI / 4`, which `cameraToPerspective`
 * turns into 45 degrees — the exact lower bound of BCF 2.1's `FieldOfView`
 * facet, so this doubles as the boundary case for that range. `richTopic`
 * exercises the rest of what `markup.xsd`/`visinfo.xsd` allow: every optional
 * `Topic`/`Comment`/`Viewpoint` field reachable through a helper option or a
 * plain-field assignment on a helper's return value, two viewpoints (one
 * orthogonal, one perspective) and two comments, and `STRESS_TEXT` in every
 * free-text field.
 *
 * Not reachable at all through any of the above, and therefore NOT attempted
 * here -- see the file-level comment for why each is a coverage gap rather
 * than a bug:
 * - `Topic/ReferenceLink`: `markup.xsd` allows repeated `xs:string` children
 *   before `Title`, but `BCFTopic` has no field for it.
 * - `BCFProject.extensions` (`ProjectExtension/ExtensionSchema`'s referent):
 *   `createBCFProject` takes no `extensions` option, and `writer.ts` never
 *   serializes `BCFProject.extensions` even when set by hand -- `project.bcfp`
 *   always emits an empty `<ExtensionSchema/>` (see `writeProjectFile`).
 */
function plainExport(version: '2.1' | '3.0'): BCFProject {
  const project = createBCFProject({ name: `Coordination ${STRESS_TEXT}`, version });

  const plainTopic = createBCFTopic({
    title: 'Duct clashes with beam at grid B/3',
    description: 'The supply duct passes through the beam web.',
    author: 'reporter@example.invalid',
    // Bare date, not a full xs:dateTime -- see the file-level comment above.
    dueDate: '2026-10-16',
  });
  addTopicToProject(project, plainTopic);
  addCommentToTopic(
    plainTopic,
    createBCFComment({ author: 'reviewer@example.invalid', comment: 'Reroute below the beam.' })
  );
  // addCommentToTopic just set topic.modifiedDate from the wall clock (a
  // valid xs:dateTime); topic.modifiedAuthor is left unset deliberately so
  // the writer's own fallback to creationAuthor stays covered (richTopic
  // below covers the non-fallback branch via updateTopicStatus).
  addViewpointToTopic(
    plainTopic,
    createViewpoint({
      camera: {
        position: { x: 12.5, y: 8.25, z: 3.75 },
        target: { x: 0, y: 1.5, z: 0 },
        up: { x: 0, y: 1, z: 0 },
        fov: Math.PI / 4,
        isOrthographic: false,
      },
      // The user's report singles out selected objects by GUID; a viewpoint
      // with no selection could not show them going missing.
      selectedGuids: ['0GbQ8$mZH4$8dFR$JUFRuF', '1kTvXnbbzCWw8lcMd1dR4o'],
      snapshot: 'data:image/png;base64,iVBORw0KGgo=',
    })
  );
  // `topic.header` (source IFC files) has no createBCFTopic option; set
  // directly, mirroring `BCFPanel.tsx`/`useBcfFromChange.ts`'s
  // `topic.header = header`. Two entries so both `isExternal` states (the
  // explicit `true` and the writer's default) get an entry each.
  plainTopic.header = [
    {
      ifcProject: '3ZpjZ0Ban1$hVDaAmsCwSK',
      ifcSpatialStructureElement: '1kTvXnbbzCWw8lcMd1dR4o',
      isExternal: true,
      filename: `model ${STRESS_TEXT}.ifc`,
      date: '2026-01-01T00:00:00Z',
      reference: 'https://example.invalid/model.ifc',
    },
    // Minimal entry -- no filename/date/reference, isExternal left unset so
    // the writer's own default (true) is what gets validated.
    { ifcProject: '0GbQ8$mZH4$8dFR$JUFRuF' },
  ];

  const richTopic = createBCFTopic({
    title: STRESS_TEXT,
    description: STRESS_TEXT,
    author: 'reporter2@example.invalid',
    topicType: 'Clash',
    topicStatus: 'In Progress',
    priority: 'Low',
    // UserIdType is an unrestricted xs:string in 2.1, so a display-name-plus-
    // email author is schema-valid; stresses escaping in an Author-typed
    // field too, not just Title/Description/Comment/Labels.
    assignedTo: `${STRESS_TEXT} <assignee@example.invalid>`,
    // Already-valid xs:dateTime this time, complementing plainTopic's bare
    // date -- covers normalizeXsdDateTime's pass-through-unchanged branch.
    dueDate: '2026-11-20T09:00:00Z',
    labels: [STRESS_TEXT, 'second-label'],
  });
  addTopicToProject(project, richTopic);

  // `index`/`stage`/`bimSnippet` have no createBCFTopic option; set directly,
  // mirroring `mapping.ts`'s `topicFromApi`, which builds a BCFTopic object
  // literal with exactly these three as plain fields.
  richTopic.index = 3;
  richTopic.stage = STRESS_TEXT;
  richTopic.bimSnippet = {
    snippetType: 'JSON',
    isExternal: false,
    reference: 'snippet.json',
    referenceSchema: 'https://example.invalid/snippet-schema.json',
  };
  // `documentReferences`/`relatedTopics` have no helper option either; same
  // plain-field-assignment pattern (no current real caller happens to set
  // these two, but the mechanism is identical to `header`/`bimSnippet` above
  // -- see the file-level comment).
  richTopic.documentReferences = [
    {
      guid: '22222222-2222-4222-8222-222222222222',
      isExternal: true,
      referencedDocument: 'https://example.invalid/referenced-document.pdf',
      description: STRESS_TEXT,
    },
    // isExternal omitted -- covers the writer's `?? false` default.
    { referencedDocument: 'local-doc.pdf' },
  ];
  richTopic.relatedTopics = [plainTopic.guid];

  addCommentToTopic(
    richTopic,
    createBCFComment({ author: 'reviewer2@example.invalid', comment: STRESS_TEXT })
  );
  const secondComment = createBCFComment({
    author: 'reviewer3@example.invalid',
    comment: 'Second comment, referencing the orthogonal viewpoint.',
  });
  // `Comment.modifiedDate`/`modifiedAuthor` have no createBCFComment option;
  // set directly, mirroring `mapping.ts`'s `commentFromApi`, which builds a
  // BCFComment object literal with both as plain fields.
  secondComment.modifiedDate = '2026-01-06T07:08:09Z';
  secondComment.modifiedAuthor = 'comment-modifier@example.invalid';
  addCommentToTopic(richTopic, secondComment);

  // `updateTopicStatus` is itself a public helper, and it is the one that
  // sets `modifiedAuthor` explicitly -- the non-fallback branch `plainTopic`
  // above deliberately leaves uncovered.
  updateTopicStatus(richTopic, 'Closed', 'closer@example.invalid');

  const orthoViewpoint = createViewpoint({
    camera: {
      position: { x: -4, y: 6, z: 2 },
      target: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      fov: Math.PI / 3,
      isOrthographic: true,
      orthoScale: 5.5,
    },
    sectionPlane: { axis: 'down', position: 40, enabled: true, flipped: false },
    bounds: { min: { x: -10, y: -10, z: -10 }, max: { x: 10, y: 10, z: 10 } },
    // Normal mode: default-visible, exceptions hidden.
    hiddenGuids: ['0GbQ8$mZH4$8dFR$JUFRuF'],
    coloredGuids: [{ color: 'FF00FF00', guids: ['1kTvXnbbzCWw8lcMd1dR4o'] }],
    snapshot: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
  });
  addViewpointToTopic(richTopic, orthoViewpoint);
  secondComment.viewpointGuid = orthoViewpoint.guid;

  const perspectiveViewpoint = createViewpoint({
    camera: {
      position: { x: 3, y: 1, z: -2 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      // 50 degrees -- inside 2.1's [45, 60] FieldOfView facet, distinct from
      // plainTopic's 45-degree boundary case. (writer-camera.ts deliberately
      // does not enforce this facet on write -- see requireFieldOfViewElement
      // -- so a real caller's FOV can legitimately land outside it; this
      // fixture stays inside the range on purpose, to validate a realistic
      // export rather than trip an already-documented, intentional gap.)
      fov: Math.PI / 3.6,
      isOrthographic: false,
    },
    // Isolation mode: default-hidden, exceptions visible.
    visibleGuids: ['3ZpjZ0Ban1$hVDaAmsCwSK'],
    snapshotData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });
  // `lines`/`bitmaps`/`Components.visibility.viewSetupHints` have no
  // createViewpoint option; set directly. `viewSetupHints` and `lines` mirror
  // `mapping.ts`'s `visibilityFromDto`/`viewpointFromApi`; `bitmaps` is the
  // same plain-field-assignment mechanism with no current real caller (see
  // the file-level comment).
  perspectiveViewpoint.lines = [
    { startPoint: { x: 1, y: 2, z: 3 }, endPoint: { x: 4, y: 5, z: 6 } },
  ];
  perspectiveViewpoint.bitmaps = [
    {
      format: 'PNG',
      reference: 'bitmap.png',
      location: { x: 10, y: 11, z: 12 },
      normal: { x: 0, y: 0, z: 1 },
      up: { x: 0, y: 1, z: 0 },
      height: 2.5,
    },
  ];
  if (perspectiveViewpoint.components?.visibility) {
    perspectiveViewpoint.components.visibility.viewSetupHints = {
      spacesVisible: true,
      spaceBoundariesVisible: false,
      openingsVisible: true,
    };
  }
  addViewpointToTopic(richTopic, perspectiveViewpoint);

  return project;
}

async function entriesOf(project: BCFProject): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(await (await writeBCF(project)).arrayBuffer());
  const out = new Map<string, string>();
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    if (SCHEMA_FOR_ENTRY.some(([re]) => re.test(name))) {
      out.set(name, await zip.files[name].async('string'));
    }
  }
  return out;
}

/**
 * 2.1 only, and that is the point rather than a shortcut: `createBCFProject`
 * defaults to 2.1 and every caller in this repository takes that default, so
 * 2.1 is the archive users actually get. A plain 3.0 export cannot even be
 * built through these helpers today — 3.0's `visinfo.xsd` requires
 * `AspectRatio` on both camera types, `ViewerCameraState` carries none, so
 * `createViewpoint` produces a camera the writer refuses (deliberately) rather
 * than emitting an invalid archive. `schema-validation.test.ts` covers 3.0
 * from a hand-built fixture that supplies the field.
 */
describe('a plainly-exported archive validates entry by entry', () => {
  for (const version of ['2.1'] as const) {
    it(`BCF ${version}`, async () => {
      const entries = await entriesOf(plainExport(version));

      // Guard against a vacuous pass: an export that stopped emitting
      // project.bcfp, or a topic's markup.bcf/viewpoints, would otherwise
      // validate trivially. plainExport writes two topics -- plainTopic (one
      // viewpoint) and richTopic (two) -- so two markup.bcf entries and three
      // .bcfv entries are expected, not merely "at least one".
      const kinds = [...entries.keys()].map((n) => n.replace(/^[^/]+\//, ''));
      expect(kinds).toContain('bcf.version');
      expect(kinds).toContain('project.bcfp');
      expect(kinds.filter((n) => n === 'markup.bcf')).toHaveLength(2);
      expect(kinds.filter((n) => n.endsWith('.bcfv'))).toHaveLength(3);

      // Collect every entry's verdict before asserting, so one failure does
      // not hide the others — three tools rejecting an archive is rarely one
      // violation, and a per-entry `expect` would only ever show the first.
      const failures: string[] = [];
      for (const [name, xml] of entries) {
        const xsd = SCHEMA_FOR_ENTRY.find(([re]) => re.test(name))![1];
        const result = await validateXML({
          // xmllint reads a leading dash as a flag and the real entry names
          // contain `/`; a fixed inert name keeps both out of the argv.
          xml: [{ fileName: 'subject.xml', contents: xml }],
          schema: [schema(version, xsd)],
          // No preload needed: this sweep is 2.1-only (see the block comment
          // above), and 2.1's schemas are self-contained. A 3.0 archive would
          // need shared-types.xsd preloaded for its cross-schema references;
          // `schema-validation.test.ts` covers that case.
          preload: [],
        });
        if (!result.valid) {
          failures.push(`${name} [${xsd}]: ${result.errors.map((e) => e.message).join(' | ')}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
