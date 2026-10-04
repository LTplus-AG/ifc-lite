/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { parseIfcx } from '@ifc-lite/ifcx';
import { existsSync } from 'node:fs';
import { writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { formaAdapter } from '../src/forma-adapter.js';
import { readArtifact, runNative, scratch } from '../src/native-process.js';
import { triangle } from './forma-fixture.js';

const command = process.env.TEST_FORMA_CONVERTER ?? resolve('../../target/debug/ifc-lite-cloud-import');
const encode = (value: object) => `adsk1:${encodeURIComponent(JSON.stringify(value))}`;
const root = 'urn:adsk-forma-elements:proposal:project:proposal:revision';
const child = 'urn:adsk-forma-elements:parametric:hub:part:revision';
const input = {
  ref: { projectId: encode({ kind: 'site', project: 'project', id: 'site', region: 'EMEA' }),
    containerId: encode({ kind: 'proposals', project: 'project', id: 'site', region: 'EMEA' }),
    fileId: root.slice(0, root.lastIndexOf(':')), revisionId: root },
  region: 'EMEA' as const, accessToken: 'delegated-secret', signal: new AbortController().signal,
};
describe('native Autodesk import boundaries', () => {
  it('cancels a real child process and cleans request scratch files', async () => {
    let directory = '';
    const controller = new AbortController();
    await expect(scratch(async (path) => {
      directory = path;
      const process = runNative(globalThis.process.execPath, ['-e', 'setInterval(() => {}, 1000)'], path, undefined, controller.signal);
      controller.abort(); await process;
    })).rejects.toThrow();
    expect(existsSync(directory)).toBe(false);
  });
  it('rejects artifacts outside the request workspace and oversized files', async () => {
    await scratch(async (directory) => {
      await expect(readArtifact(directory, resolve(directory, '../outside.ifcx'), 100)).rejects.toThrow('invalid artifact');
      const file = join(directory, 'large.ifcx'); await writeFile(file, new Uint8Array(101));
      await expect(readArtifact(directory, file, 100)).rejects.toThrow('limit');
      expect(await readdir(directory)).toEqual(['large.ifcx']);
    });
  });
  it('rejects cross-project immutable revisions before any network access', async () => {
    const fetcher: typeof fetch = async () => { throw new Error('Network must not run'); };
    await expect(formaAdapter(command, fetcher).convert({ ...input,
      ref: { ...input.ref, revisionId: root.replace(':project:', ':other:') } })).rejects.toThrow('do not match');
  });
  it.skipIf(!existsSync(command))('converts signed GLB blobs through Rust into selectable IFCX geometry and georeference', async () => {
    const requests: { url: URL; headers: Headers }[] = [];
    const fetcher: typeof fetch = async (raw, init) => {
      const url = new URL(String(raw)); const headers = new Headers(init?.headers); requests.push({ url, headers });
      if (url.hostname === 'fixture.s3.eu-west-1.amazonaws.com') return new Response(new Uint8Array(triangle()));
      if (url.pathname.includes('/sites/')) return Response.json({ id: 'site', projectId: 'project', coordinateSystem: { srid: 32632, refPoint: [500000, 6000000] } });
      if (url.pathname.includes('/blobs/')) return new Response(null, { status: 302, headers: { Location: 'https://fixture.s3.eu-west-1.amazonaws.com/blob?signature=private' } });
      const urn = decodeURIComponent(url.pathname.split('/').at(-1)!);
      return Response.json({ element: { [urn]: urn === root ? { urn, children: [
        { key: 'first', urn: child }, { key: 'second', urn: child, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1] },
      ] } : { urn, properties: { name: 'Repeated floor', category: 'building' },
        representations: { volumeMesh: { type: 'linked', blobId: 'blob', selection: { type: 'equals', value: 'part' } } } } }, elements: {} });
    };
    const artifact = await formaAdapter(command, fetcher).convert(input);
    const model = await parseIfcx(new Uint8Array(artifact.bytes).buffer);
    expect(model.meshes).toHaveLength(2);
    expect(new Set(model.meshes.map((mesh) => mesh.expressId)).size).toBe(2);
    expect(model.meshes.map((mesh) => mesh.positions[0]).sort((a, b) => a - b)).toEqual([0, 10]);
    expect(model.meshes.every((mesh) => mesh.positions[1] === 2)).toBe(true);
    expect(model.georeferencing?.IfcMapConversion.Eastings).toBe(500000);
    expect(model.georeferencing?.IfcProjectedCRS.Name).toBe('EPSG:32632');
    expect(requests.filter((r) => r.url.pathname.includes('/elements/'))).toHaveLength(2);
    expect(requests.filter((r) => r.url.pathname.includes('/blobs/'))).toHaveLength(1);
    expect(requests.find((r) => r.url.pathname.includes('/blobs/'))?.url.searchParams.get('authcontext')).toBe('hub');
    for (const request of requests) {
      expect(request.headers.get('authorization')).toBe(request.url.hostname === 'developer.api.autodesk.com' ? 'Bearer delegated-secret' : null);
    }
  });
});
