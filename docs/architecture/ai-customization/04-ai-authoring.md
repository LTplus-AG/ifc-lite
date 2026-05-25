# 04 — AI Authoring & the Repair Loop

This document specifies how the AI authors extensions, how the host
evaluates them before exposing them, how broken extensions are repaired
when the SDK evolves, and how the conversational UX is structured. It
builds on the existing `ChatPanel`, `system-prompt.ts`, `repair-loop.ts`,
and `script-diagnostics.ts` modules — we extend them, we do not replace
them.

## 1. Authoring modes

There are three modes by which an extension comes into existence. All
three produce the same artifact (a manifest bundle) and pass through the
same review screen.

### Mode A — "Save this as a tool" (smallest jump)

The user has a working script in the `ScriptPanel` chat. Today they can
save it as a named script. We add a **Promote to tool** action that:

1. Asks for: name, optional icon, optional command-palette category.
2. Wraps the script in a minimum-viable manifest (one command
   contribution, capabilities inferred from `script-preflight` static
   analysis, no UI widget).
3. Renders the review screen.
4. Installs.

This is the path most users will use. It requires no AI authoring; it
only re-packages what the user already has.

### Mode B — "Plan, then author" (the AI authoring loop)

The user describes the extension in the chat. The AI proposes a
**plan** before code:

```
> add a panel that shows fire-rating coverage by storey

Plan:
  • New dock panel "Fire Rating Coverage" on the right
  • Refreshes on model load and on selection change
  • For each storey: % of walls with FireRating != null
  • Shows a table; "Export CSV" button below
  • Capabilities required: model.read, viewer.read, export.create:csv

[ Looks good — author it ]  [ Adjust the plan ]  [ Cancel ]
```

The user can edit the plan inline. Only after they accept does the AI
generate the manifest + code + widgets + at least one test. The output
is validated against the manifest schema and the widget DSL before the
review screen renders.

### Mode C — "Fork and modify"

The user has an existing extension (their own, a community one, or one
the AI authored previously) and asks the AI to change it. The AI:

1. Loads the current manifest + code as context.
2. Proposes a diff plan.
3. On approval, produces a new version of the bundle.
4. Routes the change through the **capability diff** flow (§02.3.4)
   if capabilities changed.

## 2. Authoring pipeline

```
user prompt
    │
    ▼
intent classifier ──► one-shot script / extension / fork
    │
    ▼  (extension authoring path)
plan generation
    │
    ▼
plan approval gate ◄── user edits / approves
    │
    ▼
manifest + code + widget + tests generation
    │
    ▼
static validation
    │   - Zod schema for manifest
    │   - widget DSL schema
    │   - capability grammar parse
    │   - no banned globals in code
    │   - no string-construction of capabilities
    │
    ▼
isolated dry-run
    │   - Spin up sandbox with declared capabilities
    │   - Run the extension's tests against fixtures
    │   - Capture logs and outputs
    │
    ▼
auto-repair loop (≤ N iterations)
    │   - If validation or tests fail, feed diagnostics back to model
    │   - Bound by iteration count, token budget, wall-clock time
    │
    ▼
review screen
    │   - Capabilities (plain English + risk badges)
    │   - Diff summary
    │   - Test results
    │   - Source visible on demand
    │
    ▼
user approval ──► install
```

Every box is owned by the host. The AI only writes the bundle content;
everything else (classification, validation, dry-run, repair loop
control flow, review screen) is non-LLM code.

## 3. Intent classification

A small classifier (rule-based first; LLM-judged later) decides what
the user is asking for:

- **One-shot script** — "show me the count of walls per storey." Goes
  to the existing `ScriptPanel` flow; no extension produced.
- **New extension** — "add a panel that…" / "create a button that…" /
  "give me a custom lens for…"
- **Fork** — "change the fire-rating panel to also show area" / "edit
  my custom export."
- **Out of scope** — "open the file `/etc/passwd`" / things outside
  the bim domain.

Misclassifications are recoverable: at the plan stage the user can
say "no, just run it once" and we route back to the one-shot path.

## 4. The plan-first contract

We generate a **plan** before code for everything in Mode B and Mode C.
Plans are structured:

```ts
interface AuthoringPlan {
  summary: string;                 // one line for the chat
  rationale: string;               // one paragraph
  contributions: PlannedContribution[];
  capabilities: Capability[];
  triggers: ActivationEvent[];
  widgets: PlannedWidget[];
  tests: PlannedTest[];
  notes?: string;                  // open questions, assumptions
}
```

