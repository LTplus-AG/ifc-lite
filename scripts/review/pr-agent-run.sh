#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Run PR-Agent once over a pull request's diff, for one lane of
# .github/workflows/pr-agent-review.yml. The model, endpoint and token caps
# arrive in the environment; this script is the same for both lanes.
#
#   pr-agent-run.sh <base-sha> <head-sha> <out-dir>
#
# Writes <out-dir>/review.json, review.md and pr-agent.log. Whether a review
# happened is decided by scripts/review/pr-agent-publish.mjs, not by an exit
# code here. Run from the repository root with <head-sha> checked out, so
# PR-Agent can read the changed files in full.
set -euo pipefail

base="$1"
head="$2"
out="$3"
mkdir -p "$out"
rm -f "$out/review.json" "$out/review.md"

# Three dots: against the merge base, which is the diff GitHub shows. The file
# filter is the Claude lane's `isExcluded` (lockfiles, generated output,
# fixtures, eval cases, binaries), so both lanes skip the same paths. PR-Agent
# does not apply its own [ignore] globs in plain-diff mode (measured on 0.45.0:
# a glob matching 11 of 12 changed files left the prompt at 11,927 tokens
# against 12,038 without it).
# --no-renames lists BOTH sides of a rename, so the second `git diff` still
# sees a moved file as a rename instead of a whole new file.
git diff --name-only --no-renames -z "$base...$head" \
  | node --input-type=module -e "
      import { readFileSync } from 'node:fs';
      import { isExcluded } from './scripts/review/build-review-input.mjs';
      const paths = readFileSync(0, 'utf8').split('\0').filter(Boolean);
      process.stdout.write(paths.filter((p) => !isExcluded(p)).map((p) => p + '\0').join(''));
    " > "$out/paths"

# An EMPTY pathspec list would diff every path, so it is checked first.
if [ ! -s "$out/paths" ]; then
  echo "skip=true" >> "$GITHUB_OUTPUT"
  echo "::notice title=PR-Agent review::Nothing reviewable: every changed path is excluded."
  exit 0
fi
# xargs may split a long list into several `git diff` calls; their outputs
# concatenate into one valid diff with each file once.
xargs -0 git diff --no-color --no-ext-diff "$base...$head" -- < "$out/paths" > "$out/pr.diff"
echo "pr-agent: diff is $(wc -c < "$out/pr.diff") bytes"

# The instructions come from the BASE commit, so a PR cannot rewrite what
# reviews it. The PR that adds the file has no base copy and runs on defaults.
config_args=()
if git show "$base:.pr_agent.toml" > "$out/pr_agent.base.toml" 2>/dev/null; then
  config_args=(--extra_config_url "$out/pr_agent.base.toml")
else
  echo "::notice title=PR-Agent review::No .pr_agent.toml on the base commit yet; running with PR-Agent defaults."
fi

rc=0
LOG_LEVEL=INFO python -m pr_agent.cli \
  --diff-file "$out/pr.diff" \
  ${config_args[@]+"${config_args[@]}"} \
  --output "$out/review.md" \
  --json-output "$out/review.json" \
  review > "$out/pr-agent.log" 2>&1 || rc=$?
echo "pr-agent exit=$rc" >> "$out/pr-agent.log"
sed 's/\x1b\[[0-9;]*m//g' "$out/pr-agent.log" | grep -v '| DEBUG ' | tail -n 60
