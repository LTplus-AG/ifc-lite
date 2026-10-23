/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { diagnoseInstallation } from '../diagnostics.js';
import { printJson } from '../output.js';

/** Inspect local CLI dependencies without loading IFC, geometry or GPU modules. */
export async function doctorCommand(args: string[]): Promise<void> {
  if (args.some(argument => argument !== '--json')) throw new Error('Usage: ifc-lite doctor [--json]');
  const report = diagnoseInstallation();
  if (args.includes('--json')) printJson(report);
  else {
    const lines = ['IFClite installation checks',
      `[${report.runtime.status}] Node ${report.runtime.node} (${report.runtime.platform}/${report.runtime.arch}), required ${report.runtime.requirement ?? 'unknown'}`,
      ...report.packages.map(item => `[${item.status}] ${item.name}: ${item.version ?? 'unknown'}${item.code ? ` (${item.code})` : ''}`),
      `[${report.wasm.status}] WASM binary: ${report.wasm.code}${report.wasm.byteLength !== undefined ? ` (${report.wasm.byteLength} bytes)` : ''}`,
      report.ok ? 'All reported checks passed.' : 'Repair the reported runtime or package installation errors, then rerun doctor.'];
    process.stdout.write(lines.join('\n') + '\n');
  }
  if (!report.ok) process.exitCode = 1;
}
