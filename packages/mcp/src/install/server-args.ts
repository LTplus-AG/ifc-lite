/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The server flags `install` writes, checked the way the server will read
 * them. A flag set the server would ignore, exit on or refuse is refused
 * here, because once written it fails silently at every client launch.
 */

import { posix, win32 } from 'node:path';
import { bridgeConflict, isMcpValueFlag, MCP_BOOLEAN_FLAGS, parseArgs } from '../cli-args.js';
import { InstallError, type HostEnv } from './clients.js';

/** Read only by the HTTP transport, which an installed server never runs. */
const HTTP_ONLY_FLAGS = ['--port', '--host', '--token'];
/** Server flags that print and exit; `--help`/`-h` are install's own. */
export const EXIT_FLAGS = ['--help', '-h', '--version', '-v'];
/** Value flags that only act next to another flag. */
const NEEDS: Record<string, { flag: string; ok: (o: ReturnType<typeof parseArgs>) => boolean }> = {
  '--bridge-port': { flag: '--bridge', ok: (o) => o.bridge === true },
  '--bridge-viewer-url': { flag: '--bridge', ok: (o) => o.bridge === true },
  '--viewer-port': { flag: '--viewer or --open', ok: (o) => o.autoViewer },
};

/** Model paths and `--allow` roots are made absolute: the client's cwd is unknown. */
export function checkServerArgs(argv: string[], host: HostEnv): { args: string[]; hasPaths: boolean } {
  const { args, hasPaths } = walk(argv, host);
  const parsed = parseArgs(args);
  if (parsed.transport !== 'stdio') {
    throw new InstallError('Clients start ifc-lite-mcp over stdio; drop --transport. For HTTP, give the client the server URL.');
  }
  const conflict = bridgeConflict(parsed);
  if (conflict) throw new InstallError(conflict);
  // loader.ts's exact rule, so what it refuses at load is refused here (its '/'-only
  // join also refuses Windows paths today; install says so rather than write it).
  const roots = parsed.allowedPaths ?? [];
  const outside = roots.length > 0 && parsed.files.find((f) => !roots.some((r) => f === r || f.startsWith(r + '/')));
  if (outside) {
    const why = host.platform === 'win32' ? ' (on Windows the server cannot match --allow roots yet)' : '';
    throw new InstallError(`${outside} is outside every --allow root; the server would refuse it${why}.`);
  }
  if (!parsed.bridge && (parsed.insecure || parsed.allowedOrigins)) {
    throw new InstallError('--insecure and --allow-origin only act with --bridge here; for HTTP, give the client the server URL.');
  }
  for (const [flag, need] of Object.entries(NEEDS)) {
    if (args.includes(flag) && !need.ok(parsed)) throw new InstallError(`${flag} does nothing without ${need.flag}.`);
  }
  if (!Number.isInteger(parsed.viewerPort) || parsed.viewerPort < 0 || parsed.viewerPort > 65535) {
    throw new InstallError('--viewer-port must be an integer from 0 to 65535 (0 picks a free port).');
  }
  if (parsed.openBrowser) host.warn('--open opens a browser tab every time the client starts the server.');
  return { args, hasPaths };
}

/**
 * The server's argv as it will be written, walked once the way the server
 * reads it. Whatever the server would ignore or exit on (a typo such as
 * --readonly, --x=y, a value flag with no value, --version) is refused here,
 * because once written it fails silently at every launch. The client starts
 * the server from a directory we do not know, so model paths and `--allow`
 * roots are made absolute.
 */
function walk(args: string[], host: HostEnv): { args: string[]; hasPaths: boolean } {
  const path = host.platform === 'win32' ? win32 : posix;
  let hasPaths = false;
  const abs = (p: string) => {
    hasPaths = true;
    // resolve, not isAbsolute: a Windows `\\dir\\m.ifc` also needs its drive.
    return path.resolve(host.cwd, p);
  };
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '') {
      throw new InstallError('An empty argument would become this directory; is a variable unset?');
    } else if (!arg.startsWith('-')) {
      const model = abs(arg);
      if (!host.isFile(model)) throw new InstallError(`No model file at ${model}.`);
      out.push(model);
    } else if (arg.includes('=')) {
      throw new InstallError(`The server reads ${arg.split('=')[0]} <value>, with a space; it would ignore ${arg}.`);
    } else if (HTTP_ONLY_FLAGS.includes(arg)) {
      throw new InstallError(`${arg} is for --transport http; clients start the server over stdio.`);
    } else if (isMcpValueFlag(arg)) {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) throw new InstallError(`${arg} needs a value.`);
      i++;
      out.push(arg, arg === '--allow' ? abs(value) : value);
    } else if (EXIT_FLAGS.includes(arg)) {
      throw new InstallError(`${arg} makes the server print and exit at every launch; drop it.`);
    } else if (MCP_BOOLEAN_FLAGS.includes(arg)) {
      out.push(arg);
    } else {
      throw new InstallError(`The server has no ${arg} flag (ifc-lite-mcp --help lists them).`);
    }
  }
  return { args: out, hasPaths };
}
