#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Run PR-Agent once over a pull request's diff, for one lane of
# .github/workflows/pr-agent-review.yml. The model, endpoint and token caps
# arrive in the environment; this script is the same for both lanes.
#
#   pr-agent-run.sh <base-sha> <head-sha> <out-dir> [candidate-repo]
#
# Writes <out-dir>/review.json, review.md and pr-agent.log. Whether a review
# happened is decided by scripts/review/pr-agent-publish.mjs, not by an exit
# code here. This executable and its imported policy must come from the base
# checkout. The optional candidate repository is read only through `git diff`;
# no code or configuration from it is executed.
set -euo pipefail

base="$1"
head="$2"
out="$3"
candidate="${4:-.}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
trusted_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
trusted_head="$(git -C "$trusted_root" rev-parse HEAD)"
if [ "$trusted_head" != "$base" ]; then
  echo "trusted checkout is $trusted_head, expected base $base" >&2
  exit 2
fi
if [ "$(git -C "$candidate" rev-parse HEAD)" != "$head" ]; then
  echo "candidate checkout does not match head $head" >&2
  exit 2
fi
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
git -C "$candidate" diff --name-only --no-renames -z "$base...$head" \
  | IFC_LITE_TRUSTED_ROOT="$trusted_root" node --input-type=module -e "
      import { readFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const policy = pathToFileURL(process.env.IFC_LITE_TRUSTED_ROOT + '/scripts/review/build-review-input.mjs');
      const { isExcluded } = await import(policy);
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
xargs -0 git -C "$candidate" diff --no-color --no-ext-diff "$base...$head" -- < "$out/paths" > "$out/pr.diff"
echo "pr-agent: diff is $(wc -c < "$out/pr.diff") bytes"

# The instructions come from the BASE commit, so a PR cannot rewrite what
# reviews it. The PR that adds the file has no base copy and runs on defaults.
config_args=()
if [ -f "$trusted_root/.pr_agent.toml" ]; then
  cp "$trusted_root/.pr_agent.toml" "$out/pr_agent.base.toml"
  config_args=(--extra_config_url "$out/pr_agent.base.toml")
else
  echo "::notice title=PR-Agent review::No .pr_agent.toml on the base commit yet; running with PR-Agent defaults."
fi

# Streamed as it runs, so the log is in the job output even when the step
# timeout kills this script. Workflow commands are switched off around it:
# PR-Agent's log can quote the diff, and a PR must not be able to emit
# `::error::` or similar from there.
stop_token="pr-agent-$RANDOM$RANDOM"
echo "::stop-commands::$stop_token"
rc=0
cd "$trusted_root"
LOG_LEVEL=INFO PYTHONUNBUFFERED=1 python -m pr_agent.cli \
  --diff-file "$out/pr.diff" \
  ${config_args[@]+"${config_args[@]}"} \
  --output "$out/review.md" \
  --json-output "$out/review.json" \
  review 2>&1 | tee "$out/pr-agent.log" || rc=$?
echo "::$stop_token::"
echo "pr-agent exit=$rc" | tee -a "$out/pr-agent.log"
