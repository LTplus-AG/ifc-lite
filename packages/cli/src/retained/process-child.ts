// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { exportCommand } from '../commands/export.js';
import { logger, type LogLevel } from '../logger.js';
import { routeConsoleDiagnosticsToStderr } from '../output.js';

// Private entry point, not a CLI flag or an environment bypass. All retained
// WASM initialization stays in this process, including the main-thread engine.
try {
  const { args, level }: { args: string[]; level: LogLevel } = JSON.parse(await readFile(process.argv[2], 'utf8'));
  logger.configure({ level });
  routeConsoleDiagnosticsToStderr();
  await exportCommand(args, { retainedChild: true });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
