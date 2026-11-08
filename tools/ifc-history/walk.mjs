#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../../scripts/lib/is-main-entry.mjs';

const help = `Usage: node tools/ifc-history/walk.mjs <repository> [--ref HEAD] [--ifc-lite executable]
Walk first-parent IFC revisions, oldest first, using ifc-lite diff --by-content --json.
Only pairs at the same path are compared; file creation seeds a chain, deletion ends it.
One line per commit with pairs; content matches (including renamed) stay separate from unchanged.`;

/** Walk a local repository without checking out or changing its working tree. */
export function walkHistory({ repository, ref = 'HEAD', command = ['ifc-lite'], out = console.log }) {
  const git = (...args) => execFileSync('git', ['-C', resolve(repository), ...args], {
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Resolve once, and terminate options: neither refs nor paths become Git flags.
  const tip = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).toString().trim();
  const commits = git('rev-list', '--first-parent', '--reverse', tip).toString().trim().split('\n');
  const scratch = mkdtempSync(join(tmpdir(), 'ifc-history-'));
  let previous = new Map();
  try {
    for (const commit of commits) {
      const current = new Map();
      const pairs = [];
      const totals = { unchanged: 0, modified: 0, added: 0, deleted: 0 };
      const matches = new Map();
      for (const entry of git('ls-tree', '-r', '-z', commit).toString().split('\0')) {
        if (!entry) continue;
        const tab = entry.indexOf('\t');
        const [mode, type, blob] = entry.slice(0, tab).split(' ');
        const path = entry.slice(tab + 1);
        if (type !== 'blob' || mode === '120000' || !path.toLowerCase().endsWith('.ifc')) continue;
        const old = previous.get(path);
        current.set(path, old?.blob === blob ? old : { blob, commit });
        if (!old || old.blob === blob) continue;
        try {
          const base = join(scratch, 'base.ifc');
          const head = join(scratch, 'head.ifc');
          writeFileSync(base, git('cat-file', 'blob', old.blob));
          writeFileSync(head, git('cat-file', 'blob', blob));
          const result = JSON.parse(execFileSync(command[0], [
            ...command.slice(1), 'diff', base, head, '--by-content', '--json',
          ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
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
          throw new Error(`Commit ${commit}, file ${JSON.stringify(path)}: ${stderr || error.message}`, { cause: error });
        }
      }
      if (pairs.length) {
        const counts = Object.entries(totals).map(([kind, count]) => `${count} ${kind}`);
        const matchCounts = [...matches].sort(([a], [b]) => a.localeCompare(b))
          .map(([kind, count]) => `${count} ${kind}`);
        const matchTotal = [...matches.values()].reduce((sum, count) => sum + count, 0);
        out(`${commit.slice(0, 12)}: ${counts.join(', ')}, ${matchTotal} content-matches${matchCounts.length ? ` (${matchCounts.join(', ')})` : ''}; ${pairs.join('; ')}`);
      }
      previous = current;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
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
      walkHistory({ repository: positionals[0], ref: values.ref, command: [values['ifc-lite']] });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
