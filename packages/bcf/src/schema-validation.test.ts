/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Validate real `.bcfzip` output against buildingSMART's official BCF XSDs.
 *
 * Every other test in this package is `parse(write(x)) === x`. That check is
 * blind by construction: it can see neither a field both sides get wrong the
 * same way, nor one that no fixture populates. The writer and the reader agree
 * with each other, not with the format — which is how, for example, a
 * `<Bitmaps>` wrapper that does not exist in BCF 2.1 round-tripped perfectly
 * for as long as it did.
 *
 * The schemas in `__fixtures__/schemas/` are verbatim copies of the published
 * BCF-XML schemas (see the `UPSTREAM_LICENSE` beside them). They are an
 * authority independent of this codebase, so they can catch what a round trip
 * cannot. Validation runs through `xmllint-wasm`, a WebAssembly build of
 * libxml2 with no native dependencies and no network access.
 *
 * The fixture below is deliberately maximal: every optional field is populated,
 * every position gets a DISTINCT value (so a writer that swaps two fields is
 * visible), and the cameras sit on a schema boundary. An empty or symmetric
 * fixture cannot observe most of what this file is here to check.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { validateXML } from 'xmllint-wasm';
import { writeBCF } from './writer.js';
import { readBCF } from './reader.js';
import type { BCFProject, BCFTopic, BCFViewpoint } from './types.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

function schema(version: '2.1' | '3.0', file: string): string {
  const dir = version === '2.1' ? 'v2_1' : 'v3_0';
  return readFileSync(path.join(DIR, '__fixtures__', 'schemas', dir, file), 'utf8');
}

/**
 * BCF 3.0 splits its schemas across files and pulls the shared simple types in
 * with `<xs:include schemaLocation="shared-types.xsd"/>`. xmllint resolves that
 * against its in-memory filesystem, so the include target has to be preloaded
 * under exactly that name. BCF 2.1 is self-contained and needs nothing.
 */
function preloadFor(version: '2.1' | '3.0') {
  return version === '3.0'
    ? [{ fileName: 'shared-types.xsd', contents: schema('3.0', 'shared-types.xsd') }]
    : [];
}

async function validate(
  version: '2.1' | '3.0',
  xsd: string,
  xml: string
): Promise<{ valid: boolean; messages: string[] }> {
  const result = await validateXML({
    // xmllint treats a leading dash as a CLI flag, and the archive's real entry
    // names contain `/`; a fixed inert name keeps both out of the argv.
    xml: [{ fileName: 'subject.xml', contents: xml }],
    schema: [schema(version, xsd)],
    preload: preloadFor(version),
  });
  return { valid: result.valid, messages: result.errors.map((e) => e.message) };
}

/** The XSD that governs each archive entry, keyed by how the entry is named. */
const SCHEMA_FOR_ENTRY: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\/)bcf\.version$/, 'version.xsd'],
  [/(^|\/)project\.bcfp$/, 'project.xsd'],
  [/(^|\/)markup\.bcf$/, 'markup.xsd'],
  [/\.bcfv$/, 'visinfo.xsd'],
];

const TOPIC_GUID = '11111111-1111-4111-8111-111111111111';
const VIEWPOINT_GUID = '55555555-5555-4555-8555-555555555555';

/**
 * A topic with every optional field set and no two positions sharing a value.
 *
 * The distinctness matters: with `{x:0,y:0,z:0}` points, or one label, or a
 * creation author equal to the modified author, a writer that transposed two
 * fields would still round-trip and still validate.
 */
