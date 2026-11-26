/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


/**
 * The Node side of `runInstall`: files, the client CLIs, the terminal.
 * Kept apart so tests swap in an in-memory version.
 */

import {
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
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
  readFile(path: string): string | undefined;
  /** Create parent directories and write the file, through a symlink, keeping its mode. */
  writeFile(path: string, text: string): void;
  /** Copy, failing rather than overwriting an existing `to`. */
  copyFile(from: string, to: string): void;
  /** Run a program with inherited stdio (or none, `quiet`). `missing` when it is not on PATH. */
  run(command: string, args: string[], quiet?: boolean): { status: number; missing?: boolean };
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
      listDir: (path) => userFacing(() => {
        try {
          return readdirSync(path);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw err;
        }
      }),
    },
    readFile: (path) => userFacing(() => {
      try {
        return readFileSync(path, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    }),
    writeFile: (path, text) => userFacing(() => {
      const { target, mode } = writeTarget(path);
      mkdirSync(dirname(target), { recursive: true });
      // Write beside the target and rename, so a crash never leaves half a config.
      const tmp = `${target}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, text);
        if (mode !== undefined) chmodSync(tmp, mode);
        renameSync(tmp, target);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
    }),
    copyFile: (from, to) => userFacing(() => copyFileSync(from, to, constants.COPYFILE_EXCL)),
    run: (command, args, quiet) => userFacing(() => {
      const r = crossSpawn.sync(command, args, { stdio: quiet ? 'ignore' : 'inherit' });
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
  try {
    return { target: resolve(dirname(path), readlinkSync(path)) };
  } catch (err) {
    // EINVAL: a plain path, not a link. ENOENT: nothing there yet.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EINVAL') throw err;
    return { target: path };
  }
}
