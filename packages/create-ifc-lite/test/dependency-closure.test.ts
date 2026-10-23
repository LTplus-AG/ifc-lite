/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({ versions: {} as Record<string, string[]>, dependencies: {} as Record<string, Record<string, string>> }));
vi.mock('child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFileSync: (_command: string, args: string[]) => {
    const argv = args[0] === '/d' ? args.slice(4) : args;
    const [, spec, field] = argv;
    if (field === 'versions') return Buffer.from(JSON.stringify(registry.versions[spec] ?? []));
    if (field === 'dependencies') return Buffer.from(JSON.stringify(registry.dependencies[spec] ?? {}));
    throw new Error(`Unexpected registry request: ${argv.join(' ')}`);
  },
  spawnSync: () => ({ status: 0, stdout: '[]', stderr: '' }),
}));
let getPackageVersion: typeof import('../src/utils/config-fixers.js')['getPackageVersion'];
beforeEach(async () => {
  vi.resetModules();
  registry.versions = {}; registry.dependencies = {};
  ({ getPackageVersion } = await import('../src/utils/config-fixers.js'));
});

describe('published dependency closure through the existing version API (DX5)', () => {
  it('does not select a root whose transitive dependency was never published', () => {
    registry.versions = { pkg: ['1.0.0', '2.0.0'], '@ifc-lite/bridge': ['1.0.0'], '@ifc-lite/leaf': ['2.0.0'] };
    registry.dependencies = { 'pkg@2.0.0': { '@ifc-lite/bridge': '^1.0.0' }, '@ifc-lite/bridge@1.0.0': { '@ifc-lite/leaf': '^3.0.0' } };
    expect(getPackageVersion('pkg')).toBe('^1.0.0');
  });
  it('bounds a large acyclic closure and reports why it refused', () => {
    registry.versions.pkg = ['1.0.0'];
    registry.dependencies['pkg@1.0.0'] = { '@ifc-lite/p0': '^1.0.0' };
    for (let i = 0; i < 130; i++) {
      registry.versions[`@ifc-lite/p${i}`] = ['1.0.0'];
      if (i < 129) registry.dependencies[`@ifc-lite/p${i}@1.0.0`] = { [`@ifc-lite/p${i + 1}`]: '^1.0.0' };
    }
    let refusal: unknown;
    try { getPackageVersion('pkg'); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(Error);
    if (!(refusal instanceof Error) || !(refusal.cause instanceof Error)) throw new Error('Missing structured refusal cause');
    expect(refusal.cause.message).toBe('Scaffold dependency validation exceeds 128 package versions');
  });
});
