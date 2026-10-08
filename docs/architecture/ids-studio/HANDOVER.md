# IDS Studio campaign — handover guide

Read this first if you are picking the campaign up from someone else (human or agent). It tells you where everything is, how work is organised, and how to continue without asking anyone.

## 1. What the campaign is
A clean-room rewrite of IDS authoring in ifc-lite: an IDS Studio inside the viewer that is grounded in the IFC schema, bSDD and loaded models, plus an AI agent, CLI, MCP and SDK surfaces. The *why* and *what* are in [`README.md`](README.md); the *how* is in [`03-architecture/`](03-architecture/) and the ADRs in [`04-decisions/`](04-decisions/).

## 2. Where the state lives
| What | Where | Rule |
|---|---|---|
| Live status of every pitch and backlog item | [`STATUS.md`](STATUS.md) | Update in the campaign PR whenever a pitch PR changes state |
| Per-pitch engineering log (decisions, gotchas, what's next) | [`worklog/P-xx.md`](worklog/) — each lives on its pitch branch until merged | Append an entry at the end of every working session |
| Backlog definitions (scope, acceptance, evidence) | [`05-delivery/03-backlog.md`](05-delivery/03-backlog.md) | IDs are stable; never renumber |
| Owner decisions | [`README.md` → Decisions](README.md#decisions-resolved-by-the-owner-2026-10-08) | Add D9, D10… with date |
| Private material (tool landscape, launch FAQ, go-to-market) | Owner's private plan package (not in this repo) | ADR-014 — never commit vendor or client names |

## 3. Branches and PRs
All PRs are **drafts** until their pitch's "Done means" (in its pitch file) is met and evidence is attached.

| Pitch | Branch | Base | Depends on |
|---|---|---|---|
| Campaign docs / tracker | `claude/stoic-cannon-6hceqo` | `main` | – |
| P-01 Engine completeness | `claude/ids-studio-p01-engine` | `main` | – |
| P-02 Authoring core | `claude/ids-studio-p02-authoring-core` | `main` | – |
| P-03 Studio UI v1 | `claude/ids-studio-p03-studio-ui` | P-04 branch | P-02, P-04 |
| P-04 Lint | `claude/ids-studio-p04-lint` | P-02 branch | P-02 |
| P-05 Model loop | `claude/ids-studio-p05-model-loop` | P-03 branch | P-03 |
| P-06 bSDD | `claude/ids-studio-p06-bsdd` | P-04 branch | P-02 (P-03 for UI parts) |
| P-07 Agent | `claude/ids-studio-p07-agent` | P-04 branch | P-02, P-04 |
| P-08 Eval | `claude/ids-studio-p08-eval` | `main` | – (runner needs P-07) |
| P-09 Ingestion & documents | `claude/ids-studio-p09-ingestion` | P-07 branch | P-07 |
| P-10 Trust & teamwork | `claude/ids-studio-p10-trust` | P-04 branch | P-02 |
| P-11 Headless | `claude/ids-studio-p11-headless` | P-04 branch | P-02, P-04 (+ later pitches incrementally) |
| P-12 Standards leadership | `claude/ids-studio-p12-standards` | P-01 branch | P-01 |

**Stacking rule.**
- When a base PR merges, retarget the dependent PR to `main`.
- Merge `main` into the branch with a merge commit. Never rebase or force-push a branch someone else may have checked out.
- PR links are recorded in `STATUS.md`.

## 4. How to work an item
1. Pick the next unblocked backlog item for the pitch (`STATUS.md`). Mark it `in progress` with your name or session.
2. Read the item's row in the backlog, the pitch file and the relevant architecture section.
3. Implement it on the pitch branch, following [AGENTS.md](https://github.com/LTplus-AG/ifc-lite/blob/main/AGENTS.md):
   - MPL header on new files;
   - no `as any`, `@ts-ignore` or silent `catch {}`;
   - modules ≤ ~400 lines;
   - tests with an oracle where one exists (see [`05-delivery/02-test-and-eval-strategy.md`](05-delivery/02-test-and-eval-strategy.md));
   - docs in the same PR;
   - a changeset plus `pnpm api-surface:update` for published packages.
4. Run the checks for the packages you touched:
   ```bash
   pnpm turbo build --filter=<pkg>...      # build deps
   pnpm --filter <pkg> test                # vitest
   pnpm --filter <pkg> typecheck
   node scripts/check-module-size.mjs
   pnpm lint                               # oxlint
   ```
5. Commit with the backlog ID in the subject, e.g. `feat(ids): emit length restrictions (IDS-001)`.
6. Append to `worklog/P-xx.md`: what changed, what you learned, what's next and any open question.
7. Tick the item in the PR body checklist and update `STATUS.md` on the campaign branch.

## 5. Conventions specific to this campaign
- **No GitHub issues.** The owner exempted the campaign from the `ready`-issue queue (D8). PR bodies list backlog IDs. If the issue-queue CI gate fails, the maintainer applies the escape label. Don't try to work around the gate in code.
- **Op vocabulary is the contract.** Any change to ops in `@ifc-lite/ids-authoring` must update `03-architecture/02-document-model-and-ops.md` in the same PR.
- **Gate before features.** Nothing writes an `IDSDocument` except through ops (ADR-002/003). Reviewers should reject UI or AI code that mutates IDS directly.
- **Evidence.** UI PRs need screenshots or recordings on real models. Engine PRs need corpus or oracle output. Paste the evidence into the PR body.
- **Unverified assumptions** (RAID A-03, A-04 …) must be verified before a lint rule relying on them ships above `info` severity. Record the verification in the worklog.

## 6. Environment notes (from the first session)
- Node 22, pnpm 10.8. `pnpm install --frozen-lockfile` takes about 20 s with a warm store.
- Package tests use vitest (`pnpm --filter @ifc-lite/ids test`). The IDS conformance corpus lives in `packages/ids/src/__corpus__/buildingsmart-ids` (CC BY-ND: never modify those files).
- `pnpm turbo build --filter=<pkg>...` builds a package and its workspace dependencies. Tests import workspace packages from their `dist`.
- **Revert oracle (`Changed tests observe production`).** CI reverts the PR's production files and requires the PR's tests to go red. When the production files are *new* (a new package or module), the revert deletes them, the tests can't load, and the verdict is INCONCLUSIVE (`REVERT-BROKE-BUILD`). That blocks CI. The fix is evidence plus a label, never a code workaround:
  1. Write surgical mutation patches (mutant→fixed orientation) and keep them outside the worktree, because the oracle refuses a dirty tree.
  2. Run `node scripts/check-test-revert-oracle.mjs --base <PR base> --only <module> --test <its test> --mutation <patch> --ci --json` until each is `OBSERVED`.
  3. Commit patches + README + `summary.json` under `docs/architecture/evidence/<pitch>/mutations/` (template: P-08's).
  4. Ask the maintainer for the `revert-oracle-exempt` label in a PR comment.
- **Stacked PRs get no CI lanes.** `test.yml` only triggers for PRs based on `main`. A PR stacked on another pitch branch therefore runs no test lanes, and `PR review signal` fails with "NOT ONE lane from test.yml appeared". An empty commit doesn't help. Until the base merges and the PR is retargeted to `main`:
  1. Run the package checks locally.
  2. Run the revert oracle with `--base <pitch base branch>`.
  3. Paste the results into the PR body.
  CodeRabbit also skips `low-risk`-labelled PRs, so its result carries no review verdict either.
- **Superseded runs.** `Build + WASM + Rust + Node` reports *failure* when its jobs were cancelled by a newer push. Check the log before acting; a cancelled-only run needs nothing.

## 7. Contacts and authority
- Owner and maintainer: Louis True. Decisions are recorded in README → Decisions.
- Anything not covered here: follow the architecture docs. If they are silent, decide, record the decision in the pitch worklog, and flag it in the PR body under "Decisions taken".
