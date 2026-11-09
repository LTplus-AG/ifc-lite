/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `readModelInput` against a real registry on 127.0.0.1: the bytes, the
 * credentials that reached the wire, layer selection, and every failure the
 * user can hit (exit 1 through `fatal`, never a credential in the output).
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readModelInput } from './model-input.js';
import { parseModelReference } from './oci-input.js';
import { sha256, startTestRegistry, type TestAccess, type TestRegistry } from './oci-test-helpers.js';

const SAMPLE_IFC = resolve(__dirname, '../../../apps/viewer/public/samples/building-architecture.ifc');
const ENV_KEYS = ['IFC_LITE_OCI_USERNAME', 'IFC_LITE_OCI_PASSWORD', 'IFC_LITE_OCI_TOKEN', 'IFC_LITE_OCI_MAX_BYTES'];
const USER = 'ci-bot';
const PASSWORD = 'pa55-word-never-printed';

let registry: TestRegistry | undefined;
let stderr = '';
let stdout = '';

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  stderr = '';
  stdout = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
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

async function serve(access: TestAccess = { username: USER, password: PASSWORD }): Promise<TestRegistry> {
  registry = await startTestRegistry(access);
  return registry;
}

function useBasic(password = PASSWORD): void {
  process.env.IFC_LITE_OCI_USERNAME = USER;
  process.env.IFC_LITE_OCI_PASSWORD = password;
}

const text = (s: string) => new TextEncoder().encode(s);

describe('readModelInput', () => {
  it('returns the same bytes for a local path and an oci:// pull of that file', async () => {
    const local = await readModelInput(SAMPLE_IFC);
    const reg = await serve();
    reg.push('fixtures/model', 'v1', [{ bytes: local.bytes, mediaType: 'application/x-step', title: 'building-architecture.ifc' }]);
    useBasic();

    const ref = `oci://${reg.host}/fixtures/model:v1`;
    const pulled = await readModelInput(ref);

    expect(Buffer.from(pulled.bytes).equals(Buffer.from(await readFile(SAMPLE_IFC)))).toBe(true);
    expect(local).toMatchObject({ label: SAMPLE_IFC, name: 'building-architecture.ifc' });
    expect(pulled.label).toBe(ref);
    expect(pulled.name).toBe('building-architecture.ifc');
  });

  it('exchanges username/password at the realm and pulls with the issued token', async () => {
    const reg = await serve();
    reg.push('team/model', 'v1', [{ bytes: text('ISO-10303-21;'), mediaType: 'application/x-step' }]);
    useBasic();

    const input = await readModelInput(`oci://${reg.host}/team/model:v1`);

    expect(input.name).toBe('model:v1');
    const realm = reg.requests.filter((r) => r.url.startsWith('/token'));
    expect(realm.at(-1)?.authorization).toBe(`Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`);
    expect(new URLSearchParams(realm.at(-1)?.url.split('?')[1]).get('scope')).toBe('repository:team/model:pull');
    const blob = reg.requests.find((r) => r.url.includes('/blobs/'));
    expect(blob?.authorization).toBe('Bearer issued-by-realm');
  });

  it('sends IFC_LITE_OCI_TOKEN as a bearer token straight to the registry', async () => {
    const reg = await serve({ token: 'static-token-123' });
    reg.push('team/model', 'v1', [{ bytes: text('ISO-10303-21;'), mediaType: 'application/x-step' }]);
    process.env.IFC_LITE_OCI_TOKEN = 'static-token-123';

    await readModelInput(`oci://${reg.host}/team/model:v1`);

    expect(reg.requests.some((r) => r.url.startsWith('/token'))).toBe(false);
    const authorized = reg.requests.filter((r) => r.authorization !== undefined);
    expect(authorized.length).toBeGreaterThan(0);
    expect(authorized.every((r) => r.authorization === 'Bearer static-token-123')).toBe(true);
  });

  it('names a digest-pinned layer without a title by repository and short digest', async () => {
    const reg = await serve();
    const digest = reg.push('team/model', 'v1', [{ bytes: text('ISO-10303-21;'), mediaType: 'application/octet-stream' }]);
    useBasic();

    const input = await readModelInput(`oci://${reg.host}/team/model@${digest}`);

    expect(input.name).toBe(`model@${digest.slice(0, 'sha256:'.length + 12)}`);
  });
});