function maximalTopic(): BCFTopic {
  return {
    guid: TOPIC_GUID,
    title: 'Maximal topic',
    description: 'Description distinct from the title',
    topicType: 'Issue',
    topicStatus: 'Open',
    priority: 'High',
    index: 7,
    creationDate: '2026-01-02T03:04:05Z',
    creationAuthor: 'creation-author@example.invalid',
    modifiedDate: '2026-02-03T04:05:06Z',
    modifiedAuthor: 'modified-author@example.invalid',
    dueDate: '2026-03-04T05:06:07Z',
    assignedTo: 'assigned-to@example.invalid',
    stage: 'Design',
    // Two labels, so a writer that emits the wrong container shape (one
    // `<Labels>` per label vs. one `<Labels>` holding `<Label>` children)
    // is distinguishable from a writer that emits the right one.
    labels: ['label-one', 'label-two'],
    bimSnippet: {
      snippetType: 'JSON',
      isExternal: false,
      reference: 'snippet.json',
      referenceSchema: 'https://example.invalid/snippet-schema.json',
    },
    documentReferences: [
      {
        guid: '22222222-2222-4222-8222-222222222222',
        isExternal: true,
        referencedDocument: 'https://example.invalid/referenced-document.pdf',
        url: 'https://example.invalid/url-document.pdf',
        description: 'document reference description',
      },
    ],
    relatedTopics: ['33333333-3333-4333-8333-333333333333'],
    header: [
      {
        ifcProject: '3ZpjZ0Ban1$hVDaAmsCwSK',
        ifcSpatialStructureElement: '1kTvXnbbzCWw8lcMd1dR4o',
        isExternal: true,
        filename: 'model.ifc',
        date: '2026-01-01T00:00:00Z',
        reference: 'https://example.invalid/model.ifc',
      },
    ],
    comments: [
      {
        guid: '44444444-4444-4444-8444-444444444444',
        date: '2026-01-05T06:07:08Z',
        author: 'comment-author@example.invalid',
        comment: 'Comment text',
        viewpointGuid: VIEWPOINT_GUID,
        modifiedDate: '2026-01-06T07:08:09Z',
        modifiedAuthor: 'comment-modifier@example.invalid',
      },
    ],
    viewpoints: [
      {
        guid: VIEWPOINT_GUID,
        perspectiveCamera: {
          // Distinct, non-symmetric vectors: a transposed X/Y/Z is visible.
          cameraViewPoint: { x: 1.5, y: 2.5, z: 3.5 },
          cameraDirection: { x: 0, y: 0, z: -1 },
          cameraUpVector: { x: 0, y: 1, z: 0 },
          // BOUNDARY CASE. BCF 2.1's `FieldOfView` is `[45, 60]` inclusive;
          // BCF 3.0 widened it to `(0, 180)` exclusive. 60 is the exact 2.1
          // maximum, so this pins the edge that is legal in both.
          fieldOfView: 60,
          // Required in BCF 3.0, absent from the 2.1 schema entirely.
          aspectRatio: 1.5,
        },
        lines: [
          { startPoint: { x: 1, y: 2, z: 3 }, endPoint: { x: 4, y: 5, z: 6 } },
        ],
        clippingPlanes: [
          { location: { x: 7, y: 8, z: 9 }, direction: { x: 1, y: 0, z: 0 } },
        ],
        bitmaps: [
          {
            format: 'PNG',
            reference: 'bitmap.png',
            location: { x: 10, y: 11, z: 12 },
            normal: { x: 0, y: 0, z: 1 },
            up: { x: 0, y: 1, z: 0 },
            height: 2.5,
          },
        ],
        components: {
          selection: [
            {
              ifcGuid: '0GbQ8$mZH4$8dFR$JUFRuF',
              authoringToolId: 'authoring-tool-id',
              originatingSystem: 'Originating System',
            },
          ],
          visibility: {
            // `false` rather than the `true` default, so a writer that drops
            // the attribute and relies on the schema default is caught.
            defaultVisibility: false,
            exceptions: [{ ifcGuid: '1kTvXnbbzCWw8lcMd1dR4o' }],
            // Each hint a different value: a writer that emits one attribute's
            // value under another attribute's name cannot hide.
            viewSetupHints: {
              spacesVisible: true,
              spaceBoundariesVisible: false,
              openingsVisible: true,
            },
          },
          coloring: [
            {
              color: 'FF0000FF',
              components: [{ ifcGuid: '3ZpjZ0Ban1$hVDaAmsCwSK' }],
            },
          ],
        },
      },
    ],
  };
}

function maximalProject(version: '2.1' | '3.0'): BCFProject {
  return {
    version,
    projectId: '66666666-6666-4666-8666-666666666666',
    name: 'Schema validation project',
    topics: new Map([[TOPIC_GUID, maximalTopic()]]),
  };
}

/** Write a project and return its archive entries as `{ name: xml }`. */
async function writeAndUnzip(project: BCFProject): Promise<Map<string, string>> {
  const blob = await writeBCF(project);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const out = new Map<string, string>();
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    if (SCHEMA_FOR_ENTRY.some(([re]) => re.test(name))) {
      out.set(name, await entry.async('string'));
    }
  }
  return out;
}

describe('BCF output validates against the official buildingSMART XSDs', () => {
  for (const version of ['2.1', '3.0'] as const) {
    describe(`BCF ${version}`, () => {
      it('writes every archive entry the schemas govern', async () => {
        const entries = await writeAndUnzip(maximalProject(version));
        const names = [...entries.keys()].sort();
        // If the writer stops emitting one of these, the per-entry validation
        // below would vacuously pass on the ones that remain.
        expect(names).toEqual([
          `${TOPIC_GUID}/Viewpoint_${VIEWPOINT_GUID}.bcfv`,
          `${TOPIC_GUID}/markup.bcf`,
          'bcf.version',
          'project.bcfp',
        ]);
      });

      it('emits a schema-valid project.bcfp', async () => {
        const entries = await writeAndUnzip(maximalProject(version));
        const { valid, messages } = await validate(
          version,
          'project.xsd',
          entries.get('project.bcfp')!
        );
        expect(messages).toEqual([]);
        expect(valid).toBe(true);
      });

      it('emits a schema-valid bcf.version', async () => {
        const entries = await writeAndUnzip(maximalProject(version));
        const { valid, messages } = await validate(
          version,
          'version.xsd',
          entries.get('bcf.version')!
        );
        expect(messages).toEqual([]);
        expect(valid).toBe(true);
      });

      it('emits a schema-valid markup.bcf', async () => {
        const entries = await writeAndUnzip(maximalProject(version));
        const { valid, messages } = await validate(
          version,
          'markup.xsd',
          entries.get(`${TOPIC_GUID}/markup.bcf`)!
        );
        expect(messages).toEqual([]);
        expect(valid).toBe(true);
      });

      it('emits a schema-valid viewpoint (.bcfv)', async () => {
        const entries = await writeAndUnzip(maximalProject(version));
        const { valid, messages } = await validate(
          version,
          'visinfo.xsd',
          entries.get(`${TOPIC_GUID}/Viewpoint_${VIEWPOINT_GUID}.bcfv`)!
        );
        expect(messages).toEqual([]);
        expect(valid).toBe(true);
      });
    });
  }

  /**
   * The 2.1 half of this used to be pinned as a KNOWN GAP: `<ExtensionSchema>`
   * (an `xs:anyURI`, required by 2.1's `project.xsd` because it carries no
   * `minOccurs`) was not emitted at all, so every 2.1 archive this package
   * writes — which is every archive `createBCFProject` produces, and so
   * everything the viewer, `@ifc-lite/cli` and `@ifc-lite/mcp` write — shipped
   * a `project.bcfp` that failed validation with "Element 'ProjectExtension':
   * Missing child element(s). Expected is ( ExtensionSchema )". It is now
   * emitted empty; see `writeProjectFile` for why empty rather than a name.
   *
   * This asserts the shape, not just validity, so a future writer cannot make
   * the file validate by dropping `<Project>` instead (2.1 marks `<Project>`
   * `minOccurs="0"`, so a file with only `<ExtensionSchema>` also validates).
   */
  it('emits the 2.1-required <ExtensionSchema>, empty, after <Project>', async () => {
    const entries = await writeAndUnzip(maximalProject('2.1'));
    const bcfp = entries.get('project.bcfp')!;
    expect(bcfp).toContain('<Project ProjectId="');
    expect(bcfp).toContain('<ExtensionSchema/>');
    expect(bcfp.indexOf('</Project>')).toBeLessThan(bcfp.indexOf('<ExtensionSchema/>'));
  });

  /**
   * The control, running the rule the other way: 3.0's `project.xsd` has no
   * `ProjectExtension`/`ExtensionSchema` concept at all — `<ProjectInfo>` is
   * exactly one `<Project>` — so emitting the 2.1 element there would trade
   * one violation for another.
   */
  it('does not emit <ExtensionSchema> for BCF 3.0, whose schema has no such element', async () => {
    const entries = await writeAndUnzip(maximalProject('3.0'));
    expect(entries.get('project.bcfp')!).not.toContain('ExtensionSchema');
  });
});

