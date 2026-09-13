#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Run PR-Agent once over a pull request's diff, for one lane of
# .github/workflows/pr-agent-review.yml. The model, endpoint and token caps
# arrive in the environment (CONFIG__MODEL, OPENROUTER_API_KEY, OPENAI__API_BASE,
# ...); this script is the same for both lanes.
#
#   pr-agent-run.sh <base-sha> <head-sha> <out-dir>
#
# Writes <out-dir>/review.json, review.md and pr-agent.log. It does NOT decide
# whether a review happened: PR-Agent exits 0 when every model call failed, so
# scripts/review/pr-agent-publish.mjs reads these files and makes that call.
# Run from the repository root with <head-sha> checked out, so PR-Agent can read
# the changed files in full.
set -euo pipefail

base="$1"
head="$2"
out="$3"
mkdir -p "$out"
rm -f "$out/review.json" "$out/review.md" "$out/pr-agent.log" "$out/pr.diff" "$out/pr_agent.base.toml"

# Three dots: against the merge base, which is the diff GitHub shows. PR-Agent
# ignores its own [ignore] globs in plain-diff mode, so the exclusions are here.
git diff --no-color --no-ext-diff "$base...$head" -- . \
  ':(exclude)pnpm-lock.yaml' \
  ':(exclude)**/Cargo.lock' \
  ':(exclude)**/CHANGELOG.md' \
  ':(exclude)**/*.snap' \
  ':(exclude)**/fixtures/**' \
  ':(exclude)**/*.ifc' \
  ':(exclude)**/*.ifcx' \
  > "$out/pr.diff"

if [ ! -s "$out/pr.diff" ]; then
  echo "skip=true" >> "$GITHUB_OUTPUT"
  echo "::notice title=PR-Agent review::Nothing reviewable: every changed path is excluded (lockfiles, snapshots, fixtures, changelogs)."
  exit 0
fi
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
