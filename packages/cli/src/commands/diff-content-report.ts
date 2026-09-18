/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The human-readable report of `ifc-lite diff --by-content`; the JSON form
 *  lives with the command in `diff-content.ts`. Split out for size. */

import type { IdentityMapEntry, LineageEntry, ModelDiff } from '@ifc-lite/diff';
import type { DiffRef } from './diff-engine.js';

export function printReport(report: {
  basePath: string;
  headPath: string;
  diff: ModelDiff<DiffRef>;
  appliedCount: number;
  ignoredCount: number;
  identityIn?: string;
  written?: { path: string; entries: IdentityMapEntry[] };
  lineageIn?: string;
  lineageWritten?: { path: string; entries: LineageEntry[] };
  keyProperty?: string;
}): void {
  const { diff } = report;
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  out('');
  out(`  Base: ${report.basePath}`);
  out(`  Head: ${report.headPath}`);
  out(`  Scope: data (the CLI has no geometry pipeline)`);
  if (report.keyProperty) out(`  Key:   ${report.keyProperty} (GlobalId where absent)`);
  out('');
  out(`  Unchanged: ${diff.counts.unchanged}`);
  out(`  Modified:  ${diff.counts.modified}`);
  out(`  Added:     ${diff.counts.added}`);
  out(`  Deleted:   ${diff.counts.deleted}`);

  const byKind = new Map<string, number>();
  for (const match of diff.contentMatches ?? []) {
    byKind.set(match.kind, (byKind.get(match.kind) ?? 0) + 1);
  }
  out('');
  if (byKind.size === 0) {
    out('  Content matches: none');
  } else {
    out('  Content matches:');
    for (const [kind, count] of [...byKind].sort()) {
      out(`    ${kind.padEnd(13)} ${count}`);
    }
    out('    (renamed / moved / reshaped / respecified are resolved; the rest need a human)');
  }

  if (report.identityIn) {
    out('');
    out(`  Identity map in:  ${report.identityIn}`);
    out(`    applied: ${report.appliedCount}, ignored: ${report.ignoredCount}`);
  }
  if (report.written) {
    out('');
    out(`  Identity map out: ${report.written.path} (${report.written.entries.length} claims)`);
  }
  if (report.lineageIn) {
    out('');
    out(`  Lineage in:  ${report.lineageIn}`);
  }
  if (report.lineageWritten) {
    out('');
    out(`  Lineage out: ${report.lineageWritten.path} (${report.lineageWritten.entries.length} entries)`);
  }
  out('');
}