/**
 * `AspectRatio` is the field neither side handled.
 *
 * BCF 3.0's `visinfo.xsd` makes it REQUIRED on both camera types. Before this
 * change the writer never emitted it and the reader never parsed it, and no
 * fixture set it — so a `parse(write(x)) === x` check saw a faithful round trip
 * of a value that simply did not exist, while every 3.0 archive we produced was
 * invalid. Nothing in this repository populates `aspectRatio` even now
 * (`ViewerCameraState` carries no aspect ratio, so `cameraToPerspective` and
 * `cameraToOrthogonal` cannot supply one), which is exactly why the round trip
 * could never have caught it.
 */
describe('BCF 3.0 AspectRatio', () => {
  it('survives a write/read round trip on both camera types', async () => {
    // Distinct values per camera, and neither is 1 — a writer or reader that
    // dropped the field and defaulted to a square viewport would still pass a
    // test that used 1, and a writer that read one camera's value while
    // writing the other's would pass a test that used the same number twice.
    //
    // The two cameras go in SEPARATE 3.0 projects. They used to share one
    // viewpoint, which round-tripped perfectly and was schema-invalid the
    // whole time: 3.0's visinfo.xsd declares the cameras as an `xs:choice`,
    // so a viewpoint carries exactly one. See "BCF camera cardinality and
    // order" below.
    async function roundTrip(mutate: (topic: BCFTopic) => void): Promise<BCFViewpoint> {
      const topic = maximalTopic();
      mutate(topic);
      const project: BCFProject = {
        version: '3.0',
        projectId: '66666666-6666-4666-8666-666666666666',
        name: 'Aspect ratio project',
        topics: new Map([[TOPIC_GUID, topic]]),
      };
      const blob = await writeBCF(project);
      const readBack = await readBCF(new Uint8Array(await blob.arrayBuffer()));
      return readBack.topics.get(TOPIC_GUID)!.viewpoints[0];
    }

    const perspective = await roundTrip((topic) => {
      topic.viewpoints[0].perspectiveCamera!.aspectRatio = 1.7777;
    });
    expect(perspective.perspectiveCamera?.aspectRatio).toBe(1.7777);

    const orthogonal = await roundTrip((topic) => {
      delete topic.viewpoints[0].perspectiveCamera;
      topic.viewpoints[0].orthogonalCamera = {
        cameraViewPoint: { x: 20, y: 21, z: 22 },
        cameraDirection: { x: 0, y: 0, z: -1 },
        cameraUpVector: { x: 0, y: 1, z: 0 },
        viewToWorldScale: 12.5,
        aspectRatio: 2.3333,
      };
    });
    expect(orthogonal.orthogonalCamera?.aspectRatio).toBe(2.3333);
  });

  it('refuses to write a 3.0 camera without one rather than emitting an invalid archive', async () => {
    const topic = maximalTopic();
    delete topic.viewpoints[0].perspectiveCamera!.aspectRatio;
    const project: BCFProject = {
      version: '3.0',
      topics: new Map([[TOPIC_GUID, topic]]),
    };
    await expect(writeBCF(project)).rejects.toThrow(/AspectRatio/);
  });

  it('is not emitted for BCF 2.1, whose schema has no such element', async () => {
    const entries = await writeAndUnzip(maximalProject('2.1'));
    // The 2.1 fixture DOES set `aspectRatio` (see maximalTopic), so this
    // distinguishes "correctly suppressed for 2.1" from "never written".
    expect(entries.get(`${TOPIC_GUID}/Viewpoint_${VIEWPOINT_GUID}.bcfv`)).not.toContain(
      'AspectRatio'
    );
  });
});

