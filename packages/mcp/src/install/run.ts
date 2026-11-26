/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite-mcp install` and `ifc-lite mcp install`: register this server
 * with an MCP client in one step.
 *
 * File-based clients get their config merged (other servers kept, a backup
 * written first). Claude Code and VS Code's user profile get their own CLI
 * run, because that is their documented way in. `--dry-run` prints what
 * would happen and touches nothing.
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPackageVersion, UNKNOWN_VERSION } from '@ifc-lite/data/node';
import { isMcpValueFlag } from '../cli-args.js';
import {
  CLIENTS,
  CLIENT_LABELS,
  InstallError,
  isClientId,
  planInstall,
  type ClientId,
  type HostEnv,
  type InstallPlan,
  type InstallScope,
  type ServerCommand,
} from './clients.js';
import { mergeServer } from './merge.js';

/** Everything `runInstall` does to the outside world, so tests can fake it. */
export interface InstallIo {
  host: HostEnv;
  /** File contents, or undefined when the file does not exist. */
  readFile(path: string): string | undefined;
  /** Create parent directories and write the file. */
  writeFile(path: string, text: string): void;
  copyFile(from: string, to: string): void;
  /** Run a program with inherited stdio. `missing` when it is not on PATH. */
  run(command: string, args: string[]): { status: number; missing?: boolean };
  out(text: string): void;
  err(text: string): void;
  now(): Date;
}

export function nodeInstallIo(): InstallIo {
  return {
    host: { platform: process.platform, home: homedir(), cwd: process.cwd(), env: process.env },
    readFile(path) {
      try {
        return readFileSync(path, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    },
    writeFile(path, text) {
      mkdirSync(dirname(path), { recursive: true });
      // Write beside the target and rename, so a crash never leaves half a config.
      const tmp = `${path}.ifc-lite-tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, path);
    },
    copyFile: (from, to) => copyFileSync(from, to),
    run(command, args) {
      const r = spawnSync(command, args, { stdio: 'inherit' });
      if (r.error) {
        if ((r.error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 127, missing: true };
        throw r.error;
      }
      return { status: r.status ?? 1 };
    },
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    now: () => new Date(),
  };
}

export function installHelp(invokedAs: string): string {
  return `
  Usage: ${invokedAs} --client <${CLIENTS.join('|')}> [options] [model.ifc…] [-- server flags]

  Registers ifc-lite-mcp with an MCP client. Model paths and --allow values
  are made absolute. Flags after -- go to the server, e.g. -- --bridge.

  Options:
    --client <id>           Which client to configure (required).
    --scope <user|project>  user (default): all your projects. project: this
                            directory (.mcp.json, .cursor/, .vscode/).
    --name <name>           Server name in the client (default ifc-lite).
    --dry-run               Print the config or command; change nothing.
    --force                 Replace an existing entry with the same name.

  Examples:
    ${invokedAs} --client claude-code
    ${invokedAs} --client claude-desktop ./model.ifc
    ${invokedAs} --client cursor --scope project -- --bridge
    ${invokedAs} --client vscode --dry-run
`;
}

interface InstallArgs {
  client: ClientId;
  scope: InstallScope;
  name: string;
  dryRun: boolean;
  force: boolean;
  serverArgs: string[];
}

function parseInstallArgs(argv: string[], cwd: string): InstallArgs | 'help' {
  let client: string | undefined;
  let scope = 'user';
  let name = 'ifc-lite';
  let dryRun = false;
  let force = false;
  const files: string[] = [];
  let passThrough: string[] = [];
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith('-')) throw new InstallError(`${flag} needs a value.`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { passThrough = argv.slice(i + 1); break; }
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--client') client = value(++i, arg);
    else if (arg === '--scope') scope = value(++i, arg);
    else if (arg === '--name') name = value(++i, arg);
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--force') force = true;
    else if (arg.startsWith('-')) {
      throw new InstallError(`Unknown option ${arg}. Server flags go after --, e.g. -- ${arg}.`);
    } else files.push(arg);
  }
  if (client === undefined) throw new InstallError(`--client is required: one of ${CLIENTS.join(', ')}.`);
  if (!isClientId(client)) throw new InstallError(`Unknown client "${client}". Use one of ${CLIENTS.join(', ')}.`);
  if (scope !== 'user' && scope !== 'project') throw new InstallError('--scope must be user or project.');
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new InstallError('--name may use letters, digits, - and _ only.');
  return { client, scope, name, dryRun, force, serverArgs: absolutePaths([...files, ...passThrough], cwd) };
}

/**
 * The client starts the server from a directory we do not know, so model
 * paths and `--allow` roots are fixed to absolute paths now.
 */
function absolutePaths(args: string[], cwd: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--transport') {
      throw new InstallError('Clients start ifc-lite-mcp over stdio; drop --transport. For HTTP, give the client the server URL.');
    }
    out.push(arg.startsWith('-') ? arg : abs(arg, cwd));
    if (isMcpValueFlag(arg) && i + 1 < args.length) {
      i++;
      out.push(arg === '--allow' ? abs(args[i], cwd) : args[i]);
    }
  }
  return out;
}

