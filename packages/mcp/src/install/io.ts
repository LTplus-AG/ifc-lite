/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Node side of `runInstall`: files, the client CLIs, the terminal.
 * Kept apart so tests swap in an in-memory version.
 */

import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
// Resolves Windows `.cmd` shims (`claude.cmd`, `code.cmd`) that a bare spawn cannot run.
import crossSpawn from 'cross-spawn';
import { InstallError, type HostEnv } from './clients.js';

/** Everything `runInstall` does to the outside world, so tests can fake it. */
export interface InstallIo {
  host: HostEnv;
  /** File contents, or undefined when the file does not exist. */
  readConfig(path: string): string | undefined;
  /** Replace the config through an atomic rename, optionally backing up the existing file first. */
  writeFile(path: string, text: string, expected: string | undefined, backupTo?: string): void;
  /** Run a program with inherited stdio. `missing` when it is not on PATH. */
  run(command: string, args: string[]): { status: number; missing?: boolean };
  out(text: string): void;
  err(text: string): void;
  now(): Date;
}

export function nodeInstallIo(): InstallIo {
  return {
    host: {
      platform: process.platform,
      home: homedir(),
      cwd: process.cwd(),
      env: process.env,
      warn: (text) => process.stderr.write(note(text)),
      isFile: (path) => userFacing(() => orIfMissing(() => statSync(path).isFile(), false)),
      listDir: (path) => userFacing(() => orIfMissing(() => readdirSync(path), [])),
    },
    readConfig: (path) => userFacing(() => orIfMissing(() => readFileSync(path, 'utf-8'), undefined)),
    writeFile: (path, text, expected, backupTo) => userFacing(() => {
      const { target, mode } = writeTarget(path);
      mkdirSync(dirname(target), { recursive: true });
      const lock = `${target}.ifc-lite-install.lock`;
      let fd: number;
      try {
        fd = openSync(lock, 'wx');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new InstallError(`Config is locked (${lock}); retry after the other installer exits. If a crashed install left this lock, delete it only once no install is running.`);
        }
        throw err;
      }
      // Write beside the target so the rename publishes the complete file at once.
      const tmp = `${target}.${process.pid}.tmp`;
      const checkCurrent = () => {
        if (writeTarget(path).target !== target || orIfMissing(() => readFileSync(target, 'utf-8'), undefined) !== expected) {
          throw new InstallError(`${path} changed during install; retry to merge with its latest contents.`);
        }
      };
      let backedUp = false;
      try {
        rmSync(tmp, { force: true }); // A crashed run may have left a temp file.
        writeFileSync(tmp, text, { mode: mode ?? 0o666, flag: 'wx' });
        if (mode !== undefined) chmodSync(tmp, mode); // undo the umask
        checkCurrent();
        if (backupTo !== undefined && expected !== undefined) {
          copyFileSync(target, backupTo, constants.COPYFILE_EXCL);
          backedUp = true;
          checkCurrent();
        }
        // The lock covers cooperating installers. An external writer can
        // still change the config between the last check and this rename.
        renameSync(tmp, target);
      } catch (err) {
        rmSync(tmp, { force: true });
        if (backedUp && (err instanceof InstallError || typeof (err as NodeJS.ErrnoException).syscall === 'string')) {
          throw new InstallError(`${(err as Error).message} Install did not replace the config (backup: ${backupTo}).`);
        }
        throw err;
      } finally {
        closeSync(fd);
        rmSync(lock);
      }
    }),
    run: (command, args) => userFacing(() => {
      const r = crossSpawn.sync(command, args, { stdio: 'inherit' });
      if (r.error) {
        if ((r.error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 127, missing: true };
        throw r.error;
      }
      return { status: r.status ?? 1 };
    }),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    now: () => new Date(),
  };
}

/** One stderr line from install. */
export function note(text: string): string {
  return `[ifc-lite-mcp install] ${text}\n`;
}

/** `fn()`, or `fallback` when the path does not exist. */
function orIfMissing<T, F>(fn: () => T, fallback: F): T | F {
  try {
    return fn();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

/** A file-system or spawn failure (EACCES, EROFS, ...) is the user's to fix: report it, do not crash. */
function userFacing<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (typeof (err as NodeJS.ErrnoException).syscall === 'string') throw new InstallError((err as Error).message);
    throw err;
  }
}

/**
 * Where a config write really lands, and the mode to keep. A dotfiles
 * symlink stays a symlink: its target is written, even when that target
 * does not exist yet.
 */
function writeTarget(path: string): { target: string; mode?: number } {
  try {
    const target = realpathSync(path);
    return { target, mode: statSync(target).mode & 0o7777 };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Dangling: follow the chain of links to the missing end (realpath would have looped past 40).
  let target = path;
  for (let hop = 0; hop < 40; hop++) {
    try {
      target = resolve(dirname(target), readlinkSync(target));
    } catch (err) {
      // EINVAL: not a link, so this is the end. ENOENT: nothing there yet.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EINVAL') throw err;
      return { target };
    }
  }
  throw new InstallError(`${path}: too many levels of symbolic links`);
}