/**
 * `FieldOfView` is a facet-bearing simple type in BOTH versions -- v3_0/visinfo.xsd
 * restricts it to `(0, 180)` exclusive -- yet, unlike `AspectRatio` right above,
 * nothing on the write side ever checked the facet. "rejects a value outside a
 * schema facet range" above only proves xmllint itself enforces the range on
 * hand-mutated XML; it never asks the writer to refuse the value in the first
 * place, so `writeBCF` happily emitted `<FieldOfView>0</FieldOfView>` or
 * `<FieldOfView>200</FieldOfView>` -- a finite, well-formed `xs:double` that
 * every other guard in this file (`xsdDouble`, the non-finite sweep) waves
 * through, and that a 3.0 archive fails schema validation for. Same policy as
 * `requireAspectRatioElement`: refuse rather than silently emit an archive a
 * conforming BCF 3.0 reader may reject.
 */
describe('BCF 3.0 FieldOfView range', () => {
  it('refuses a non-positive or >=180 FieldOfView rather than emitting an invalid archive', async () => {
    for (const bad of [0, -10, 180, 200]) {
      const topic = maximalTopic();
      topic.viewpoints[0].perspectiveCamera!.fieldOfView = bad;
      const project: BCFProject = { version: '3.0', topics: new Map([[TOPIC_GUID, topic]]) };
      await expect(writeBCF(project)).rejects.toThrow(/FieldOfView/);
    }
  });

  it('accepts the open interval boundaries a real fixture would sit just inside', async () => {
    for (const good of [0.001, 90, 179.999]) {
      const topic = maximalTopic();
      topic.viewpoints[0].perspectiveCamera!.fieldOfView = good;
      const project: BCFProject = { version: '3.0', topics: new Map([[TOPIC_GUID, topic]]) };
      const entries = await writeAndUnzip(project);
      const xml = entries.get(`${TOPIC_GUID}/Viewpoint_${VIEWPOINT_GUID}.bcfv`)!;
      const { valid, messages } = await validate('3.0', 'visinfo.xsd', xml);
      expect(messages.join('\n')).toBe('');
      expect(valid).toBe(true);
    }
  });

  it('does not restrict BCF 2.1, whose [45,60] facet the schema itself says will be dropped', async () => {
    // v2_1/visinfo.xsd's own annotation on FieldOfView: "This limitation will
    // be dropped in the next release and viewers should expect values outside
    // this range in current implementations." Enforcing it here would reject
    // legitimate 2.1 input the schema authors themselves disclaim.
    const topic = maximalTopic();
    topic.viewpoints[0].perspectiveCamera!.fieldOfView = 90;
    const project: BCFProject = { version: '2.1', topics: new Map([[TOPIC_GUID, topic]]) };
    const entries = await writeAndUnzip(project);
    expect(entries.get(`${TOPIC_GUID}/Viewpoint_${VIEWPOINT_GUID}.bcfv`)).toContain(
      '<FieldOfView>90</FieldOfView>'
    );
  });
});

/**
 * FINITENESS is the property, not sign and not schema-conformance.
 *
 * `AspectRatio` was guarded with `!(aspectRatio > 0)`, and `Infinity > 0` is
 * `true`, so `Infinity` walked straight through a check whose doc comment
 * claimed to enforce `PositiveDouble` and was written out verbatim. The same
 * mistake in its other disguise shipped elsewhere in this repository within
 * the week — `Number('Infinity')` is not `NaN`, so an `isNaN` guard passes it
 * too. Neither a positivity test nor a NaN test is a finiteness test;
 * `Number.isFinite` is, which is why every case below is stated against it
 * rather than against the value's sign.
 *
 * The XSDs punish the three non-finite values in three different ways, so no
 * single facet catches them and "the schema will reject it" is not a defence:
 *
 *  - `Infinity`/`-Infinity` stringify to `"Infinity"`/`"-Infinity"`, which are
 *    outside `xs:double`'s lexical space altogether (XSD 1.0 spells the
 *    infinities `INF`/`-INF`). Rejected everywhere.
 *  - `NaN` stringifies to `"NaN"`, which `xs:double` ACCEPTS. On a facet-bearing
 *    type it still fails (`PositiveDouble`'s `minExclusive`, `FieldOfView`'s
 *    range), but on the plain `xs:double` elements — every coordinate,
 *    `ViewToWorldScale`, `Bitmap/Height` — a validator sees nothing wrong while
 *    the archive carries a number no consumer can use. Two tests below pin that
 *    asymmetry so it cannot be mistaken for coverage.
 *  - `Topic/Index` is `xs:int`, narrower again: `1.5` is invalid there too.
 *
 * The sweep is the point. The reported defect was `AspectRatio`; it was the
 * only one of these fields with any guard at all.
 */
