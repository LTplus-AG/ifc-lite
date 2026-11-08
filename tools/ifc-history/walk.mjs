#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { isMainEntry } from '../../scripts/lib/is-main-entry.mjs';

const help = `Usage: node tools/ifc-history/walk.mjs <repository> [--ref HEAD] [--ifc-lite executable]
Walk first-parent IFC revisions, oldest first, using ifc-lite diff --by-content --json.
Only pairs at the same path are compared; file creation seeds a chain, deletion ends it.
One line per commit with pairs; content matches (including renamed) stay separate from unchanged.`;

/** Walk a local repository without checking out or changing its working tree. */
export async function walkHistory({ repository, ref = 'HEAD', command = ['ifc-lite'], out = console.log, timeout = 300_000 }) {
  const git = (...args) => execFileSync('git', ['-C', resolve(repository), ...args], {
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Resolve once, and terminate options: neither refs nor paths become Git flags.
  const tip = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).toString().trim();
  const commits = git('rev-list', '--first-parent', '--reverse', tip).toString().trim().split('\n');
  const scratch = mkdtempSync(join(tmpdir(), 'ifc-history-'));
  const previous = new Map();
  let parent;
  let activeChild;
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  const interrupt = () => {
    activeChild?.kill('SIGINT');
    cleanup();
    process.exit(130);
  };
  process.once('SIGINT', interrupt);
  const extract = (blob, path, destination) => {
    const stream = (args) => {
      const fd = openSync(destination, 'w');
      try {
        execFileSync('git', ['-C', resolve(repository), 'cat-file', ...args], {
          stdio: ['ignore', fd, 'pipe'], timeout,
        });
      } finally { closeSync(fd); }
    };
    let filterError;
    try { stream(['--filters', `--path=${path}`, blob]); }
    catch (error) {
      filterError = error;
      // Diagnose an unresolved pointer even when a required smudge filter fails.
      stream(['blob', blob]);
    }
    const input = openSync(destination, 'r');
    const header = Buffer.alloc(128);
    let length;
    try { length = readSync(input, header, 0, header.length, 0); }
    finally { closeSync(input); }
    if (header.subarray(0, length).toString().startsWith('version https://git-lfs.github.com/spec/v1')) {
      throw new Error('Unresolved Git LFS pointer: install/configure Git LFS and fetch the required objects before walking this repository');
    }
    if (filterError) throw filterError;
  };
  try {
    for (const commit of commits) {
      const pairs = [];
      const totals = { unchanged: 0, modified: 0, added: 0, deleted: 0 };
      const matches = new Map();
      // Explicit parent comparison includes merge results once. The top-level
      // pathspec and --no-relative keep paths stable even from a subdirectory.
      const delta = git('diff-tree', '--root', '--no-commit-id', '--raw', '-r', '-z',
        '--no-renames', '--no-relative', ...(parent ? [parent, commit] : [commit]),
        '--', ':(top,icase,glob)**/*.ifc').toString().split('\0');
      for (let i = 0; i < delta.length - 1; i += 2) {
        const [, mode, , blob] = delta[i].slice(1).split(' ');
        const path = delta[i + 1];
        const old = previous.get(path);
        if (mode !== '100644' && mode !== '100755') {
          previous.delete(path);
          continue;
        }
        if (!old || old.blob !== blob) previous.set(path, { blob, commit });
        if (!old || old.blob === blob) continue;
        try {
          const base = join(scratch, 'base.ifc');
          const head = join(scratch, 'head.ifc');
          extract(old.blob, path, base);
          extract(blob, path, head);
          const pending = promisify(execFile)(command[0], [
            ...command.slice(1), 'diff', base, head, '--by-content', '--json',
          ], { encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
          activeChild = pending.child;
          const { stdout } = await pending;
          activeChild = undefined;
          const result = JSON.parse(stdout);
          for (const key of Object.keys(totals)) {
            const count = result.counts?.[key];
            if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid diff count: ${key}`);
            totals[key] += count;
          }
          if (!Array.isArray(result.contentMatches)) throw new Error('Missing contentMatches');
          for (const match of result.contentMatches) {
            if (typeof match.kind !== 'string') throw new Error('Invalid content match kind');
            matches.set(match.kind, (matches.get(match.kind) ?? 0) + 1);
          }
          pairs.push(`${old.commit.slice(0, 12)} -> ${commit.slice(0, 12)} ${JSON.stringify(path)}`);
        } catch (error) {
          const stderr = error.stderr?.toString().trim();
          const detail = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.code === 'ENOBUFS'
            ? 'Diff output was truncated: exceeded the 256 MiB output limit' : stderr || error.message;
          throw new Error(`Pair ${old.commit} -> ${commit}, file ${JSON.stringify(path)}: ${detail}`, { cause: error });
        }
      }
      if (pairs.length) {
        const counts = Object.entries(totals).map(([kind, count]) => `${count} ${kind}`);
        const matchCounts = [...matches].sort(([a], [b]) => a.localeCompare(b))
          .map(([kind, count]) => `${count} ${kind}`);
        const matchTotal = [...matches.values()].reduce((sum, count) => sum + count, 0);
        out(`${commit.slice(0, 12)}: ${counts.join(', ')}, ${matchTotal} content-matches${matchCounts.length ? ` (${matchCounts.join(', ')})` : ''}; ${pairs.join('; ')}`);
      }
      parent = commit;
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    cleanup();
  }
}

if (isMainEntry(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      ref: { type: 'string', default: 'HEAD' },
      'ifc-lite': { type: 'string', default: 'ifc-lite' },
      help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) console.log(help);
    else {
      if (positionals.length !== 1) throw new Error(help);
      await walkHistory({ repository: positionals[0], ref: values.ref, command: [values['ifc-lite']] });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
