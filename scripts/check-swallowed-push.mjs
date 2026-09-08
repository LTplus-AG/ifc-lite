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
 * What may precede a `git push` for it to be a COMMAND rather than an ARGUMENT.
 *
 * Without this, folding a continuation makes
 *
 * ```sh
 * echo "hello" \
 * git push origin "v2" || true
 * ```
 *
 * look like a swallowed push, when the shell sees `echo` consuming the rest and
 * pushes nothing.
 *
 * PERMISSIVE ON PURPOSE. A first version accepted only start-of-line, a few
 * separators and `run:`, and review found it missed `{ git push … || true; }`,
 * `if git push … || true; then`, `! git push …` and `FOO=1 git push …` — all
 * genuine command position. For a release-safety gate a MISS is far worse than
 * a false positive: a miss defeats the gate's whole purpose silently, while a
 * false positive is visible and has the `allow-swallowed-push` marker as its
 * escape hatch. So this errs toward matching, and only rejects a push sitting
 * after a plain word or quote, which is the one shape that provably is not a
 * command.
 */
const COMMAND_POSITION =
  '(?:^|[;&|(){}!]|\\brun:|\\b(?:if|then|else|elif|do|while|until)\\b|\\b[A-Za-z_][A-Za-z0-9_]*=\\S*)\\s*';

/**
 * The push's OWN arguments: everything up to its FIRST `||`, and no further.
 *
 * With `[^\n]*?` the match could run past this push's handler and adopt a LATER
 * command's one, so
 *
 * ```sh
 * git push origin "$TAG" || exit 1; cleanup || echo cleanup-failed
 * ```
 *
 * was reported even though the push exits loudly and only the independent
 * `cleanup` is swallowed.
 *
 * A first attempt at that excluded `;`, `&` and `|` outright, and review found
 * it FAILED OPEN on the most ordinary thing in a workflow:
 *
 * ```sh
 * git push origin main 2>&1 || true              # missed
 * git push origin main >/dev/null 2>&1 || true   # missed
 * git push origin "a|b" || true                  # missed
 * ```
 *
 * The `&` in `2>&1` is a redirection, not a separator, and a `|` inside quotes
 * is not a pipe. Character classes cannot tell those apart. So this stops at
 * the two things that genuinely end a command's handler chain -- a `;` and the
 * `||` itself -- and lets everything else through, which keeps the miss
 * direction closed at the cost of over-flagging a backgrounded push. That is
 * the right way round for a release-safety gate.
 */
const OWN_ARGS = '(?:(?!\\|\\||;)[^\\n])*?';

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
export const SWALLOWED_PUSH =
  new RegExp(`${COMMAND_POSITION}git\\s+push\\b${OWN_ARGS}\\|\\|\\s*(?:true|:)\\s*(?:$|[#;&|)])`);

/**
 * A `git push` whose failure is handled by a command that CANNOT fail the step.
 *
 * ```sh
 * git push origin "$TAG" || echo "push failed, continuing"
 * ```
 *
 * Under `set -e` the `||` handles the failure, `echo` returns 0, and the job
 * continues. That swallows exactly as thoroughly as `|| true`.
 *
 * AN ALLOWLIST, NOT "ANY COMMAND", and the difference is the whole finding.
 * #3212 proposed widening to any handler. A review of that widening measured
 * what it does to the idiom this gate PUSHES PEOPLE TOWARD:
 *
 * ```sh
 * git push origin "v1" || exit 1                      # correct, was flagged
 * git push origin main || { echo "..."; exit 1; }     # correct, was flagged
 * ```
 *
 * Verified in bash: `false || exit 1` exits 1, `false || echo x` exits 0. So
 * `|| exit 1` is the textbook loud-failure form — the thing an author reaches
 * for when this gate rejects their `|| true` — and flagging it makes the gate
 * contradict its own printed remedy. `|| return 1`, `|| false`, `|| exit $?`
 * and `|| die "msg"` are the same.
 *
 * Enumerating every TERMINATING handler is a losing game (`{ …; exit 1; }`,
 * a shell function, a trap). Enumerating the harmless ones is not: `echo` and
 * `printf` cannot fail a step, whatever their arguments. So the alternation
 * only grows when someone shows a real swallow it misses, and it can never
 * flag a correct one.
 */
export const HANDLED_PUSH =
  new RegExp(`${COMMAND_POSITION}git\\s+push\\b${OWN_ARGS}\\|\\|\\s*(?:true\\b|:|echo\\b|printf\\b)`);

