/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { checkSheetDxf } from '../../output/sheet-dxf.mjs';
const venv = join(homedir(), 'modelling-parity/venv/bin/python');
const python = process.env.PARITY_PYTHON ?? (existsSync(venv) ? venv : 'python3');
const available = spawnSync(python, ['-c', 'import ezdxf'], { encoding: 'utf8' }).status === 0;
test('#9296 independent DXF reader rejects empty bytes', { skip: !available && 'install ezdxf==1.4.3 in PARITY_PYTHON' }, () => {
  assert.ok(checkSheetDxf(Buffer.alloc(0), python).checks.some(c => !c.ok));
});
test('#9296 independent DXF oracle accepts scale fixture and rejects empty/missing text/wrong scale', { skip: !available && 'install ezdxf==1.4.3 in PARITY_PYTHON' }, () => {
  const result = spawnSync(python, [fileURLToPath(new URL('../../output/sheet-dxf.test.py', import.meta.url))], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
