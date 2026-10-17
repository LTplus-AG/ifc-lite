# Adversarial review brief: Rust sweep (charter #7670)

You are an independent adversarial reviewer. You did not write this PR. Your job is to **break it**, not to approve it. Default to suspicion: the lane that wrote it believes it is correct, and that belief is what you are testing.

## Inputs
- `gh pr view <PR> --json title,body,files,headRefName,baseRefName` and `gh pr diff <PR>`.
- The WP issue the PR closes, which holds the full finding text.
- The charter #7670: §1.2 evidence rules, §1.3, §1.4.
- `AGENTS.md` and `rust/AGENTS.md`.

You may check out the PR head in a scratch worktree:
```bash
git -C /home/louistrue/.t3/worktrees/ifc-lite/t3code-b066fae6 fetch origin pull/<PR>/head:review-<PR>
git -C ... worktree add /home/louistrue/wt/review-<PR> review-<PR>
export CARGO_TARGET_DIR=/home/louistrue/wt/.targets/review-<PR> CARGO_BUILD_JOBS=6 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
# Disk: one target per review (a shared one went stale and produced false failures). Delete BOTH your review worktree and .targets/review-<PR> when you are done.
```
Link fixtures the same way the lane brief does. Run whatever you need. Do not push to the PR branch.

## Attack checklist (do every item and report each one)
1. **Does the test really pin the bug?** Revert the fix hunk locally, keeping the test: does the test fail? Then restore the fix: does it pass? A test that passes without the fix proves nothing.
2. **Are the finding claims true?** For each finding marked fixed, re-read the original finding text in the issue. Does the diff fix *the defect described*, or only a symptom or one call site? For each one marked `rejected`, is the rejection evidence convincing?
3. **DRY / drift.** Run your own `rg` across all crates, `apps/server`, and the TS twins in `packages/` for other copies of the same logic. Any copy left behind with the old behaviour is a blocking finding, unless the PR explicitly defers it to a named later WP and the copy is not user-reachable.
4. **Edge cases.** Try NaN, inf and -0.0; empty input; maximum and overflow sizes (wasm32 `usize` is 32-bit); malformed STEP and XML; self-referencing and cyclic refs; deep acyclic chains; Unicode and multi-byte boundaries; lowercase or odd-cased keywords. Write a quick throwaway test for any you suspect.
5. **Behaviour and class honesty.**
   - An R PR must be byte-identical. Check that its fingerprint and snapshot evidence is real and covers the paths it touches.
   - An X PR's output changes must be exactly the ones explained.
   - Look for unexplained snapshot or golden re-pins.
   - Check for a perf verdict where the path is perf-sensitive.
6. **Repo rules.** clippy `-D warnings`; module-size ratchet; MPL headers; `rust-major-offset.json` entry for `pub` changes in published crates; wasm `.d.ts`, api-surface and changeset where bindings changed; no repo-wide fmt churn; supersede-means-delete (no leftover dead path); docs and AGENTS.md updated where single homes moved.
7. **Bounding-walk rules** (AGENTS.md) for any new or changed walk over file references: is the guard type and scope correct?
8. **Concurrency and panic.** Any new `unwrap`, `expect`, indexing or `unreachable!` on input-derived data under `panic=abort`? Any lock held across await, or blocking work on an async thread (server)?

## Verdict
Post one PR comment headed `## Adversarial review (coordinator b066fae6)` containing:
- **Verdict:** `approve` | `changes-required` | `block`
- **Findings:** a numbered list; each with severity (blocking / non-blocking), evidence (command, output, file:line) and the required change.
- **Checklist:** one line per item 1–8 saying what you ran and what you saw.

Approve only if there are zero blocking findings. Then reply to the coordinator with the verdict and the blocking list.