describe('non-finite numbers never reach the archive', () => {
  /**
   * Every numeric the writer emits under an XSD numeric type, as a mutation
   * that puts `value` in exactly that position.
   *
   * Anti-vacuity for the list itself is the `emits a schema-valid ...` tests
   * above: `maximalTopic` populates the camera, lines, clipping planes and
   * bitmaps, so each mutator below lands on markup that is really written.
   */
  const NUMERICS: ReadonlyArray<
    readonly [string, (t: BCFTopic, v: number) => void, number?]
  > = [
    ['PerspectiveCamera/AspectRatio', (t, v) => { t.viewpoints[0].perspectiveCamera!.aspectRatio = v; }],
    ['PerspectiveCamera/FieldOfView', (t, v) => { t.viewpoints[0].perspectiveCamera!.fieldOfView = v; }],
    ['PerspectiveCamera/CameraViewPoint/X', (t, v) => { t.viewpoints[0].perspectiveCamera!.cameraViewPoint.x = v; }],
    ['PerspectiveCamera/CameraDirection/Y', (t, v) => { t.viewpoints[0].perspectiveCamera!.cameraDirection.y = v; }],
    ['PerspectiveCamera/CameraUpVector/Z', (t, v) => { t.viewpoints[0].perspectiveCamera!.cameraUpVector.z = v; }],
    // The orthogonal camera REPLACES the perspective one: BCF 3.0 admits
    // exactly one camera per viewpoint (see "BCF camera cardinality and order"),
    // so setting both here would fail for that reason instead of this one.
    ['OrthogonalCamera/ViewToWorldScale', (t, v) => { useOrthogonal(t).viewToWorldScale = v; }],
    ['OrthogonalCamera/AspectRatio', (t, v) => { useOrthogonal(t).aspectRatio = v; }],
    ['OrthogonalCamera/CameraViewPoint/X', (t, v) => { useOrthogonal(t).cameraViewPoint.x = v; }],
    ['Line/StartPoint/X', (t, v) => { t.viewpoints[0].lines![0].startPoint.x = v; }],
    ['Line/EndPoint/Z', (t, v) => { t.viewpoints[0].lines![0].endPoint.z = v; }],
    ['ClippingPlane/Location/Y', (t, v) => { t.viewpoints[0].clippingPlanes![0].location.y = v; }],
    ['ClippingPlane/Direction/X', (t, v) => { t.viewpoints[0].clippingPlanes![0].direction.x = v; }],
    ['Bitmap/Location/Z', (t, v) => { t.viewpoints[0].bitmaps![0].location.z = v; }],
    ['Bitmap/Normal/X', (t, v) => { t.viewpoints[0].bitmaps![0].normal.x = v; }],
    ['Bitmap/Up/Y', (t, v) => { t.viewpoints[0].bitmaps![0].up.y = v; }],
    ['Bitmap/Height', (t, v) => { t.viewpoints[0].bitmaps![0].height = v; }],
    // The third element is the FINITE value the anti-vacuity case below uses;
    // `Topic/Index` needs its own because 3.25 is not an xs:int.
    ['Topic/Index', (t, v) => { t.index = v; }, 3],
  ];

  /** Swap the fixture's perspective camera for an orthogonal one and return it. */
  function useOrthogonal(topic: BCFTopic) {
    delete topic.viewpoints[0].perspectiveCamera;
    topic.viewpoints[0].orthogonalCamera = {
      cameraViewPoint: { x: 4.5, y: 5.5, z: 6.5 },
      cameraDirection: { x: 0, y: -1, z: 0 },
      cameraUpVector: { x: 0, y: 0, z: 1 },
      viewToWorldScale: 12.5,
      aspectRatio: 2.25,
    };
    return topic.viewpoints[0].orthogonalCamera;
  }

  function mutated(mutate: (t: BCFTopic, v: number) => void, value: number): BCFProject {
    const topic = maximalTopic();
    mutate(topic, value);
    return {
      version: '3.0',
      projectId: '66666666-6666-4666-8666-666666666666',
      name: 'Non-finite project',
      topics: new Map([[TOPIC_GUID, topic]]),
    };
  }

  for (const [field, mutate, finite = 3.25] of NUMERICS) {
    describe(field, () => {
      it.each([
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['NaN', NaN],
      ] as const)('is refused rather than written when it is %s', async (_label, value) => {
        await expect(writeBCF(mutated(mutate, value))).rejects.toThrow();
      });

      /**
       * Anti-vacuity, and the half a `rejects.toThrow()` cannot state: the same
       * mutation with a FINITE value must still produce a schema-valid archive.
       * Without this, a guard that rejected every value — or a mutator aimed at
       * a field the writer never emits — would pass the three cases above.
       */
      it('still writes a schema-valid archive for a finite value', async () => {
        const entries = await writeAndUnzip(mutated(mutate, finite));
        for (const [name, xml] of entries) {
          const xsd = SCHEMA_FOR_ENTRY.find(([re]) => re.test(name))![1];
          const { valid, messages } = await validate('3.0', xsd, xml);
          expect(messages, `${field} -> ${name}`).toEqual([]);
          expect(valid).toBe(true);
        }
      });
    });
  }

  /**
   * The reported symptom, pinned exactly.
   *
   * This is the archive the old guard produced, reconstructed by splicing
   * `Infinity` back into a good document. It asserts the VALIDATOR's verdict,
   * not the writer's — so it keeps working as a statement about the format
   * however the writer is later refactored, and it names the message a
   * reviewer would see rather than a generic "invalid".
   */
  it('would have failed XSD validation had Infinity been emitted (the reported defect)', async () => {
    const entries = await writeAndUnzip(maximalProject('3.0'));
    const good = entries.get(`${TOPIC_GUID}/Viewpoint_${VIEWPOINT_GUID}.bcfv`)!;
    expect((await validate('3.0', 'visinfo.xsd', good)).valid).toBe(true);

    const broken = good.replace(
      /<AspectRatio>[^<]*<\/AspectRatio>/,
      '<AspectRatio>Infinity</AspectRatio>'
    );
    expect(broken).not.toEqual(good);

    const { valid, messages } = await validate('3.0', 'visinfo.xsd', broken);
    expect(valid).toBe(false);
    expect(messages).toEqual([
      "Schemas validity error : Element 'AspectRatio': 'Infinity' is not a valid value of the atomic type 'PositiveDouble'.",
    ]);
  });

  /**
   * Why the guard is finiteness and not "whatever the schema rejects".
   *
   * `"NaN"` IS in `xs:double`'s lexical space, so a `<X>NaN</X>` coordinate
   * validates cleanly — the XSD cannot see this one at all. It is still
   * unusable: our own reader routes every number through `parseFiniteFloat`
   * and drops what is not finite, so a written `NaN` comes back as a camera
   * that has lost its viewpoint. Schema validity was never the bar.
   */
  it('accepts NaN as a schema-valid xs:double, which is exactly why the schema cannot be the guard', async () => {
    const entries = await writeAndUnzip(maximalProject('3.0'));
    const good = entries.get(`${TOPIC_GUID}/Viewpoint_${VIEWPOINT_GUID}.bcfv`)!;
    const withNaN = good.replace('<X>1.5</X>', '<X>NaN</X>');
    expect(withNaN).not.toEqual(good);

    const { valid, messages } = await validate('3.0', 'visinfo.xsd', withNaN);
    expect(messages).toEqual([]);
    expect(valid).toBe(true);

    // ...and the value does not survive the trip back in.
    const readBack = await readBCF(
      new Uint8Array(await (await writeBCF(maximalProject('3.0'))).arrayBuffer())
    );
    expect(readBack.topics.get(TOPIC_GUID)!.viewpoints[0].perspectiveCamera?.cameraViewPoint.x)
      .toBe(1.5);
  });

  /**
   * `Topic/Index` is `xs:int`, and finiteness alone is not its whole rule.
   *
   * A fractional index is finite, so the `Number.isFinite` test every other
   * field uses would pass it — and `<Index>1.5</Index>` is still rejected
   * ("'1.5' is not a valid value of the atomic type 'xs:int'"). The one field
   * with a narrower type gets the narrower check.
   */
  it('refuses a fractional Topic/Index, which finiteness alone would let through', async () => {
    expect(Number.isFinite(1.5)).toBe(true);
    await expect(writeBCF(mutated((t, v) => { t.index = v; }, 1.5))).rejects.toThrow(/xs:int/);
  });
});