/** Every `.yml`/`.yaml` under the workflow directory. */
export function workflowFiles(root) {
  const dir = join(root, WORKFLOW_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
}

/**
 * Fold backslash continuations into LOGICAL lines (#3212).
 *
 * The rule has to see what the SHELL sees. Matching per physical line walks
 * straight past a swallow split across a continuation, because neither half
 * matches alone:
 *
 * ```sh
 * git push origin "v${VERSION}" \
 *   || true
 * ```
 *
 * Same family as the `;`/`&`/`|`/`)` chaining gap: the rule seeing less than
 * the shell does.
 *
 * WHERE THIS TECHNIQUE IS KNOWN TO BREAK, because this repo has already paid
 * for it: `source-text-assertion-detect.mjs` used to walk lines with a
 * `CONTINUES` regex, an interior comment stripped to blank, the walk stopped
 * early, and CI failed twice printing a remedy that did not work. It was
 * replaced by a real parser. This is safe at that same shape only because the
 * fold is unconditional and the only consumer of `joined` is a regex requiring
 * `git push` — folding a line that is not shell cannot invent a hit. If this
 * ever needs to know what IS shell, it needs a parser, not another regex.
 *
 * Reports the FIRST physical line number, so the output points at somewhere a
 * reader can find; a synthetic number over the joined text would be worse than
 * the gap it closes.
 */
function logicalLines(physical) {
  const out = [];
  for (let i = 0; i < physical.length; i += 1) {
    const line = i + 1;
    let joined = physical[i];
    // Where each physical line begins inside `joined`, so a match can be
    // attributed to the push it is about rather than to the group's first line.
    const starts = [{ line, at: 0 }];
    // `\\` is an escaped backslash and ends the line for real, so parity is
    // what decides, not presence.
    while (/\\*$/.exec(joined)[0].length % 2 === 1 && i + 1 < physical.length) {
      i += 1;
      joined = joined.slice(0, -1);
      starts.push({ line: i + 1, at: joined.length + 1 });
      joined = `${joined} ${physical[i].trim()}`;
    }
    out.push({ line, joined, starts });
  }
  return out;
}

/** `{ line, text }` for every swallowed push, minus marked ones. */
export function findSwallowedPushes(source) {
  const physical = source.split('\n');
  const hits = [];
  const marked = [];
  // Global copies so `lastIndex` can walk every push in one folded group.
  const scanAll = new RegExp(HANDLED_PUSH.source, 'g');
  for (const { joined, starts } of logicalLines(physical)) {
    scanAll.lastIndex = 0;
    let m;
    while ((m = scanAll.exec(joined)) !== null) {
      // ONE ENTRY PER PUSH. Folding makes a chained pair
      // (`git push mirror … || true; git push origin … || true`) a single
      // logical line, and one-entry-per-group both under-reported the second
      // push and let a marker written for the first silently exempt it — the
      // push vanished from the report rather than being listed as marked.
      // Offset of the PUSH ITSELF, not of the match: the pattern consumes a
      // leading command separator (`;`, `&`, `|`, `(`), so `m.index` can sit on
      // the previous physical line and attribute the hit to the wrong push.
      const at = m.index + Math.max(0, m[0].search(/\bgit\s+push\b/));
      // The physical line this push STARTS on, so the report points at it.
      let line = starts[0].line;
      for (const s2 of starts) if (s2.at <= at) line = s2.line;

      const above = physical[line - 2] ?? '';
      const own = physical[line - 1] ?? '';
      const entry = {
        line,
        text: own.trim(),
        // SWALLOWED_PUSH is a subset of HANDLED_PUSH (see the note on
        // HANDLED_PUSH), so it only classifies. Re-tested against this push's
        // own slice, not the whole group, or a `|| true` anywhere in the group
        // would relabel every push in it.
        kind: SWALLOWED_PUSH.test(m[0]) ? 'no-op' : 'handled',
      };
      // The marker applies to the line above this push or to its own line.
      // Not to `joined`: a marker is a COMMENT, a comment ends the logical
      // command, so a group can never carry both a marker and a later live
      // push — but scanning `joined` would still be the wrong shape, and
      // per-push attribution above is what actually removes the hazard.
      if (above.includes(MARKER) || own.includes(MARKER)) marked.push(entry);
      else hits.push(entry);
      if (scanAll.lastIndex === at) scanAll.lastIndex += 1;
    }
  }
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
    for (const h of hits) offenders.push(`${rel}:${h.line}  [${h.kind}]  ${h.text}`);
    for (const m of marked) markedSites.push(`${rel}:${m.line}  [${m.kind}]  ${m.text}`);
  }

  if (offenders.length > 0) {
    console.error('\nA `git push` whose failure is discarded:\n');
    for (const o of offenders) console.error(`  ${o}`);
    console.error(`
\`|| true\` on \`git tag\` is fine — a re-run hits an existing tag and idempotency
is the point. On the PUSH it means a network, auth or ref-lock failure becomes a
silent no-op and the job continues as though the ref reached the remote.

\`[no-op]\` is \`|| true\` or \`|| :\`, someone meaning to ignore the result.
\`[handled]\` is \`|| <anything else>\`, usually someone meaning to LOG the failure
and not realising that under \`set -e\` the \`||\` also silences it — the push fails,
the handler returns 0, and the job carries on (#3212).

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
