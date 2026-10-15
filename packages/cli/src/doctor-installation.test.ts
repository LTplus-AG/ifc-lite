/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DoctorReport } from './diagnostics.js';

const packages = fileURLToPath(new URL('../../', import.meta.url));
// Minimal valid WASM module: the diagnostic promises binary validation,
// independently of IFC bindings, module initialization or geometry.
const validModule = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
function installation(check: (root: string, run: (flags?: string[]) => { status: number | null; report: DoctorReport }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'ifclite-doctor-install-'));
  try {
    const cli = JSON.parse(readFileSync(join(packages, 'cli/package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> };
    // @source-text-assertion-ok selecting installed package metadata for an actual package-layout fixture
    const names = new Set([cli.name, ...Object.keys(cli.dependencies).filter(name => name.startsWith('@ifc-lite/'))]);
    for (const folder of readdirSync(packages)) {
      const manifestPath = join(packages, folder, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string };
      if (!names.has(manifest.name)) continue;
      const destination = join(root, 'node_modules', manifest.name);
      mkdirSync(destination, { recursive: true });
      cpSync(manifestPath, join(destination, 'package.json'));
      if (manifest.name === '@ifc-lite/wasm') {
        mkdirSync(join(destination, 'pkg'));
        writeFileSync(join(destination, 'pkg/ifc-lite.js'), 'export {};');
        writeFileSync(join(destination, 'pkg/ifc-lite_bg.wasm'), validModule);
      } else cpSync(join(packages, folder, 'dist'), join(destination, 'dist'), { recursive: true });
    }
    const run = (flags: string[] = []) => {
      const result = spawnSync(process.execPath, [...flags, join(root, 'node_modules/@ifc-lite/cli/dist/index.js'), 'doctor', '--json'],
        { cwd: root, encoding: 'utf8', timeout: 20000 });
      expect(result.stdout.trim(), result.stderr).not.toBe('');
      return { status: result.status, report: JSON.parse(result.stdout) as DoctorReport };
    };
    check(root, run);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('diagnostics from isolated built package artifacts (DX6)', () => {
  it('validates binary structure without importing IFC bindings or third-party dependencies', () => installation((_root, run) => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.wasm).toMatchObject({ code: 'VALID_WASM_BINARY', byteLength: validModule.length });
  }));
  it('reports a runtime with WASM disabled', () => installation((_root, run) => {
    const result = run(['--jitless']);
    expect(result.status).toBe(1);
    expect(result.report.wasm.code).toBe('WASM_VALIDATION_UNAVAILABLE');
  }));
  it('reports a missing WASM binary and exits unsuccessfully', () => installation((root, run) => {
    unlinkSync(join(root, 'node_modules/@ifc-lite/wasm/pkg/ifc-lite_bg.wasm'));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.report.wasm.code).toBe('WASM_BINARY_UNAVAILABLE');
  }));
  it('reports corrupt WASM bytes', () => installation((root, run) => {
    writeFileSync(join(root, 'node_modules/@ifc-lite/wasm/pkg/ifc-lite_bg.wasm'), 'not wasm');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.report.wasm.code).toBe('WASM_BINARY_INVALID');
  }));
  it('still starts when an IFC package entry is absent', () => installation((root, run) => {
    unlinkSync(join(root, 'node_modules/@ifc-lite/sdk/dist/index.js'));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.report.packages.find(item => item.name === '@ifc-lite/sdk')?.code).toBe('PACKAGE_ENTRY_UNAVAILABLE');
  }));
  it('reads the runtime requirement from installed package metadata', () => installation((root, run) => {
    const path = join(root, 'node_modules/@ifc-lite/cli/package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { engines: { node: string } };
    manifest.engines.node = '>=999.0.0';
    writeFileSync(path, JSON.stringify(manifest));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.report.runtime).toMatchObject({ requirement: '>=999.0.0', code: 'NODE_VERSION_UNSUPPORTED' });
  }));
});