/**
 * Schema validity is necessary, not sufficient.
 *
 * `<ViewSetupHints>` is OPTIONAL in both versions, so an archive that drops it
 * entirely still validates — the XSD cannot tell "correctly placed" from
 * "silently discarded". Mutation-testing the writer proved exactly that: with
 * the 3.0 placement deleted, every validation test above still passed. Placement
 * and survival therefore need their own assertion. The 2.1 side of this is
 * covered in `writer.test.ts` ("writes ViewSetupHints with the spec attribute
 * names, only for the hints that are set").
 */
describe('BCF 3.0 places ViewSetupHints inside <Visibility>', () => {
  it('keeps the hints, with their values, nested in Visibility rather than at Components level', async () => {
    const entries = await writeAndUnzip(maximalProject('3.0'));
    const bcfv = entries.get(`${TOPIC_GUID}/Viewpoint_${VIEWPOINT_GUID}.bcfv`)!;

    // Present at all — the mutation that deleted it left the file schema-valid.
    expect(bcfv).toContain('<ViewSetupHints');
    // Each hint keeps its own value: the fixture sets three different ones, so
    // a writer that emitted one attribute's value under another name is caught.
    expect(bcfv).toContain('SpacesVisible="true"');
    expect(bcfv).toContain('SpaceBoundariesVisible="false"');
    expect(bcfv).toContain('OpeningsVisible="true"');

    // Nested inside <Visibility>, not a sibling of it at <Components> level.
    // v3_0/visinfo.xsd's `Components` admits only Selection/Visibility/Coloring.
    const visibilityOpen = bcfv.indexOf('<Visibility');
    const visibilityClose = bcfv.indexOf('</Visibility>');
    const hints = bcfv.indexOf('<ViewSetupHints');
    expect(visibilityOpen).toBeGreaterThan(-1);
    expect(hints).toBeGreaterThan(visibilityOpen);
    expect(hints).toBeLessThan(visibilityClose);
    // Exactly one — a writer that emitted it in BOTH places would produce a
    // schema-invalid file, but this pins the count directly too.
    expect(bcfv.split('<ViewSetupHints').length - 1).toBe(1);
  });
});

/**
 * A validator that has never been shown to go red is worth nothing.
 *
 * Everything above asserts `valid === true`. If the schema failed to load, if
 * the include never resolved, if xmllint silently ignored the document, or if
 * `validateXML` returned `valid: true` for input it never actually read, every
 * assertion above would pass for the wrong reason. These tests break the
 * document in one specific way each and require the validator to notice —
 * covering a missing required element, a bad enum value, a wrong-typed
 * attribute, an out-of-range facet and a broken sequence order, i.e. one case
 * per class of rule the tests above depend on.
 */