describe('readModelInput layer selection', () => {
  it('picks the one IFC layer of a multi-layer artifact, by title or media type', async () => {
    const reg = await serve();
    const ifc = text('ISO-10303-21;\nIFC LAYER');
    reg.push('team/model', 'titled', [
      { bytes: text('# readme'), mediaType: 'text/markdown', title: 'README.md' },
      { bytes: ifc, mediaType: 'application/octet-stream', title: 'models/Tower.IFC' },
    ], 'application/vnd.ifcx-oci.ifc.v1');
    reg.push('team/model', 'typed', [
      { bytes: ifc, mediaType: 'application/x-step' },
      { bytes: text('{}'), mediaType: 'application/json', title: 'meta.json' },
    ]);
    useBasic();

    const titled = await readModelInput(`oci://${reg.host}/team/model:titled`);
    const typed = await readModelInput(`oci://${reg.host}/team/model:typed`);

    expect(new TextDecoder().decode(titled.bytes)).toBe('ISO-10303-21;\nIFC LAYER');
    expect(titled.name).toBe('Tower.IFC');
    expect(new TextDecoder().decode(typed.bytes)).toBe('ISO-10303-21;\nIFC LAYER');
  });

  it('refuses an artifact with two IFC layers and lists every layer', async () => {
    const reg = await serve();
    const a = text('ISO-10303-21; A');
    const b = text('ISO-10303-21; B');
    reg.push('team/model', 'v1', [
      { bytes: a, mediaType: 'application/x-step', title: 'arch.ifc' },
      { bytes: b, mediaType: 'application/octet-stream', title: 'struct.ifczip' },
    ]);
    useBasic();
    const ref = `oci://${reg.host}/team/model:v1`;

    await expect(readModelInput(ref)).rejects.toThrow('exit 1');

    expect(stderr).toContain(`Error: cannot open ${ref}: the manifest has 2 layers and 2 of its layers look like IFC models`);
    expect(stderr).toContain(`arch.ifc  application/x-step  ${a.byteLength} bytes  ${sha256(a)}`);
    expect(stderr).toContain(`struct.ifczip  application/octet-stream  ${b.byteLength} bytes  ${sha256(b)}`);
    expect(reg.requests.some((r) => r.url.includes('/blobs/'))).toBe(false);
  });

  it('refuses a multi-layer artifact with no IFC layer', async () => {
    const reg = await serve();
    reg.push('team/model', 'v1', [
      { bytes: text('a'), mediaType: 'text/plain', title: 'a.txt' },
      { bytes: text('b'), mediaType: 'text/plain' },
    ]);
    useBasic();

    await expect(readModelInput(`oci://${reg.host}/team/model:v1`)).rejects.toThrow('exit 1');

    expect(stderr).toContain('none of its layers is an IFC model');
    expect(stderr).toContain('a.txt  text/plain');
    expect(stderr).toContain('(no title)  text/plain');
  });

  it('refuses an index and lists its entries instead of choosing one', async () => {
    const reg = await serve();
    const one = reg.push('team/model', 'a', [{ bytes: text('A'), mediaType: 'application/x-step' }]);
    const two = reg.push('team/model', 'b', [{ bytes: text('B'), mediaType: 'application/x-step' }]);
    reg.pushIndex('team/model', 'multi', [one, two]);
    useBasic();

    await expect(readModelInput(`oci://${reg.host}/team/model:multi`)).rejects.toThrow('exit 1');

    expect(stderr).toContain('it names an index of 2 manifests');
    expect(stderr).toContain(one);
    expect(stderr).toContain(two);
  });
});

