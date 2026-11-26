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

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackageVersion, UNKNOWN_VERSION } from '@ifc-lite/data/node';
import {
  CLIENTS,
  InstallError,
  isClientId,
  planInstall,
  type ClientId,
  type CommandPlan,
  type FilePlan,
  type HostEnv,
  type InstallScope,
  type ServerCommand,
} from './clients.js';
import { canonical, describeEntry, mergeServer } from './merge.js';
import { checkServerArgs, EXIT_FLAGS } from './server-args.js';
import { isMcpValueFlag, MCP_BOOLEAN_FLAGS } from '../cli-args.js';
import { nodeInstallIo, type InstallIo } from './io.js';

const CLIENT_IDS = Object.keys(CLIENTS);

function installHelp(invokedAs: string): string {
  return `
  Usage: ${invokedAs} --client <${CLIENT_IDS.join('|')}> [options] [model.ifc…] [-- server flags]

  Registers ifc-lite-mcp with an MCP client. Model paths and --allow values
  are made absolute. Flags after -- go to the server, e.g. -- --bridge.

  Options:
    --client <id>           Which client to configure (required).
    --scope <user|project>  user (default): all your projects. project: this
                            directory (.mcp.json, .cursor/, .vscode/).
    --name <name>           Server name in the client (default ifc-lite).
    --dry-run               Print the config or command; change nothing.
    --force                 Replace an existing entry with the same name.
                            File clients update their own older entry without
                            it; Claude Code needs it to update.

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
  /** serverArgs holds model paths or --allow roots, which only exist on this machine. */
  hasPaths: boolean;
}

function parseInstallArgs(argv: string[], host: HostEnv): InstallArgs | 'help' {
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
      if (EXIT_FLAGS.includes(arg)) throw new InstallError(`${arg} is not an install option.`);
      const own = arg.match(/^(--(?:client|scope|name))=/);
      if (own) throw new InstallError(`Write ${own[1]} <value>, with a space.`);
      const serverFlag = isMcpValueFlag(arg) || MCP_BOOLEAN_FLAGS.includes(arg);
      throw new InstallError(serverFlag ? `${arg} is a server flag; put it after --, e.g. -- ${arg}.` : `Unknown option ${arg}.`);
    } else files.push(arg);
  }
  if (client === undefined) throw new InstallError(`--client is required: one of ${CLIENT_IDS.join(', ')}.`);
  if (!isClientId(client)) throw new InstallError(`Unknown client "${client}". Use one of ${CLIENT_IDS.join(', ')}.`);
  if (scope !== 'user' && scope !== 'project') throw new InstallError('--scope must be user or project.');
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new InstallError('--name may use letters, digits, - and _ only.');
  const { args: serverArgs, hasPaths } = checkServerArgs([...files, ...passThrough], host);
  return { client, scope, name, dryRun, force, serverArgs, hasPaths };
}

/**
 * True when writing `entry` over `existing` changes nothing but a pin that
 * install itself writes (`@ifc-lite/mcp` or `@ifc-lite/mcp@^x.y.z`). Keys the
 * user added (env, cwd) stay either way; a hand-picked pin such as `@1.2.3`
 * or `@latest` is not ours to move.
 */
function onlyPinDiffers(existing: unknown, entry: Record<string, unknown>): boolean {
  if (typeof existing !== 'object' || existing === null) return false;
  const unpin = (e: object): string | undefined => {
    const { args } = e as { args?: unknown };
    if (!Array.isArray(args)) return undefined;
    const pins = args.filter((x) => typeof x === 'string' && x.startsWith('@ifc-lite/mcp'));
    if (pins.length !== 1 || !OUR_PIN.test(pins[0] as string)) return undefined;
    return canonical({ ...e, args: args.map((x) => (x === pins[0] ? '@ifc-lite/mcp' : x)) });
  };
  const before = unpin(existing);
  return before !== undefined && before === unpin({ ...existing, ...entry });
}

const OUR_PIN = /^@ifc-lite\/mcp(@\^\d+\.\d+\.\d+)?$/;

/** `npx` pinned to this release line, so the flags written here are ones it knows. */
function serverCommand(version: string, serverArgs: string[]): ServerCommand {
  const spec = version === UNKNOWN_VERSION ? '@ifc-lite/mcp' : `@ifc-lite/mcp@^${version}`;
  return { command: 'npx', args: ['-y', spec, ...serverArgs] };
}

function packageVersion(): string {
  return readPackageVersion(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'));
}

/** Quote for a POSIX shell, or for cmd.exe (where `^` escapes and `""` is a literal quote). */
function quote(arg: string, platform: NodeJS.Platform): string {
  // `,` `;` `=` stay quoted: cmd splits on them when the target is a .cmd shim.
  if (platform === 'win32') return /^[\w@+:./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
  // `^` stays quoted: zsh with EXTENDED_GLOB reads it as a glob.
  if (/^[\w@+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function commandLine(command: string, args: string[], platform: NodeJS.Platform): string {
  return [command, ...args].map((a) => quote(a, platform)).join(' ');
}

/** Milliseconds in the name, and the copy refuses to overwrite, so no backup is lost. */
function backupPath(path: string, now: Date): string {
  const stamp = now.toISOString().replace(/\D/g, '').replace(/^(\d{8})/, '$1-');
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
    const args = parseInstallArgs(argv, io.host);
    if (args === 'help') {
      io.out(installHelp(invokedAs));
      return 0;
    }
    const plan = planInstall(args.client, args.scope, args.name, serverCommand(version, args.serverArgs), io.host);
    if (args.scope === 'project' && args.hasPaths) {
      io.err('[ifc-lite-mcp install] note: the project file gets absolute paths, which only work on this machine.\n');
    }
    const label = CLIENTS[args.client];
    return plan.kind === 'command'
      ? runCommandPlan(plan, args, label, io)
      : writeFilePlan(plan, args, label, io);
  } catch (err) {
    // InstallError is the user's to fix (a usage error, EACCES via the io seam); anything else is a bug.
    if (!(err instanceof InstallError)) throw err;
    io.err(`[ifc-lite-mcp install] ${err.message}\n`);
    return 1;
  }
}

function runCommandPlan(
  plan: CommandPlan,
  args: InstallArgs,
  label: string,
  io: InstallIo,
): number {
  const remove = args.force ? plan.remove : undefined;
  if (args.force && !plan.remove) {
    io.err(`[ifc-lite-mcp install] --force has no effect here; \`${plan.command}\` decides what happens to an existing "${args.name}".\n`);
  }
  const line = commandLine(plan.command, plan.args, io.host.platform);
  if (args.dryRun) {
    if (remove) io.out(`${commandLine(plan.command, remove, io.host.platform)}\n`);
    io.out(`${line}\n`);
    return 0;
  }
  // A non-zero exit from the remove step only means there was nothing to remove.
  const removed = remove !== undefined && io.run(plan.command, remove, true).status === 0;
  const result = io.run(plan.command, plan.args);
  if (result.missing) {
    io.err(`[ifc-lite-mcp install] \`${plan.command}\` is not on PATH. Run this yourself:\n${line}\n`);
    return 1;
  }
  if (result.status !== 0) {
    let hint = '';
    if (removed) hint = ` The old "${args.name}" entry was already removed; fix the error and run again:\n${line}`;
    else if (plan.remove) hint = ' If the name is taken, pass --force or --name.';
    io.err(`[ifc-lite-mcp install] \`${plan.command}\` exited with ${result.status}.${hint}\n`);
    return result.status;
  }
  io.err(`[ifc-lite-mcp install] added "${args.name}" to ${label}.\n`);
  return 0;
}