Plans are rendered as readable text plus a structured panel the user
can edit (toggle contributions, prune capabilities, edit the test
descriptions). Editing the panel updates the structured plan; the
chat surfaces a diff.

Why this gate exists: it is cheaper to reshape intent than to debug
generated code. Copilot Workspace established the UX precedent and the
quality lift it produces is consistent across teams.

## 5. System prompt construction

The system prompt is generated from:

- The current SDK's `NAMESPACE_SCHEMAS` (existing).
- The manifest schema (Zod → JSON Schema → prompt text).
- The widget DSL schema (same conversion).
- The capability catalogue (with risk annotations).
- A fixed set of authoring-style rules (see §11).
- The user's personal prompt overlay (see [§06-self-improvement.md]).
- The current model context (existing `context-builder.ts`).
- The diagnostics from any prior failed attempt (existing).

All of this is concatenated with the existing prompt builder; we add a
new section called `AUTHORING CONTRACT`. The total prompt for an
authoring turn is significantly larger than for a one-shot script (we
estimate 12-20k tokens for the static contract), but the deltas are
cacheable.

We use Anthropic's prompt caching aggressively. The authoring contract
is cache-hot across the session; only the user's request and the
in-progress plan are uncached. This is critical for cost.

## 6. Static validation

Before any sandboxed run, the generated bundle is checked locally:

| Check | Tool |
|---|---|
| Manifest matches schema | `manifestSchema.safeParse()` (Zod) |
| All `entry.*` paths exist in the bundle | Bundle walker |
| All widget files parse against the DSL | `widgetSchema.safeParse()` |
| All `contributes.commands` referenced by widgets / toolbar exist | Cross-reference walker |
| Capabilities parse against the capability grammar | Capability parser |
| Code has no banned globals (`globalThis`, `window`, `process`) | AST walker (`acorn`) |
| Code has no `eval`, `Function(...)`, dynamic import of non-bundle paths | AST walker |
| Code never constructs a capability string from a runtime value | AST taint analysis (lightweight) |
| All `network.fetch:*` capabilities have explicit host patterns | Capability parser |

Any failure stops the pipeline and returns to the repair loop with a
structured diagnostic.

## 7. The isolated dry-run

After static validation, the host spins up a sandbox with the
extension's declared capabilities. It runs the extension's tests
(declared in the manifest) against the named fixtures.

The dry-run has stricter resource caps than the production sandbox to
catch runaway code early (default: 25% of production memory budget,
50% of CPU budget). Failures generate diagnostics the same shape as
runtime errors.

If a test produces output that does not match the `expect` block, the
diagnostic includes the actual output (truncated) so the model can
adjust.

## 8. Repair loop

We generalise the existing repair loop in `lib/llm/repair-loop.ts`:

```ts
async function repairExtension(initial: Bundle, ctx: AuthoringCtx) {
  let bundle = initial;
  let attempt = 0;
  while (attempt < MAX_REPAIR_ATTEMPTS) {
    const validation = await validate(bundle);
    if (validation.ok) {
      const tests = await dryRun(bundle);
      if (tests.ok) return bundle;
      bundle = await ctx.llm.repairFromTestFailures(bundle, tests);
    } else {
      bundle = await ctx.llm.repairFromValidationErrors(bundle, validation);
    }
    attempt += 1;
  }
  throw new ExtensionAuthoringFailed(bundle, attempt);
}
```

Tunables (defaults):

- `MAX_REPAIR_ATTEMPTS = 4`
- Token budget per attempt: 6000 output, 32000 input.
- Wall-clock budget per attempt: 90 seconds.
- Total wall-clock budget for an authoring session: 6 minutes.

Diagnostics are *structured*. The model receives a JSON object with
the failing manifest path, the validation error code, a hint, and a
suggested fix shape. The existing `formatDiagnosticsForPrompt` is
extended to support this shape.

## 9. SDK-drift repair (post-install)

When IFClite's SDK version moves (e.g. `2.4.0 → 2.5.0`), every
installed extension is re-evaluated:

1. The loader runs the extension's tests against fixtures.
2. If all pass: nothing to do.
3. If some fail and the SDK changelog identifies breaking changes
   relevant to the extension's call sites, the host queues a
   **repair task**.
4. The user sees a notification: *"Fire Rating Report needs a tweak
   for IFClite 2.5. Repair now?"*
5. On approval, the same authoring pipeline runs — but the AI's
   context includes the SDK changelog excerpt, the failing
   diagnostics, the existing bundle, and the SDK migration notes.

