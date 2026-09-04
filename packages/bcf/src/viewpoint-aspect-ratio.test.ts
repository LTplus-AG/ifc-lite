/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A BCF 3.0 camera's `<AspectRatio>` has to reach the writer from the caller.
 *
 * `writer-camera.ts` refuses to invent one: v3_0/visinfo.xsd declares
 * `AspectRatio` (`PositiveDouble`) as a REQUIRED child of both camera types,
 * and inventing a value would assert a view the caller never chose. That
 * policy is right, and it is unenforceable unless a caller has some way to
 * supply the number.
 *
 * It did not. `createViewpoint` is the only public viewpoint constructor in
 * this package, and the app-side path (`apps/viewer`'s `useBCF`) goes through
 * it for every viewpoint a user captures. It builds its camera from a
 * `ViewerCameraState`, which carried no aspect ratio at all, so
 * `cameraToPerspective`/`cameraToOrthogonal` could not set one and every
 * viewpoint this package produced was unwritable as BCF 3.0. `writeBCF`
 * throws on the FIRST such camera, so a single captured viewpoint made the
 * whole archive fail: not a degraded export, no export (#3612).
 *
 * A 3.0 project is reachable without any 3.0-specific UI: `readBCF` sets
 * `project.version` from the imported `bcf.version`, so importing another
 * tool's 3.0 archive, adding a topic, and exporting hit exactly this.
 *
 * The reverse direction is here so the conversion pair is lossless both ways.
 * A caller that reads a viewpoint, edits the camera state and writes it back
 * (`perspectiveToCamera` -> `cameraToPerspective`) would otherwise drop the
 * field and produce a camera that cannot be written as BCF 3.0. This is a
 * library-level round trip, NOT the viewer's apply path: `useBCF`'s
 * `applyCameraState` never pushes an aspect ratio into the renderer (the
 * viewport owns it) and `getCameraState` reads a fresh one.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { validateXML } from 'xmllint-wasm';
import {
  cameraToOrthogonal,
  cameraToPerspective,
  createViewpoint,
  extractViewpointState,
  orthogonalToCamera,
  perspectiveToCamera,
  type ViewerCameraState,
} from './viewpoint.js';
import { writeBCF } from './writer.js';
import { readBCF } from './reader.js';
import type { BCFProject, BCFTopic } from './types.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** The viewport this fixture pretends to be: 1600x900, i.e. 16/9. */
const ASPECT = 16 / 9;

const CAMERA: ViewerCameraState = {
  position: { x: 10, y: 5, z: 20 },
  target: { x: 1, y: 2, z: 3 },
  up: { x: 0, y: 1, z: 0 },
  fov: Math.PI / 4,
  aspectRatio: ASPECT,
};

function projectWith(viewpointCamera: ViewerCameraState): BCFProject {
  const topic: BCFTopic = {
    guid: '11111111-1111-4111-8111-111111111111',
    title: 'Captured in the viewer',
    topicType: 'Issue',
    topicStatus: 'Open',
    creationDate: '2026-01-02T03:04:05Z',
    creationAuthor: 'author@example.invalid',
    comments: [],
    viewpoints: [createViewpoint({ camera: viewpointCamera })],
  };
  return {
    version: '3.0',
    projectId: '99999999-9999-4999-8999-999999999999',
    name: 'Imported from another tool',
    topics: new Map([[topic.guid, topic]]),
  };
}

async function viewpointXml(project: BCFProject): Promise<string> {
  const zip = await JSZip.loadAsync(Buffer.from(await (await writeBCF(project)).arrayBuffer()));
  const name = Object.keys(zip.files).find((n) => n.endsWith('.bcfv'));
  expect(name, 'archive has a viewpoint file').toBeTruthy();
  return zip.files[name!].async('string');
}

async function validatesAgainstVisinfo(xml: string): Promise<string[]> {
  const schema = (file: string) =>
    readFileSync(path.join(DIR, '__fixtures__', 'schemas', 'v3_0', file), 'utf8');
  const result = await validateXML({
    xml: [{ fileName: 'subject.xml', contents: xml }],
    schema: [schema('visinfo.xsd')],
    preload: [{ fileName: 'shared-types.xsd', contents: schema('shared-types.xsd') }],
  });
  return result.valid ? [] : result.errors.map((e) => e.message);
}

describe('viewer camera aspect ratio reaches a BCF 3.0 camera', () => {
  it('cameraToPerspective carries the caller-supplied aspect ratio', () => {
    expect(cameraToPerspective(CAMERA).aspectRatio).toBe(ASPECT);
  });

  it('cameraToOrthogonal carries the caller-supplied aspect ratio', () => {
    expect(cameraToOrthogonal(CAMERA, 42).aspectRatio).toBe(ASPECT);
  });

  /**
   * Absent stays absent: 2.1's visinfo.xsd has no `AspectRatio` element, so a
   * caller that supplies nothing must not acquire a fabricated one. This is
   * the anti-mutation half — a fix that defaulted the field would pass every
   * other assertion in this file.
   */
  it('leaves the aspect ratio unset when the caller supplies none', () => {
    const { aspectRatio, ...rest } = CAMERA;
    expect(aspectRatio).toBe(ASPECT); // fixture sanity: the field was there to remove
    expect(cameraToPerspective(rest).aspectRatio).toBeUndefined();
    expect(cameraToOrthogonal(rest, 42).aspectRatio).toBeUndefined();
  });

  it('writes a schema-valid BCF 3.0 perspective viewpoint', async () => {
    const xml = await viewpointXml(projectWith(CAMERA));
    expect(xml).toContain(`<AspectRatio>${ASPECT}</AspectRatio>`);
    expect(await validatesAgainstVisinfo(xml)).toEqual([]);
  });

  it('writes a schema-valid BCF 3.0 orthogonal viewpoint', async () => {
    const xml = await viewpointXml(
      projectWith({ ...CAMERA, isOrthographic: true, orthoScale: 12.5 })
    );
    expect(xml).toContain('<OrthogonalCamera>');
    expect(xml).toContain(`<AspectRatio>${ASPECT}</AspectRatio>`);
    expect(await validatesAgainstVisinfo(xml)).toEqual([]);
  });

  /**
   * The whole-archive property, stated at the level the user sees: a 3.0
   * project with a viewer-authored viewpoint exports at all. Before the fix
   * `writeBCF` rejected, so the user got no file and an error toast.
   */
  it('round-trips a 3.0 archive holding a viewer-authored viewpoint', async () => {
    const project = projectWith(CAMERA);
    const blob = await writeBCF(project);
    const back = await readBCF(blob);
    expect(back.version).toBe('3.0');
    const topic = back.topics.get('11111111-1111-4111-8111-111111111111');
    expect(topic?.viewpoints[0]?.perspectiveCamera?.aspectRatio).toBe(ASPECT);
  });

  describe('the reverse direction keeps it, so the conversion pair is lossless', () => {
    it('perspectiveToCamera returns the aspect ratio', () => {
      const bcf = cameraToPerspective(CAMERA);
      expect(perspectiveToCamera(bcf).aspectRatio).toBe(ASPECT);
    });

    it('orthogonalToCamera returns the aspect ratio', () => {
      const bcf = cameraToOrthogonal(CAMERA, 42);
      expect(orthogonalToCamera(bcf).aspectRatio).toBe(ASPECT);
    });

    it('extractViewpointState surfaces it, and re-writing that state still validates', async () => {
      const viewpoint = createViewpoint({ camera: CAMERA });
      const state = extractViewpointState(viewpoint);
      expect(state.camera?.aspectRatio).toBe(ASPECT);
      const xml = await viewpointXml(projectWith(state.camera!));
      expect(await validatesAgainstVisinfo(xml)).toEqual([]);
    });

    it('reports no aspect ratio when the source camera had none', () => {
      const bcf = cameraToPerspective(CAMERA);
      delete bcf.aspectRatio;
      expect(perspectiveToCamera(bcf).aspectRatio).toBeUndefined();
    });
  });
});