function writeFilePlan(
  plan: FilePlan,
  args: InstallArgs,
  label: string,
  io: InstallIo,
): number {
  const before = io.readFile(plan.path);
  let merged;
  try {
    merged = mergeServer(before, plan.key, args.name, plan.entry, args.force);
    // Our own entry from an older release (only the version pin differs) is updated without --force.
    if (merged.status === 'conflict' && onlyPinDiffers(merged.existing, plan.entry)) {
      merged = mergeServer(before, plan.key, args.name, plan.entry, true);
    }
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
      `${plan.path} already has a different "${args.name}" entry:\n${describeEntry(merged.existing)}\n` +
        'Pass --force to replace it, or --name to add another.',
    );
  }
  if (args.dryRun) {
    // Only our entry: the rest of the file can hold other servers' secrets.
    io.err(`[ifc-lite-mcp install] would ${merged.status === 'added' ? 'add' : 'replace'} this in ${plan.path}, keeping everything else:\n`);
    io.out(`${JSON.stringify({ [plan.key]: { [args.name]: plan.entry } }, null, 2)}\n`);
    if (merged.kept.length) io.err(`[ifc-lite-mcp install] the entry keeps its own ${merged.kept.join(', ')}.\n`);
    return 0;
  }
  let backup = '';
  if (before !== undefined) {
    const to = backupPath(plan.path, io.now());
    io.copyFile(plan.path, to);
    backup = ` (backup: ${to}${args.scope === 'project' ? ', it holds the old contents; keep it out of git' : ''})`;
  }
  try {
    io.writeFile(plan.path, merged.text);
  } catch (err) {
    if (backup && err instanceof InstallError) throw new InstallError(`${err.message}; the file is unchanged${backup}`);
    throw err;
  }
  io.err(
    `[ifc-lite-mcp install] ${merged.status} "${args.name}" in ${plan.path}${backup}. ` +
      `Restart ${label} to load it.\n`,
  );
  return 0;
}
