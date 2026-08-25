#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ratchet: a workflow may not discard the exit status of a `git push`.
 *
 * `|| true` on `git tag` is correct — a backfill or a re-run hits an existing
 * tag and idempotency is the point. On the PUSH it is a different thing
 * entirely, and `release.yml` had it on both `v*` tag pushes (#3202).
 *
 * WHY THE FAILURE IS SILENT-AND-WRONG RATHER THAN LOUD-AND-ABSENT, which is
 * what makes this worth a gate rather than a code review note: a swallowed push
 * does not yield "no release". `gh release create` CREATES a missing tag itself,
 * and with no `--target` it does so "from the latest state of the default
 * branch" — its own `--help` says so. So the run continues, the release exists,
 * every check is green, and the tag points at a DIFFERENT commit than the
 * packages published from it. `packages/server-bin/src/binary.ts` then resolves
 * its download URL from that tag, and its fallback chain can find a STALE
 * archive, which is worse than a 404.
 *
 * The interaction that makes it likely rather than theoretical: the fix added
 * after the 2026-08-12 incident introduced a BACKFILL path so a later run can
 * tag a version whose tag went missing. A backfill by definition runs after
 * `main` has moved on — so the code path added to recover from the previous
 * incident is the one most exposed to this one.
 *
 * SCOPE is `.github/workflows/**`, and the baseline is ZERO: this gate is added
 * in the same change that removes the only two instances, so it never has to
 * grandfather anything. If a legitimate swallowed push ever appears, the
 * escape hatch is an `# allow-swallowed-push <reason>` comment on the line
 * above, which this check NAMES in its output rather than hiding.
 *
 * Run via `node scripts/check-swallowed-push.mjs` (CI node-test job).
 * `--root <dir>` points it at a mutated copy of the tree; that is how
 * `check-swallowed-push.test.mjs` proves it fires.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const ROOT =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? process.argv[rootFlag + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..');

const WORKFLOW_DIR = '.github/workflows';
export const MARKER = 'allow-swallowed-push';

/**
 * A `git push` whose failure is discarded.
 *
 * `|| true` and `|| :` are the two spellings that mean "ignore this"; `:` is a
 * shell no-op and reads as decorative, which is exactly why it is worth naming.
 *
 * The no-op may be followed by a COMMAND-LIST DELIMITER rather than end of line.
 * A push chained with `; echo continuing` discards its status just as
 * thoroughly, and an end-of-line-only rule walks straight past it. `;`, `&`,
 * `|` and `)` all continue the line while leaving the status discarded.
 * Reported by CodeRabbit on #3208.
 */
export const SWALLOWED_PUSH = /\bgit\s+push\b[^\n]*?\|\|\s*(?:true|:)\s*(?:$|[#;&|)])/;

/** Every `.yml`/`.yaml` under the workflow directory. */
export function workflowFiles(root) {
  const dir = join(root, WORKFLOW_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

/** `{ line, text }` for every swallowed push, minus marked ones. */
export function findSwallowedPushes(source) {
  const lines = source.split('\n');
  const hits = [];
  const marked = [];
  lines.forEach((line, i) => {
    if (!SWALLOWED_PUSH.test(line)) return;
    const above = lines[i - 1] ?? '';
    if (above.includes(MARKER) || line.includes(MARKER)) {
      marked.push({ line: i + 1, text: line.trim() });
      return;
    }
    hits.push({ line: i + 1, text: line.trim() });
  });
  return { hits, marked };
}

// Only run the gate when invoked as a script; the self-test imports the helpers.
if (process.argv[1] && process.argv[1].endsWith('check-swallowed-push.mjs')) {
  const files = workflowFiles(ROOT);
  // Fail closed: an empty workflow directory means the scan root moved, not
  // that every workflow is clean. Absence must not read as success.
  if (files.length === 0) {
    console.error(
      `\nNo workflow files found under ${WORKFLOW_DIR}. The scan root has moved, ` +
        `so this check examined nothing — which is not the same as finding nothing.\n`,
    );
    process.exit(1);
  }

  const offenders = [];
  const markedSites = [];
  for (const file of files) {
    const rel = relative(ROOT, file).split('\\').join('/');
    const { hits, marked } = findSwallowedPushes(readFileSync(file, 'utf8'));
    for (const h of hits) offenders.push(`${rel}:${h.line}  ${h.text}`);
    for (const m of marked) markedSites.push(`${rel}:${m.line}  ${m.text}`);
  }

  if (offenders.length > 0) {
    console.error('\nA `git push` whose failure is discarded:\n');
    for (const o of offenders) console.error(`  ${o}`);
    console.error(`
\`|| true\` on \`git tag\` is fine — a re-run hits an existing tag and idempotency
is the point. On the PUSH it means a network, auth or ref-lock failure becomes a
silent no-op and the job continues as though the ref reached the remote.

That does not produce "no release". \`gh release create\` creates a missing tag
itself, from the latest state of the DEFAULT BRANCH when no \`--target\` is given,
so the run stays green and the tag points at a different commit than the packages
published from it (#3202).

Drop the \`|| true\` so the failure is loud where it happens, and pass
\`--verify-tag\` to \`gh release create\` so it cannot invent the ref instead.

If a swallowed push is genuinely right somewhere, say why on the line above:

  # ${MARKER}: <reason>
  git push origin "$TAG" || true

Marked sites stay NAMED in this check's output; they are not exemptions in the dark.
`);
    process.exit(1);
  }

  console.log(
    `check-swallowed-push: OK (${files.length} workflow files, ${markedSites.length} marked)`,
  );
  for (const m of markedSites) console.log(`  marked: ${m}`);
}
