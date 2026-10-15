/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDependencyLock } from '../src/utils/dependency-lock.js';
import { resolveNpmCommand } from '../src/utils/npm-command.js';

let root: string;
let engine1: string;
let engine2: string;
let tool: string;
const npm = (args: string[], cwd: string) => {
  const resolved = resolveNpmCommand(args);
  return execFileSync(resolved.command, resolved.args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
};
function artifact(name: string, version: string, source: string, peerDependencies = {}): string {
  const dir = join(root, `${name.split('/').at(-1)}-${version}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js', peerDependencies }));
  writeFileSync(join(dir, 'index.js'), source);
  const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root], dir)) as Array<{ filename: string }>;
  return pathToFileURL(join(root, packed[0].filename)).href;
}
function project(name: string, engine: string): string {
  const dir = join(root, name); mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true, type: 'module', dependencies: {
    '@cohort/engine': engine, '@cohort/tool': tool,
  } }));
  return dir;
}
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ifclite-cohort-'));
  vi.stubEnv('npm_config_cache', join(root, 'cache'));
  vi.stubEnv('npm_config_offline', 'true');
  engine1 = artifact('@cohort/engine', '1.0.0', 'export const value = 21;');
  engine2 = artifact('@cohort/engine', '2.0.0', 'export const value = 80;');
  tool = artifact('@cohort/tool', '1.0.0', 'import {value} from "@cohort/engine"; export const answer = value * 2;', { '@cohort/engine': '^1.0.0' });
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('resolved scaffold dependency sets (DX5)', () => {
  it('writes a peer-compatible lock that npm ci installs and Node can execute', () => {
    const dir = project('compatible-consumer', engine1);
    createDependencyLock(dir);
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
    npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], dir);
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', 'import {answer} from "@cohort/tool"; console.log(answer);'], { cwd: dir, encoding: 'utf8' });
    expect(result.trim()).toBe('42');
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string; integrity: string }> };
    expect(lock.packages['node_modules/@cohort/engine'].version).toBe('1.0.0');
    // @source-text-assertion-ok npm-generated lock integrity is the artifact compatibility contract
    expect(lock.packages['node_modules/@cohort/tool'].integrity).toMatch(/^sha512-/);
  });
  it('refuses an incompatible peer cohort instead of emitting a success lock', () => {
    const dir = project('incompatible-consumer', engine2);
    expect(() => createDependencyLock(dir)).toThrow('Could not resolve a compatible scaffold dependency set');
    expect(existsSync(join(dir, 'package-lock.json'))).toBe(false);
  });
});