describe('the validator can fail (mutation proof)', () => {
  it('rejects a required element that has been dropped', async () => {
    const entries = await writeAndUnzip(maximalProject('2.1'));
    const good = entries.get(`${TOPIC_GUID}/markup.bcf`)!;
    // `<Title>` is required by markup.xsd in both versions.
    const broken = good.replace(/\s*<Title>[\s\S]*?<\/Title>/, '');
    expect(broken).not.toEqual(good);

    expect((await validate('2.1', 'markup.xsd', good)).valid).toBe(true);
    const { valid, messages } = await validate('2.1', 'markup.xsd', broken);
    expect(valid).toBe(false);
    expect(messages.join('\n')).toContain('Title');
  });

  it('rejects a misspelled enum value', async () => {
    const entries = await writeAndUnzip(maximalProject('2.1'));
    const good = entries.get(`${TOPIC_GUID}/Viewpoint_${VIEWPOINT_GUID}.bcfv`)!;
    // 2.1's BitmapFormat enum is {PNG, JPG} — uppercase. 3.0's is {png, jpg}.
    // Lowercasing it is exactly the cross-version mistake this catches.
    const broken = good.replace('>PNG<', '>png<');
    expect(broken).not.toEqual(good);

    const { valid, messages } = await validate('2.1', 'visinfo.xsd', broken);
    expect(valid).toBe(false);
    expect(messages.join('\n')).toContain('enumeration');
  });

  it('rejects a wrong-typed attribute', async () => {
    const entries = await writeAndUnzip(maximalProject('2.1'));
    const good = entries.get(`${TOPIC_GUID}/Viewpoint_${VIEWPOINT_GUID}.bcfv`)!;
    // `DefaultVisibility` is xs:boolean; "sometimes" is not a boolean.
    const broken = good.replace(
      /DefaultVisibility="[^"]*"/,
      'DefaultVisibility="sometimes"'
    );
    expect(broken).not.toEqual(good);

    const { valid, messages } = await validate('2.1', 'visinfo.xsd', broken);
    expect(valid).toBe(false);
    expect(messages.join('\n')).toContain('DefaultVisibility');
  });

  it('rejects a value outside a schema facet range', async () => {
    const entries = await writeAndUnzip(maximalProject('2.1'));
    const good = entries.get(`${TOPIC_GUID}/Viewpoint_${VIEWPOINT_GUID}.bcfv`)!;
    // 2.1 restricts FieldOfView to [45, 60]; the fixture sits on 60.
    const broken = good.replace(
      /<FieldOfView>[^<]*<\/FieldOfView>/,
      '<FieldOfView>60.5</FieldOfView>'
    );
    expect(broken).not.toEqual(good);

    const { valid, messages } = await validate('2.1', 'visinfo.xsd', broken);
    expect(valid).toBe(false);
    expect(messages.join('\n')).toContain('FieldOfView');
  });

  it('rejects elements emitted out of schema sequence order', async () => {
    const entries = await writeAndUnzip(maximalProject('2.1'));
    const good = entries.get(`${TOPIC_GUID}/markup.bcf`)!;
    // markup.xsd orders Topic's children as a strict xs:sequence, so moving
    // CreationDate after CreationAuthor is invalid even though both are present
    // and both are well-formed. An order-blind check would miss this.
    const creationDate = /\s*<CreationDate>[\s\S]*?<\/CreationDate>/.exec(good);
    expect(creationDate).not.toBeNull();
    const broken = good
      .replace(creationDate![0], '')
      .replace(
        /(<\/CreationAuthor>)/,
        `$1${creationDate![0]}`
      );
    expect(broken).not.toEqual(good);

    const { valid } = await validate('2.1', 'markup.xsd', broken);
    expect(valid).toBe(false);
  });

  it('rejects XML that is not well-formed at all', async () => {
    const { valid } = await validate('2.1', 'markup.xsd', '<Markup><unclosed>');
    expect(valid).toBe(false);
  });
});

/**
 * Which cameras a viewpoint may carry, and in what order.
 *
 * The two schemas disagree, and the writer followed neither:
 *
 * - v2_1/visinfo.xsd declares `OrthogonalCamera` then `PerspectiveCamera` as
 *   two `minOccurs="0"` members of an `xs:sequence`. Both may appear, but only
 *   in that order — and the writer emitted the perspective camera first.
 * - v3_0/visinfo.xsd replaced the pair with an `xs:choice` carrying neither
 *   `minOccurs` nor `maxOccurs`, i.e. EXACTLY ONE camera, required. The writer
 *   emitted both when both were set and none when neither was, so a 3.0
 *   viewpoint that isolated components without a camera — what
 *   `ids-reporter.ts` produces whenever no entity bounds are supplied — was
 *   never valid.
 *
 * None of this was reachable from `maximalTopic`, which sets only
 * `perspectiveCamera`; and the one place that did set both cameras (the
 * AspectRatio round-trip above) checks `parse(write(x)) === x` and never asks
 * the schema. The matrix below asks the schema for every combination instead.
 */
