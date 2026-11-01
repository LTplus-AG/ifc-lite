/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite oci push` against a real registry on 127.0.0.1 that stores what
 * it is sent: the bytes read back through `oci://` input, the manifest
 * layout, tag protection, credentials on the wire, and the output formats.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ociCommand } from './oci.js';
import { infoCommand } from './info.js';
import { readModelInput } from '../model-input.js';
import { sha256 } from '../oci-test-helpers.js';
import { startPushTestRegistry, type PushTestAccess, type PushTestRegistry } from '../oci-push-test-registry.js';

const SAMPLES = resolve(__dirname, '../../../../apps/viewer/public/samples');
const MODEL = resolve(SAMPLES, 'building-architecture.ifc');
const REV_B = resolve(SAMPLES, 'building-architecture-rev-b.ifc');
const ENV_KEYS = ['IFC_LITE_OCI_USERNAME', 'IFC_LITE_OCI_PASSWORD', 'IFC_LITE_OCI_TOKEN', 'SOURCE_DATE_EPOCH'];
const USER = 'ci-bot';
const PASSWORD = 'pa55-word-never-printed';
const EMPTY_CONFIG = {
  mediaType: 'application/vnd.oci.empty.v1+json',
  digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  size: 2,
};

let registry: PushTestRegistry | undefined;
let stdout = '';
let stderr = '';

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
  await registry?.close();
  registry = undefined;
});

async function serve(access: PushTestAccess = { username: USER, password: PASSWORD }): Promise<PushTestRegistry> {
  registry = await startPushTestRegistry(access);
  process.env.IFC_LITE_OCI_USERNAME = USER;
  process.env.IFC_LITE_OCI_PASSWORD = PASSWORD;
  return registry;
}

function push(...args: string[]): Promise<void> {
  return ociCommand(['push', ...args]);
}

