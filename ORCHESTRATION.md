# Agent Orchestration Playbook

Companion to [AGENTS.md](./AGENTS.md). AGENTS.md holds the codebase contract every agent (human-driven or delegated) must obey; this file holds the Fable/Codex/subagent orchestration mechanics for running work in this repo. If the two ever conflict on a codebase rule, AGENTS.md wins.

## Fable 5 as orchestrator
- Default Fable 5 to **high** effort in this repo. Escalate above high only for tightly scoped final judgment calls (architecture, risky API/semver decisions, geometry-kernel reasoning, security-sensitive review) after cheaper investigation has narrowed the problem.
- Use Fable 5 as orchestrator, spec writer, and final reviewer, not as the default engine for token-heavy repo sweeps. Delegate mechanical implementation, broad code search, log triage, fixture inspection, and first-pass test repair to cheaper or specialized agents, then bring back a concise summary: exact files changed, commands run, result, and open risks.
- Set subagent models explicitly. Use `model: fable` only for design/review/taste-sensitive work; use `model: sonnet` or `model: opus` for implementation depending on risk. Avoid Haiku for code changes or review in this repo unless the task is truly trivial and read-only.

## Local Codex handoff
- Codex is a preferred fallback for implementation, investigation, and adversarial review when Fable/Claude would burn context on filesystem work. Verify availability with `command -v codex && codex --version`.
- Self-contained implementation/investigation, run from the repo root with an explicit sandbox: `codex exec --sandbox workspace-write "<task prompt>"`. Read-only research/review omits the sandbox flag: `codex exec "<task prompt>"`. Use `--json` or `-o <file>` when the orchestrator needs a compact machine-readable summary instead of a long transcript.
- Good direct handoff shape: `codex exec --sandbox workspace-write "In this ifc-lite repo, follow AGENTS.md. Goal: <goal>. Relevant files: <files>. Apply this repo's House rules, IFC EXPRESS naming, and the one-load-path rule. Make the smallest safe patch. Run <verification command>. Return: files changed, commands run, result, risks."`
- If the OpenAI Codex Claude plugin is installed, prefer the slash commands for in-Claude orchestration: `/codex:rescue --background <task>` for delegated fixes/investigation, `/codex:review --background` for read-only review, `/codex:adversarial-review --background <focus>` for challenge review, then `/codex:status` and `/codex:result` to pull back the summary. Don't enable the plugin review gate unless actively monitored; it can loop and drain usage.
- Codex review paths are read-only critique. Treat Codex implementation output as a patch proposal until `git diff` and local verification pass.
- Use `codex exec resume --last "<follow-up>"` only when continuing the immediately previous Codex thread for this repo; otherwise start fresh so stale context does not bleed across unrelated tasks.

## Handoff hygiene
- Handoff prompts must be self-contained: the user goal, the AGENTS.md constraints that apply, files/commands already inspected, acceptance criteria, and the exact verification command expected. Ask the delegate to avoid public API churn, respect IFC EXPRESS names, and report uncertainty instead of inventing aliases or fallbacks.
- Keep the orchestrator's context clean. Don't paste long logs, generated files, or fixture dumps back; summarize the failure signature and link or path the artifact. If a delegate fails, return the smallest repro, command, stderr excerpt, and suspected owner area.
- Final pass before shipping: review `git diff`, confirm generated artifacts / changesets / API-surface rules, run the narrowest relevant tests, and explicitly list anything not verified.
