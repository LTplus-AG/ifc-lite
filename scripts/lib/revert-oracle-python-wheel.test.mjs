/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preparePythonWheel } from './revert-oracle-python-wheel.mjs';

const backend = `from pathlib import Path
from zipfile import ZipFile

def get_requires_for_build_wheel(config_settings=None):
    return []

def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    name = 'build_probe-0.1-py3-none-any.whl'
    info = 'build_probe-0.1.dist-info/'
    with ZipFile(Path(wheel_directory) / name, 'w') as wheel:
        wheel.write(Path(__file__).parent / 'build_probe.py', 'build_probe.py')
        wheel.writestr(info + 'METADATA', 'Metadata-Version: 2.1\\nName: build-probe\\nVersion: 0.1\\n')
        wheel.writestr(info + 'WHEEL', 'Wheel-Version: 1.0\\nGenerator: revert-oracle-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
        wheel.writestr(info + 'RECORD', '')
    return name
`;

test('#5800: a wheel test imports separately built baseline and reverted source states', { timeout: 120_000 }, (t) => {
  const interpreter = process.env.PYTHON ?? 'python3';
  const probe = spawnSync(interpreter, ['-m', 'pip', '--version'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('Python with pip is unavailable');
  const root = mkdtempSync(join(tmpdir(), 'oracle-wheel-state-'));
  const stale = join(root, 'stale');
  mkdirSync(stale);
  writeFileSync(join(stale, 'build_probe.py'), "VALUE = 'stale'\n");
  writeFileSync(join(root, 'pyproject.toml'), '[build-system]\nrequires = []\nbuild-backend = "backend"\nbackend-path = ["."]\n');
  writeFileSync(join(root, 'backend.py'), backend);
  const options = {
    cwd: root, encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, PYTHONPATH: stale },
  };
  const load = (value) => {
    writeFileSync(join(root, 'build_probe.py'), `VALUE = '${value}'\n`);
    const wheel = preparePythonWheel(root, { bin: interpreter, prefix: [] }, options);
    try {
      const imported = spawnSync(wheel.bin, ['-c', 'import build_probe; print(build_probe.VALUE)'], {
        ...options, env: wheel.env,
      });
      assert.equal(imported.status, 0, imported.stderr);
      return { value: imported.stdout.trim(), python: wheel.bin };
    } finally {
      wheel.cleanup();
      assert.equal(existsSync(wheel.bin), false);
    }
  };
  try {
    const baseline = load('baseline');
    const reverted = load('reverted');
    assert.equal(baseline.value, 'baseline');
    assert.equal(reverted.value, 'reverted');
    assert.notEqual(baseline.python, reverted.python);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