describe('readModelInput failures', () => {
  it('rejects a wrong password with exit 1, an authentication hint, and no password in the output', async () => {
    const reg = await serve();
    reg.push('team/model', 'v1', [{ bytes: text('x'), mediaType: 'application/x-step' }]);
    useBasic('wrong-secret-value');
    const ref = `oci://${reg.host}/team/model:v1`;

    await expect(readModelInput(ref)).rejects.toThrow('exit 1');

    expect(stderr).toMatch(new RegExp(`^Error: cannot open ${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\((UNAUTHORIZED|DENIED)\\)`));
    expect(stderr).toMatch(/unauthorized/);
    expect(stderr).toContain('IFC_LITE_OCI_USERNAME');
    expect(stderr).toContain('IFC_LITE_OCI_TOKEN');
    expect(stderr + stdout).not.toContain('wrong-secret-value');
    expect(stderr + stdout).not.toContain(PASSWORD);
  });

  it('reports an anonymous pull from a private registry as unauthorized', async () => {
    const reg = await serve();
    reg.push('team/model', 'v1', [{ bytes: text('x'), mediaType: 'application/x-step' }]);

    await expect(readModelInput(`oci://${reg.host}/team/model:v1`)).rejects.toThrow('exit 1');

    expect(stderr).toContain('(UNAUTHORIZED)');
    expect(stderr).toContain('authentication');
  });

  it.each([
    [{ IFC_LITE_OCI_USERNAME: USER }, 'IFC_LITE_OCI_USERNAME is set but IFC_LITE_OCI_PASSWORD is not'],
    [{ IFC_LITE_OCI_PASSWORD: PASSWORD }, 'IFC_LITE_OCI_PASSWORD is set but IFC_LITE_OCI_USERNAME is not'],
    [{ IFC_LITE_OCI_USERNAME: USER, IFC_LITE_OCI_PASSWORD: PASSWORD, IFC_LITE_OCI_TOKEN: 'tok' }, 'are both set'],
    [{ IFC_LITE_OCI_MAX_BYTES: '1.5' }, 'IFC_LITE_OCI_MAX_BYTES must be a positive integer'],
    [{ IFC_LITE_OCI_MAX_BYTES: '0' }, 'IFC_LITE_OCI_MAX_BYTES must be a positive integer'],
  ])('refuses misconfigured environment %o before any request', async (env, message) => {
    const reg = await serve();
    Object.assign(process.env, env);

    await expect(readModelInput(`oci://${reg.host}/team/model:v1`)).rejects.toThrow('exit 1');

    expect(stderr).toContain(message);
    expect(stderr).not.toContain(PASSWORD);
    expect(reg.requests).toHaveLength(0);
  });

  it('enforces IFC_LITE_OCI_MAX_BYTES on the layer before downloading it', async () => {
    const reg = await serve();
    const layer = new Uint8Array(4096).fill(65);
    reg.push('team/model', 'v1', [{ bytes: layer, mediaType: 'application/x-step' }]);
    useBasic();
    process.env.IFC_LITE_OCI_MAX_BYTES = '1024';

    await expect(readModelInput(`oci://${reg.host}/team/model:v1`)).rejects.toThrow('exit 1');

    expect(stderr).toContain('(SIZE_EXCEEDED)');
    expect(reg.requests.some((r) => r.url.includes('/blobs/'))).toBe(false);

    process.env.IFC_LITE_OCI_MAX_BYTES = '4096';
    expect((await readModelInput(`oci://${reg.host}/team/model:v1`)).bytes.byteLength).toBe(4096);
  });

  it('reports a missing tag with its code', async () => {
    await serve();
    useBasic();
    const ref = `oci://${registry?.host}/team/model:absent`;

    await expect(readModelInput(ref)).rejects.toThrow('exit 1');

    expect(stderr).toContain(`Error: cannot open ${ref} (NOT_FOUND):`);
  });

  it('leaves a missing local path to throw the readFile error, as before', async () => {
    await expect(readModelInput('/nonexistent/model.ifc')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(process.exit).not.toHaveBeenCalled();
  });
});

describe('parseModelReference', () => {
  it('uses plain http only for loopback hosts, on any port', () => {
    expect(parseModelReference('oci://127.0.0.1:5000/fixtures/model:v1').origin).toBe('http://127.0.0.1:5000');
    expect(parseModelReference('oci://localhost:8080/a/b:v1').origin).toBe('http://localhost:8080');
    expect(parseModelReference('oci://[::1]:5000/a/b:v1').origin).toBe('http://[::1]:5000');
    expect(parseModelReference('oci://ghcr.io/acme/model:v1').origin).toBe('https://ghcr.io');
    expect(parseModelReference('oci://registry.example.com:5000/a/b:v1').origin).toBe('https://registry.example.com:5000');
    expect(parseModelReference('oci://127.0.0.2:5000/a/b:v1').origin).toBe('https://127.0.0.2:5000');
  });
});