describe('BCF camera cardinality and order', () => {
  const PERSPECTIVE = {
    cameraViewPoint: { x: 1.5, y: 2.5, z: 3.5 },
    cameraDirection: { x: 0, y: 0, z: -1 },
    cameraUpVector: { x: 0, y: 1, z: 0 },
    fieldOfView: 60,
    aspectRatio: 1.5,
  };
  const ORTHOGONAL = {
    // Distinct from PERSPECTIVE's point in every component, so a writer that
    // emitted one camera's body under the other's tag is visible.
    cameraViewPoint: { x: 4.5, y: 5.5, z: 6.5 },
    cameraDirection: { x: 0, y: -1, z: 0 },
    cameraUpVector: { x: 0, y: 0, z: 1 },
    viewToWorldScale: 12.5,
    aspectRatio: 2.25,
  };

  /** A project holding one viewpoint with exactly the cameras asked for. */
  function project(
    version: '2.1' | '3.0',
    cameras: { perspective: boolean; orthogonal: boolean }
  ): BCFProject {
    const topic = maximalTopic();
    const viewpoint = topic.viewpoints[0];
    if (cameras.perspective) viewpoint.perspectiveCamera = { ...PERSPECTIVE };
    else delete viewpoint.perspectiveCamera;
    if (cameras.orthogonal) viewpoint.orthogonalCamera = { ...ORTHOGONAL };
    else delete viewpoint.orthogonalCamera;
    return {
      version,
      projectId: '66666666-6666-4666-8666-666666666666',
      name: 'Camera matrix project',
      topics: new Map([[TOPIC_GUID, topic]]),
    };
  }

  async function bcfv(
    version: '2.1' | '3.0',
    cameras: { perspective: boolean; orthogonal: boolean }
  ): Promise<string> {
    const entries = await writeAndUnzip(project(version, cameras));
    const xml = entries.get(`${TOPIC_GUID}/Viewpoint_${VIEWPOINT_GUID}.bcfv`);
    // Anti-vacuity: every assertion below reads this string, so a writer that
    // stopped emitting the viewpoint entry must fail here, not pass silently.
    expect(xml).toBeDefined();
    return xml!;
  }

  /**
   * Re-derive the premise from the schemas themselves.
   *
   * Everything below is written against two facts about the vendored XSDs. If
   * buildingSMART ever changes them, this fails first and names the change,
   * rather than leaving the rest of the block quietly testing the wrong rule.
   */
  it('derives the camera rule from the vendored schemas', () => {
    const v21 = schema('2.1', 'visinfo.xsd');
    const v30 = schema('3.0', 'visinfo.xsd');
    // Span from VisualizationInfo's opening tag to the Lines declaration that
    // follows the cameras — enough to see the camera declarations and nothing
    // that comes after them.
    const span = (xsd: string): string =>
      xsd.slice(xsd.indexOf('name="VisualizationInfo"'), xsd.indexOf('name="Lines"'));
    const cameraOrder = (xsd: string): string[] =>
      [...span(xsd).matchAll(/name="(OrthogonalCamera|PerspectiveCamera)"/g)].map((m) => m[1]);

    // 2.1: an ordered pair of optionals, orthogonal first, no choice.
    expect(cameraOrder(v21)).toEqual(['OrthogonalCamera', 'PerspectiveCamera']);
    expect(span(v21)).not.toContain('<xs:choice');
    expect(span(v21)).toContain('name="OrthogonalCamera" type="OrthogonalCamera" minOccurs="0"');

    // 3.0: an xs:choice with no minOccurs/maxOccurs, i.e. exactly one, required.
    expect(cameraOrder(v30)).toEqual(['OrthogonalCamera', 'PerspectiveCamera']);
    const choice = /<xs:choice([^>]*)>/.exec(span(v30));
    expect(choice).not.toBeNull();
    expect(choice![1].trim()).toBe('');
  });

  describe('BCF 2.1 — both cameras are allowed, in schema order', () => {
    it('emits OrthogonalCamera before PerspectiveCamera', async () => {
      const xml = await bcfv('2.1', { perspective: true, orthogonal: true });
      // Named elements in the order the schema declares them, not a count:
      // a count of 2 passes for either order.
      expect(
        [...xml.matchAll(/<(OrthogonalCamera|PerspectiveCamera)>/g)].map((m) => m[1])
      ).toEqual(['OrthogonalCamera', 'PerspectiveCamera']);
      // Each camera's own body travels with its own tag.
      expect(xml).toContain('<ViewToWorldScale>12.5</ViewToWorldScale>');
      expect(xml).toContain('<FieldOfView>60</FieldOfView>');
    });

    it('validates with both cameras present', async () => {
      const xml = await bcfv('2.1', { perspective: true, orthogonal: true });
      const { valid, messages } = await validate('2.1', 'visinfo.xsd', xml);
      expect(messages).toEqual([]);
      expect(valid).toBe(true);
    });

    it.each([
      ['perspective only', { perspective: true, orthogonal: false }],
      ['orthogonal only', { perspective: false, orthogonal: true }],
      // 2.1 makes both optional, so a camera-less viewpoint is legal there —
      // the negative control for the 3.0 rule below.
      ['no camera', { perspective: false, orthogonal: false }],
    ] as const)('validates with %s', async (_label, cameras) => {
      const xml = await bcfv('2.1', cameras);
      const { valid, messages } = await validate('2.1', 'visinfo.xsd', xml);
      expect(messages).toEqual([]);
      expect(valid).toBe(true);
    });
  });

  describe('BCF 3.0 — exactly one camera, required', () => {
    it.each([
      ['perspective only', { perspective: true, orthogonal: false }, 'PerspectiveCamera'],
      ['orthogonal only', { perspective: false, orthogonal: true }, 'OrthogonalCamera'],
    ] as const)('validates with %s', async (_label, cameras, expected) => {
      const xml = await bcfv('3.0', cameras);
      // The one camera that IS emitted must be the one that was asked for.
      expect(
        [...xml.matchAll(/<(OrthogonalCamera|PerspectiveCamera)>/g)].map((m) => m[1])
      ).toEqual([expected]);
      const { valid, messages } = await validate('3.0', 'visinfo.xsd', xml);
      expect(messages).toEqual([]);
      expect(valid).toBe(true);
    });

    it('refuses to write both cameras rather than emitting an invalid archive', async () => {
      await expect(
        writeBCF(project('3.0', { perspective: true, orthogonal: true }))
      ).rejects.toThrow(/exactly one camera/);
    });

    it('refuses to write a viewpoint with no camera at all', async () => {
      await expect(
        writeBCF(project('3.0', { perspective: false, orthogonal: false }))
      ).rejects.toThrow(/exactly one camera/);
    });

    it('names the offending viewpoint so the caller can find it', async () => {
      await expect(
        writeBCF(project('3.0', { perspective: false, orthogonal: false }))
      ).rejects.toThrow(new RegExp(VIEWPOINT_GUID));
    });
  });
});
