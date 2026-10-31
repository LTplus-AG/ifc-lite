/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What `ifc-lite oci push` refuses, and that it refuses before talking to
 * the registry: non-IFC content, IFCZIP, references without a tag, and bad
 * `--annotation` values. Also how accepted annotations land in the manifest.
 */

import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ociCommand } from './oci.js';
import { startPushTestRegistry, type PushTestRegistry } from '../oci-push-test-registry.js';

const MODEL = resolve(__dirname, '../../../../apps/viewer/public/samples/building-architecture.ifc');
const ENV_KEYS = ['IFC_LITE_OCI_USERNAME', 'IFC_LITE_OCI_PASSWORD', 'IFC_LITE_OCI_TOKEN', 'SOURCE_DATE_EPOCH'];

let registry: PushTestRegistry;
let scratch: string;
let stdout = '';
let stderr = '';

beforeEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  registry = await startPushTestRegistry({ token: 'tok' });
  process.env.IFC_LITE_OCI_TOKEN = 'tok';
  scratch = await mkdtemp(join(tmpdir(), 'oci-push-'));
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
  await registry.close();
  await rm(scratch, { recursive: true, force: true });
});

const ref = (tagOrDigest = ':v1') => `oci://${registry.host}/demo/model${tagOrDigest}`;

async function refused(args: string[], message: string): Promise<void> {
  await expect(ociCommand(['push', ...args])).rejects.toThrow('exit 1');
  expect(stderr).toContain(message);
  expect(stdout).toBe('');
  expect(registry.requests).toHaveLength(0);
}

describe('oci push refuses non-IFC input before any request', () => {
  it('refuses a text file named .ifc', async () => {
    const file = join(scratch, 'notes.ifc');
    await writeFile(file, 'just some notes, not a model\n');
    await refused([ref(), file], `cannot push ${file}: ${file} is not a valid IFC/STEP file`);
  });

  it('refuses a truncated IFC file', async () => {
    const whole = await readFile(MODEL);
    const file = join(scratch, 'cut.ifc');
    await writeFile(file, whole.subarray(0, Math.floor(whole.byteLength / 2)));
    await refused([ref(), file], 'is truncated');
  });

  it('refuses a STEP file whose FILE_SCHEMA is not IFC', async () => {
    const file = join(scratch, 'part.ifc');
    await writeFile(file, [
      'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_NAME('part','',(''),(''),'','','');",
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));", 'ENDSEC;', 'DATA;', "#1=PRODUCT('p','p','',());", 'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n'));
    await refused([ref(), file], 'declares FILE_SCHEMA AUTOMOTIVE_DESIGN, not an IFC schema');
  });

  it('refuses a missing file', async () => {
    await refused([ref(), join(scratch, 'absent.ifc')], 'ENOENT');
  });
});

describe('oci push refuses IFCZIP', () => {
  it('refuses a .ifczip file without reading it', async () => {
    const file = join(scratch, 'model.ifczip');
    await writeFile(file, 'PK\u0003\u0004 whatever');
    await refused([ref(), file], 'only plain IFC-SPF (.ifc) models can be published for now, not IFCZIP');
  });

  it('refuses zip content even under an .ifc name', async () => {
    const file = join(scratch, 'model.ifc');
    await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
    await refused([ref(), file], 'not IFCZIP');
  });
});

describe('oci push needs a tag', () => {
  it('refuses a reference without a tag', async () => {
    await refused([ref(''), MODEL], 'the reference has no tag');
  });

  it('refuses a digest reference', async () => {
    await refused([ref(`@sha256:${'a'.repeat(64)}`), MODEL], 'a push names a tag, not a digest');
  });

  it('refuses a tag pinned to a digest too', async () => {
    await refused([ref(`:v1@sha256:${'a'.repeat(64)}`), MODEL], 'a push names a tag, not a digest');
  });

  it('refuses a path as the target', async () => {
    await refused([MODEL, ref()], 'the push target must be an oci:// reference');
  });

  it('refuses a malformed reference', async () => {
    await refused([`oci://${registry.host}/Demo/Model:v1`, MODEL], '(INVALID_REFERENCE)');
  });
});

describe('oci push --annotation', () => {
  it('adds manifest annotations, later duplicates win, created can be overridden', async () => {
    process.env.SOURCE_DATE_EPOCH = '1700000000';

    await ociCommand(['push', ref(), MODEL,
      '--annotation', 'org.opencontainers.image.revision=abc123',
      '--annotation', 'com.example.stage=draft',
      '--annotation', 'com.example.stage=issued',
      '--annotation', 'com.example.note=a=b',
      '--annotation', 'com.example.empty=',
    ]);

    expect(registry.manifestAt('demo/model', 'v1')?.annotations).toEqual({
      'com.example.empty': '',
      'com.example.note': 'a=b',
      'com.example.stage': 'issued',
      'org.buildingsmart.ifc.profile': 'ifc-release/0',
      'org.buildingsmart.ifc.schema': 'IFC4',
      'org.opencontainers.image.created': '2023-11-14T22:13:20Z',
      'org.opencontainers.image.revision': 'abc123',
      'org.opencontainers.image.title': 'building-architecture',
    });

    await ociCommand(['push', ref(':v2'), MODEL, '--annotation', 'org.opencontainers.image.created=2020-01-01T00:00:00Z']);
    expect(registry.manifestAt('demo/model', 'v2')?.annotations)
      .toMatchObject({ 'org.opencontainers.image.created': '2020-01-01T00:00:00Z' });
  });

  it('takes the manifest title from the file name, extension stripped', async () => {
    const file = join(scratch, 'Tower Rev C.IFC');
    await copyFile(MODEL, file);

    await ociCommand(['push', ref(), file]);

    const manifest = registry.manifestAt('demo/model', 'v1') as { annotations: Record<string, string>; layers: Array<{ annotations: Record<string, string> }> };
    expect(manifest.annotations['org.opencontainers.image.title']).toBe('Tower Rev C');
    expect(manifest.layers[0].annotations['org.opencontainers.image.title']).toBe('Tower Rev C.IFC');
  });

  it.each([
    [['--annotation', 'novalue'], 'is not key=value'],
    [['--annotation', '=value'], 'has an empty key'],
    [['--annotation', 'bad\nkey=value'], 'cannot contain a line break'],
    [['--annotation', 'org.opencontainers.image.title=Other'], 'cannot set org.opencontainers.image.title'],
    [['--annotation', 'org.buildingsmart.ifc.profile=other'], 'cannot set org.buildingsmart.ifc.profile'],
    [['--annotation', 'org.buildingsmart.ifc.schema=IFC2X3'], 'cannot set org.buildingsmart.ifc.schema'],
    [['--annotation'], '--annotation needs a key=value argument'],
    [['--tag', 'x'], 'unknown option --tag'],
  ])('refuses %j before any request', async (extra, message) => {
    await refused([ref(), MODEL, ...extra], message);
  });

  it.each(['-1', '1.5', 'yesterday'])('refuses SOURCE_DATE_EPOCH=%s before any request', async (value) => {
    process.env.SOURCE_DATE_EPOCH = value;
    await refused([ref(), MODEL], 'SOURCE_DATE_EPOCH must be a non-negative integer');
  });
});
