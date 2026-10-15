/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
type Status = 'ok' | 'error';
export interface PackageDiagnostic {
  name: string;
  version: string | null;
  status: Status;
  code?: string;
}
export interface BinaryDiagnostic {
  status: Status;
  code: 'VALID_WASM_BINARY' | 'WASM_BINARY_INVALID' | 'WASM_BINARY_UNAVAILABLE' | 'WASM_VALIDATION_UNAVAILABLE';
  byteLength?: number;
  sha256?: string;
}
export interface DoctorReport {
  reportVersion: 1;
  target: 'cli-installation';
  ok: boolean;
  runtime: { node: string; platform: string; arch: string; requirement: string | null; status: Status; code?: string };
  packages: PackageDiagnostic[];
  wasm: BinaryDiagnostic;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

function resolveEntry(name: string): string {
  // Prefer the same ESM export condition the CLI uses. Older Node versions
  // can still inspect packages that expose a CommonJS/default resolution.
  const path = typeof import.meta.resolve === 'function'
    ? fileURLToPath(import.meta.resolve(name)) : require.resolve(name);
  if (!statSync(path).isFile()) throw new Error('Package entry is not a file');
  return path;
}

/** Resolve from this CLI installation, without executing package entry points. */
function inspectPackage(name: string): { diagnostic: PackageDiagnostic; nodeRequirement?: string; dependencies?: string[] } {
  let entry: string;
  try { entry = resolveEntry(name); }
  catch (error) { return { diagnostic: { name, version: null, status: 'error',
    code: record(error) && error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
      ? 'ESM_RESOLUTION_UNAVAILABLE' : 'PACKAGE_ENTRY_UNAVAILABLE' } }; }
  try {
    let directory = dirname(entry);
    while (true) {
      let manifest: unknown;
      try { manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')); }
      catch (error) {
        if (!(record(error) && error.code === 'ENOENT')) throw error;
      }
      if (record(manifest) && manifest.name === name) {
        if (typeof manifest.version !== 'string' || !manifest.version)
          return { diagnostic: { name, version: null, status: 'error', code: 'PACKAGE_VERSION_UNAVAILABLE' } };
        const engines = manifest.engines;
        return { diagnostic: { name, version: manifest.version, status: 'ok' },
          nodeRequirement: record(engines) && typeof engines.node === 'string' ? engines.node : undefined,
          dependencies: record(manifest.dependencies) ? Object.keys(manifest.dependencies).filter(dependency => dependency.startsWith('@ifc-lite/')).sort() : [] };
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    return { diagnostic: { name, version: null, status: 'error', code: 'PACKAGE_METADATA_UNAVAILABLE' } };
  }
  return { diagnostic: { name, version: null, status: 'error', code: 'PACKAGE_METADATA_UNAVAILABLE' } };
}

/** Structural WASM validation only; no module initialization or geometry work. */
export function inspectWasmBinary(path: string): BinaryDiagnostic {
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch { return { status: 'error', code: 'WASM_BINARY_UNAVAILABLE' }; }
  const details = { byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  const api: unknown = Reflect.get(globalThis, 'WebAssembly');
  if (!record(api) || typeof api.validate !== 'function')
    return { status: 'error', code: 'WASM_VALIDATION_UNAVAILABLE', ...details };
  try {
    const valid: unknown = api.validate(bytes);
    if (typeof valid !== 'boolean') return { status: 'error', code: 'WASM_VALIDATION_UNAVAILABLE', ...details };
    return { status: valid ? 'ok' : 'error',
      code: valid ? 'VALID_WASM_BINARY' : 'WASM_BINARY_INVALID', ...details };
  } catch { return { status: 'error', code: 'WASM_VALIDATION_UNAVAILABLE', ...details }; }
}

function runtime(requirement?: string): DoctorReport['runtime'] {
  const base = { node: process.version, platform: process.platform, arch: process.arch, requirement: requirement ?? null };
  // Interpret the CLI's declared minimum, not a second hardcoded Node floor.
  const minimum = requirement?.match(/^>=(\d+)\.(\d+)\.(\d+)$/);
  if (!minimum) return { ...base, status: 'error', code: 'NODE_REQUIREMENT_UNKNOWN' };
  const current = process.versions.node.split('.').map(Number);
  const required = minimum.slice(1).map(Number);
  const difference = current.findIndex((part, index) => part !== required[index]);
  const supported = difference === -1 || current[difference] > required[difference];
  return { ...base, status: supported ? 'ok' : 'error', ...(supported ? {} : { code: 'NODE_VERSION_UNSUPPORTED' }) };
}

export function diagnoseInstallation(): DoctorReport {
  const cli = inspectPackage('@ifc-lite/cli');
  const inspected = [cli, ...(cli.dependencies ?? []).map(inspectPackage)];
  const node = runtime(cli.nodeRequirement);
  let wasm: BinaryDiagnostic;
  try { wasm = inspectWasmBinary(resolveEntry('@ifc-lite/wasm/ifc-lite_bg.wasm')); }
  catch { wasm = { status: 'error', code: 'WASM_BINARY_UNAVAILABLE' }; }
  const packages = inspected.map(item => item.diagnostic);
  return { reportVersion: 1, target: 'cli-installation',
    ok: node.status === 'ok' && wasm.status === 'ok' && packages.every(item => item.status === 'ok'),
    runtime: node, packages, wasm };
}