function abs(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** `npx` pinned to this release line, so the flags written here are ones it knows. */
export function serverCommand(version: string, serverArgs: string[]): ServerCommand {
  const spec = version === UNKNOWN_VERSION ? '@ifc-lite/mcp' : `@ifc-lite/mcp@^${version}`;
  return { command: 'npx', args: ['-y', spec, ...serverArgs] };
}

function packageVersion(): string {
  return readPackageVersion(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'));
}

function quote(arg: string, platform: NodeJS.Platform): string {
  if (/^[\w@%+=:,./^-]+$/.test(arg)) return arg;
  if (platform === 'win32') return `"${arg.replace(/"/g, '\\"')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function commandLine(plan: Extract<InstallPlan, { kind: 'command' }>, platform: NodeJS.Platform): string {
  return [plan.command, ...plan.args].map((a) => quote(a, platform)).join(' ');
}

function backupPath(path: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `${path}.bak-${stamp}`;
}

/** Returns the process exit code. */
export function runInstall(
  argv: string[],
  io: InstallIo = nodeInstallIo(),
  invokedAs = 'ifc-lite-mcp install',
  version: string = packageVersion(),
): number {
  try {
    const args = parseInstallArgs(argv, io.host.cwd);
    if (args === 'help') {
      io.out(installHelp(invokedAs));
      return 0;
    }
    const plan = planInstall(args.client, args.scope, args.name, serverCommand(version, args.serverArgs), io.host);
    const label = CLIENT_LABELS[args.client];
    return plan.kind === 'command'
      ? runCommandPlan(plan, args, label, io)
      : writeFilePlan(plan, args, label, io);
  } catch (err) {
    if (!(err instanceof InstallError)) throw err;
    io.err(`[ifc-lite-mcp install] ${err.message}\n`);
    return 1;
  }
}

function runCommandPlan(
  plan: Extract<InstallPlan, { kind: 'command' }>,
  args: InstallArgs,
  label: string,
  io: InstallIo,
): number {
  const line = commandLine(plan, io.host.platform);
  if (args.dryRun) {
    io.out(`${line}\n`);
    return 0;
  }
  if (args.force && args.client === 'claude-code') {
    // `claude mcp add` refuses an existing name; remove ours first. A
    // non-zero exit here only means there was nothing to remove.
    io.run('claude', ['mcp', 'remove', '--scope', args.scope, args.name]);
  }
  const result = io.run(plan.command, plan.args);
  if (result.missing) {
    io.err(`[ifc-lite-mcp install] \`${plan.command}\` is not on PATH. Run this yourself:\n${line}\n`);
    return 1;
  }
  if (result.status !== 0) {
    const hint = args.client === 'claude-code' ? ' If the name is taken, pass --force or --name.' : '';
    io.err(`[ifc-lite-mcp install] \`${plan.command}\` exited with ${result.status}.${hint}\n`);
    return result.status;
  }
  io.err(`[ifc-lite-mcp install] added "${args.name}" to ${label}.\n`);
  return 0;
}

function writeFilePlan(
  plan: Extract<InstallPlan, { kind: 'file' }>,
  args: InstallArgs,
  label: string,
  io: InstallIo,
): number {
  const before = io.readFile(plan.path);
  let merged;
  try {
    merged = mergeServer(before, plan.key, args.name, plan.entry, args.force);
  } catch (err) {
    if (!(err instanceof InstallError)) throw err;
    const snippet = JSON.stringify({ [plan.key]: { [args.name]: plan.entry } }, null, 2);
    throw new InstallError(`Not changing ${plan.path}: ${err.message}. Add this by hand:\n${snippet}`);
  }
  if (merged.status === 'unchanged') {
    io.err(`[ifc-lite-mcp install] ${plan.path} already has this "${args.name}" entry.\n`);
    return 0;
  }
  if (merged.status === 'conflict') {
    throw new InstallError(
      `${plan.path} already has a different "${args.name}" entry:\n${JSON.stringify(merged.existing, null, 2)}\n` +
        'Pass --force to replace it, or --name to add another.',
    );
  }
  if (args.dryRun) {
    io.err(`[ifc-lite-mcp install] would write ${plan.path}:\n`);
    io.out(merged.text);
    return 0;
  }
  let backup = '';
  if (before !== undefined) {
    const to = backupPath(plan.path, io.now());
    io.copyFile(plan.path, to);
    backup = ` (backup: ${to})`;
  }
  io.writeFile(plan.path, merged.text);
  io.err(
    `[ifc-lite-mcp install] ${merged.status} "${args.name}" in ${plan.path}${backup}. ` +
      `Restart ${label} to load it.\n`,
  );
  return 0;
}