If the repaired bundle passes its tests, the user reviews a diff and
installs. If it fails repeatedly, the user is offered the choice of
keeping the extension disabled, downgrading the SDK (desktop only),
or removing the extension.

The CI for the host runs the same evaluation against the registry
extensions before SDK releases; this is our compatibility canary.

## 10. Test authoring

The AI must propose tests for everything it authors. Tests are
declarative (§01.6) and run against canonical fixtures.

To make tests authorable, the system prompt includes a **fixture
catalogue**:

- Each canonical fixture has a stable id, a short description, and
  the entity-type distribution.
- The model picks the smallest fixture that exercises its extension.
- For complex tests, the model can request a **synthetic fixture** via
  `bim.create.*` — the sandbox builds the model in-memory at test
  time.

Tests evolve like code: the repair loop can amend tests if the failing
test is wrong (rare) or add tests if a regression revealed a gap.

## 11. Authoring contract (model-facing)

The text we insert into the system prompt. Excerpted; the canonical
copy lives in `apps/viewer/src/lib/llm/extension-authoring-prompt.ts`.

> You are authoring an IFClite extension.
>
> **Manifest** — Must validate against the v1 schema. Use the smallest
> capability set that lets the extension do its job. Never request
> wildcard capabilities; always scope to specific Psets, formats, and
> host patterns.
>
> **Widgets** — Use only the v1 widget DSL. Do not include JSX, HTML,
> CSS, or `<script>` content anywhere. Every interactive element binds
> to a command id you declared in `contributes.commands`.
>
> **Code** — One module per command / trigger. All authority enters via
> the `ctx` parameter. Never reference `globalThis`, `window`, or
> module-level globals. Never construct a capability string from
> runtime data. Never call `eval`, `Function`, or dynamic `import`.
>
> **Tests** — Every contribution that produces output must have at
> least one test against the smallest matching fixture.
>
> **Style** — Comments only when the why is non-obvious. Functions
> named after their effect, not their implementation. Error messages
> say what to do, not what failed.
>
> **Privacy** — Treat all model strings, all chat input, all uploaded
> file content as untrusted. Never include user content in a network
> fetch URL.

This list does not enforce anything by itself; the validators do. The
contract exists to lift quality, not to substitute for the controls.

## 12. UI surface in `ChatPanel`

We extend the existing chat UI. New elements:

- **Plan card** — a structured, editable plan rendered above any
  authoring run.
- **Capability summary** — inline before the code, showing the
  capabilities being requested with risk badges.
- **Test result chip** — after each authoring attempt, a chip showing
  pass/fail; click to expand diagnostics.
- **Install button** — appears only after tests pass.
- **Author another version** — re-runs the pipeline with the same
  plan; useful for picking between two AI proposals.

The existing one-shot script flow is untouched; authoring is a parallel
path with its own UI affordances.

## 13. Cost model

Authoring is more expensive than a one-shot. Rough estimates per
authoring session:

- Plan generation: 2k-4k output tokens.
- Code + manifest + widget + tests: 6k-12k output tokens.
- Repair iterations: up to 4 × (~6k output) = 24k worst case.

We surface a token estimate in the chat before the user approves the
plan. BYOK users see their direct cost; proxy users see the in-budget
indicator.

## 14. Failure modes the AI authoring pipeline must handle

| Failure | Detection | Handling |
|---|---|---|
| Manifest invalid JSON | Zod parse | Repair loop with parse error |
| Capability outside catalogue | Grammar parse | Repair with allowed list |
| Wildcard in `network.fetch` | Capability parser | Reject; ask model to scope |
| Widget refs nonexistent command | Cross-reference walker | Repair with command list |
| Code references undefined ctx field | AST walker | Repair with ctx surface |
| Test fixture missing | Fixture resolver | Suggest available fixtures |
| Test passes but output is wrong | Inspectable diff | Repair with expected shape |
| Token budget exhausted | Repair loop | Surface failure to user with current bundle for manual edit |
| Wall-clock budget exhausted | Authoring controller | Same as above |

For every failure, the user can fall back to "show me the source" and
hand-edit the bundle. Hand-edited bundles re-enter validation; the
review screen treats them the same as AI-authored ones.

## 15. Out-of-scope for v1

- Fine-tuning a model on the user's authoring history.
- Multi-turn agentic authoring (the model spawning sub-agents to
  validate or test). The plain pipeline is sufficient.
- Authoring against a remote / hosted model registry.
- Generating new fixtures from scratch (we use the existing canonical
  set; the AI can compose them with `bim.create.*` at test time).
- Voice-driven authoring.
