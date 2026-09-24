/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Build and install the current source state, never a cached or preinstalled wheel. */
export function preparePythonWheel(projectDir, interpreter, options) {
  const scratch = mkdtempSync(join(tmpdir(), 'revert-oracle-python-wheel-'));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  const venv = join(scratch, 'venv');
  const wheels = join(scratch, 'wheels');
  const python = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const env = { ...options.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  const run = (bin, args, stage) => {
    // A cold PyO3 release build can exceed the ordinary test runner's 10m cap.
    const result = spawnSync(bin, args, { ...options, env, timeout: 45 * 60 * 1000 });
    if (result.error || result.signal || result.status !== 0) {
      const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
      throw new Error(`${stage} failed (${result.signal ?? result.status ?? result.error?.message}): ${detail}`);
    }
  };
  try {
    run(interpreter.bin, [...interpreter.prefix, '-m', 'venv', '--system-site-packages', venv], 'Python virtual environment');
    run(python, ['-m', 'pip', 'wheel', '--no-cache-dir', '--no-deps', '--wheel-dir', wheels, projectDir], 'Python wheel build');
    const built = readdirSync(wheels).filter((name) => name.endsWith('.whl'));
    if (built.length !== 1) throw new Error(`Python wheel build produced ${built.length} wheels; expected exactly one`);
    run(python, ['-m', 'pip', 'install', '--no-index', '--no-deps', '--force-reinstall', join(wheels, built[0])], 'Python wheel install');
    return { bin: python, env, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
