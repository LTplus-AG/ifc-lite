/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkSheetDxf(bytes, python = process.env.PARITY_PYTHON) {
  const venv = join(homedir(), 'modelling-parity/venv/bin/python');
  const result = spawnSync(python ?? (existsSync(venv) ? venv : 'python3'),
    [fileURLToPath(new URL('./sheet-dxf.py', import.meta.url))], { input: bytes ?? Buffer.alloc(0), encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) return { reader: 'ezdxf', checks: [{ name: 'independent DXF reader available', ok: false, detail: result.error?.message ?? result.stderr }] };
  try { return JSON.parse(result.stdout); }
  catch (error) { return { checks: [{ name: 'independent reader JSON', ok: false, detail: error.message }] }; }
}
