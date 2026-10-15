/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DoctorReport } from './diagnostics.js';

const preload = createRequire(import.meta.url).resolve('tsx');
function run(args: string[]) {
  const temporary = mkdtempSync(join(tmpdir(), 'ifclite-doctor-source-'));
  try {
    const config = join(temporary, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', paths: {} } }));
    return spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('./index.ts', import.meta.url)), ...args],
      { encoding: 'utf8', timeout: 20000, env: { ...process.env, TSX_TSCONFIG_PATH: config } });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

describe('developer diagnostic command (DX6)', () => {
  it('reports actual runtime and every declared first-party dependency through the source executable', () => {
    const result = run(['doctor', '--json']);
    expect(result.stdout.trim(), result.stderr).not.toBe('');
    const report = JSON.parse(result.stdout) as DoctorReport;
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string; dependencies: Record<string, string> };
    expect(report.reportVersion).toBe(1);
    expect(report.target).toBe('cli-installation');
    expect(report.runtime.node).toBe(process.version);
    expect(report.packages.map(item => item.name)).toEqual([manifest.name,
      // @source-text-assertion-ok selecting installed package metadata, not reading source code
      ...Object.keys(manifest.dependencies).filter(name => name.startsWith('@ifc-lite/')).sort()]);
    expect(report.packages[0].version).toBe(manifest.version);
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.stringify(report)).not.toContain(fileURLToPath(new URL('../../../', import.meta.url)));
  });
  it('has command-specific help', () => {
    const result = run(['doctor', '--help']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ifc-lite doctor');
    expect(result.stdout).toContain('--json');
  });
  it('rejects unsupported flags without emitting a success report', () => {
    const result = run(['doctor', '--not-a-flag']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: ifc-lite doctor [--json]');
    expect(result.stdout).toBe('');
  });
});