describe('oci push', () => {
  it('pushes a model that oci:// input reads back byte for byte', async () => {
    const reg = await serve();
    const ref = `oci://${reg.host}/demo/model:v1`;
    const local = await readFile(MODEL);

    await push(ref, MODEL);

    const pulled = await readModelInput(ref);
    expect(Buffer.from(pulled.bytes).equals(local)).toBe(true);
    expect(pulled.name).toBe('building-architecture.ifc');
    const digest = reg.tags.get('demo/model:v1');
    expect(stdout).toBe(`Pushed ${ref} → ${digest} (layer ${sha256(local)}, ${local.byteLength} bytes)\n`);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('info --json on the pushed reference equals the local file except .file and .parseTime', async () => {
    const reg = await serve();
    const ref = `oci://${reg.host}/demo/model:v1`;
    await push(ref, MODEL);

    const run = async (arg: string) => {
      stdout = '';
      await infoCommand(['--json', arg]);
      const { file, parseTime, ...rest } = JSON.parse(stdout) as Record<string, unknown>;
      return { file, parseTime, rest };
    };
    const local = await run(MODEL);
    const pulled = await run(ref);

    expect(pulled.rest).toEqual(local.rest);
    expect(pulled.file).toBe(ref);
    expect(pulled.rest.entityCount as number).toBeGreaterThan(0);
  });

  it('writes the viewer publish layout: artifact type, empty config, one titled x-step layer', async () => {
    const reg = await serve();
    process.env.SOURCE_DATE_EPOCH = '1700000000';
    const local = await readFile(MODEL);

    await push(`oci://${reg.host}/demo/model:v1`, MODEL);

    expect(reg.manifestAt('demo/model', 'v1')).toEqual({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      artifactType: 'application/vnd.ifc-lite.ifc.v1',
      config: EMPTY_CONFIG,
      layers: [{
        mediaType: 'application/x-step',
        digest: sha256(local),
        size: local.byteLength,
        annotations: {
          'org.buildingsmart.ifc.profile': 'ifc-release/0',
          'org.buildingsmart.ifc.schema': 'IFC4',
          'org.opencontainers.image.title': 'building-architecture.ifc',
        },
      }],
      annotations: {
        'org.buildingsmart.ifc.profile': 'ifc-release/0',
        'org.buildingsmart.ifc.schema': 'IFC4',
        'org.opencontainers.image.created': '2023-11-14T22:13:20Z',
        'org.opencontainers.image.title': 'building-architecture',
      },
    });
    expect(Buffer.from(reg.blobs.get(`demo/model@${EMPTY_CONFIG.digest}`) ?? []).toString()).toBe('{}');
    // Config blob, then the layer, then the manifest.
    const writes = reg.requests.filter((r) => r.method === 'PUT').map((r) => r.url.split('?')[0].replace(/uploads\/u\d+$/, 'uploads/*'));
    const digests = reg.requests.filter((r) => r.method === 'PUT').map((r) => new URL(r.url, 'http://x').searchParams.get('digest'));
    expect(writes).toEqual(['/v2/demo/model/blobs/uploads/*', '/v2/demo/model/blobs/uploads/*', '/v2/demo/model/manifests/v1']);
    expect(digests.slice(0, 2)).toEqual([EMPTY_CONFIG.digest, sha256(local)]);
  });

  it('gives the same manifest digest for the same file under SOURCE_DATE_EPOCH, whatever the tag', async () => {
    const reg = await serve();
    process.env.SOURCE_DATE_EPOCH = '1700000000';

    await push(`oci://${reg.host}/demo/model:a`, MODEL);
    await new Promise((done) => setTimeout(done, 1100));
    await push(`oci://${reg.host}/demo/model:b`, MODEL);

    expect(reg.tags.get('demo/model:a')).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(reg.tags.get('demo/model:b')).toBe(reg.tags.get('demo/model:a'));
  });

  it('stamps the current time as created without SOURCE_DATE_EPOCH', async () => {
    const reg = await serve();
    const before = Math.floor(Date.now() / 1000) * 1000;

    await push(`oci://${reg.host}/demo/model:v1`, MODEL);

    const annotations = reg.manifestAt('demo/model', 'v1')?.annotations as Record<string, string> | undefined;
    const created = annotations?.['org.opencontainers.image.created'] ?? '';
    expect(created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Date.parse(created)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(created)).toBeLessThanOrEqual(Date.now());
  });
});

describe('oci push tag protection', () => {
  it('refuses to replace an existing tag and leaves it pointing at the first push', async () => {
    const reg = await serve();
    const ref = `oci://${reg.host}/demo/model:v1`;
    await push(ref, MODEL);
    const first = reg.tags.get('demo/model:v1');
    stdout = '';

    await expect(push(ref, REV_B)).rejects.toThrow('exit 1');

    expect(stderr).toBe('Error: tag v1 already exists; pass --overwrite to replace it\n');
    expect(stdout).toBe('');
    expect(reg.tags.get('demo/model:v1')).toBe(first);
  });

  it('replaces the tag with --overwrite', async () => {
    const reg = await serve();
    const ref = `oci://${reg.host}/demo/model:v1`;
    await push(ref, MODEL);
    const first = reg.tags.get('demo/model:v1');

    await push('--overwrite', ref, REV_B);

    expect(reg.tags.get('demo/model:v1')).not.toBe(first);
    const pulled = await readModelInput(ref);
    expect(Buffer.from(pulled.bytes).equals(await readFile(REV_B))).toBe(true);
  });
});

describe('oci push credentials', () => {
  it('exchanges username/password at the realm for a pull,push token and pushes with it', async () => {
    const reg = await serve();

    await push(`oci://${reg.host}/demo/model:v1`, MODEL);

    const realm = reg.requests.filter((r) => r.url.startsWith('/token'));
    expect(realm.length).toBeGreaterThan(0);
    for (const r of realm) {
      expect(r.authorization).toBe(`Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`);
      expect(new URLSearchParams(r.url.split('?')[1]).get('scope')).toBe('repository:demo/model:pull,push');
    }
    const writes = reg.requests.filter((r) => r.method === 'PUT' || r.method === 'POST');
    expect(writes.every((r) => r.authorization?.startsWith('Bearer issued-'))).toBe(true);
  });

  it('sends IFC_LITE_OCI_TOKEN as a bearer token with no realm exchange', async () => {
    const reg = await serve({ token: 'static-push-token' });
    delete process.env.IFC_LITE_OCI_USERNAME;
    delete process.env.IFC_LITE_OCI_PASSWORD;
    process.env.IFC_LITE_OCI_TOKEN = 'static-push-token';

    await push(`oci://${reg.host}/demo/model:v1`, MODEL);

    expect(reg.requests.some((r) => r.url.startsWith('/token'))).toBe(false);
    expect(reg.tags.has('demo/model:v1')).toBe(true);
  });

  it('rejects a wrong password with exit 1, an authentication hint, and no password in the output', async () => {
    const reg = await serve();
    process.env.IFC_LITE_OCI_PASSWORD = 'wrong-secret-value';
    const ref = `oci://${reg.host}/demo/model:v1`;

    await expect(push(ref, MODEL)).rejects.toThrow('exit 1');

    expect(stderr).toContain(`Error: cannot push ${ref} (UNAUTHORIZED)`);
    expect(stderr).toMatch(/unauthorized/);
    expect(stderr).toContain('IFC_LITE_OCI_TOKEN');
    expect(stderr + stdout).not.toContain('wrong-secret-value');
    expect(stderr + stdout).not.toContain(PASSWORD);
    expect(reg.tags.size).toBe(0);
  });

  it('refuses conflicting credential variables before any request', async () => {
    const reg = await serve();
    process.env.IFC_LITE_OCI_TOKEN = 'tok';

    await expect(push(`oci://${reg.host}/demo/model:v1`, MODEL)).rejects.toThrow('exit 1');

    expect(stderr).toContain('are both set');
    expect(stderr).not.toContain(PASSWORD);
    expect(reg.requests).toHaveLength(0);
  });
});

describe('oci push --json', () => {
  it('prints only the result object on stdout', async () => {
    const reg = await serve();
    const ref = `oci://${reg.host}/demo/model:v1`;
    const local = await readFile(MODEL);

    await push('--json', ref, MODEL);

    expect(JSON.parse(stdout)).toEqual({
      reference: ref,
      digest: reg.tags.get('demo/model:v1'),
      layer: { digest: sha256(local), size: local.byteLength, mediaType: 'application/x-step' },
      artifactType: 'application/vnd.ifc-lite.ifc.v1',
    });
    expect(stderr).toBe('');
  });

  it('keeps stdout empty when the push fails', async () => {
    const reg = await serve();
    const ref = `oci://${reg.host}/demo/model:v1`;
    await push(ref, MODEL);
    stdout = '';

    await expect(push(ref, MODEL, '--json')).rejects.toThrow('exit 1');

    expect(stdout).toBe('');
    expect(stderr).toContain('tag v1 already exists');
  });
});
