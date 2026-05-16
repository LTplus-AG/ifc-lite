# 06 — Self-Improvement Loops

"Self-improving software" is the original framing; this document
spells out exactly what that means and what it does not. There are
three loops. Each one is bounded, observable, and user-controlled.
None of them transmit data off-device by default.

## 1. Three loops

| Loop | What it improves | Cadence |
|---|---|---|
| **Repair loop** | Existing extensions when the SDK changes or fixtures drift. | On SDK upgrade, on test failure. |
| **Pattern-mining loop** | Suggests new extensions from repeated user actions. | Continuous, local-only. |
| **Memory loop** | Updates the personal prompt overlay so the AI gets better at this user's workflow. | After each chat / authoring session. |

The repair loop has already been specified in
[`04-ai-authoring.md`](./04-ai-authoring.md). This document covers
pattern mining and memory; the repair loop appears here only for
completeness.

## 2. The action log

Both pattern mining and memory consume the **action log**, a local,
append-only record of high-level intents (not raw events).

### 2.1 What gets logged

Every user-initiated action that maps to a stable intent. Examples:

- `model.load { schema: 'IFC4' }`
- `query.run { type: 'IfcWall', filter: 'IsExternal=true' }`
- `lens.apply { id: 'fire-rating' }`
- `export.run { format: 'csv', filter: 'walls' }`
- `script.execute { templateId: 'count-walls' }`
- `chat.message { intent: 'authoring' | 'query' | 'one-shot' }`
- `extension.install { id: '...' }`

What does *not* get logged:

- Raw input keystrokes.
- Mouse movements, drags, scrolls.
- Property values, model content, BCF comment text.
- File names of loaded models (only sizes, schema versions, entity
  counts).
- BYOK keys (by construction; the log never sees them).

The log is privacy-by-construction. We log intents and parameters that
the user could read aloud, not the user's content.

### 2.2 Storage and limits

- IndexedDB store `action-log`, append-only.
- Rolling window: default 30 days or 50,000 entries, whichever is
  smaller.
- Per-entry: timestamp, intent id, parameter summary, success bit,
  duration ms.
- Total footprint capped at a configurable byte budget (default 8 MB).
- Exportable as JSON; deletable as a single action.

### 2.3 What turns logging off

The log is **on by default** in v1 because it is the substrate for
both pattern mining and memory. The settings page surfaces a single
toggle to disable; turning it off disables pattern-mining and memory
loops along with it.

This is an intentional simplification: we do not split logging into
sub-toggles. Either the local log exists or it does not.

## 3. Pattern mining loop

The premise: if a user does the same three-step thing on Tuesday and
then again on Thursday, the app should notice and propose a one-click
version.

### 3.1 What we mine

Two kinds of patterns:

- **Sequence patterns** — N actions performed in the same order, N times
  within a window. Example: `model.load → lens.apply{fire-rating} →
  export.run{csv}` happens 5 times in 2 weeks.
- **Conditional patterns** — action B follows action A in a high
  fraction of cases when A occurs. Example: after every IDS validate,
  the user runs the same query.

We do *not* mine:

- Cross-user patterns. Pattern mining is per-user, on-device.
- Pattern intersections across multiple sessions worth of free-form
  chat. Chat content is not the substrate.

### 3.2 The miner

A small algorithm runs on idle (or on demand from settings):

1. Project the action log onto the action vocabulary.
2. Apply a sequence-mining pass (PrefixSpan-like, capped at length 5).
3. Score candidates by frequency × recency × diversity-of-context.
4. Filter candidates that overlap an already-installed extension or
   an already-saved tool.
5. Rank top K.
6. For each, derive a *plan stub*: the action sequence, the user-supplied
   parameter values that varied, the candidate slot type.

### 3.3 The proposal UX

A subtle notification surface: a small "ideas" indicator in the status
bar. Clicking opens a list:

```
✦ Make this a one-click tool?
  Load model → apply "Fire Rating" lens → export CSV
  Observed 7 times in the last 12 days.

  [ Author it ]  [ Not now ]  [ Don't suggest this again ]
```

Clicking *Author it* routes the plan stub into the standard AI
authoring pipeline (Mode B). The user sees the same plan card, the
same review screen, the same capability summary.

The miner is conservative by default. A pattern needs to recur at
least 4 times across at least 2 distinct sessions before it surfaces.
The threshold is exposed in settings.

### 3.4 Why this is not annoying

- The "ideas" indicator is visually quiet; never modal.
- *Not now* and *don't suggest this again* are honoured immediately.
- The miner runs on idle, not on every action.
- A maximum of one new suggestion per session.

These are deliberate constraints. The product fails if it nags.

### 3.5 What this does not turn into

We will not build:

- Predictive UI ("we think you want to click this next").
- Auto-execution of suggested extensions without the review screen.
- Cross-user aggregation, federated learning, or model fine-tuning.
- Suggestions phrased as "your colleagues do this." We do not have
  colleague data and will not synthesise it.

## 4. Memory loop

The premise: the AI is more useful if it knows the user's defaults.
The architect always works in metric, the structural engineer always
validates IFC4 IDS X before export, the QS always groups by storey.
These are facts the AI rediscovers every session unless we let it
remember.

### 4.1 The personal prompt overlay

A user-editable Markdown document, capped at 4000 tokens, that is
appended to the system prompt for every chat turn.

The overlay is exposed in settings under "AI personalization." It
starts empty. The user can edit it directly at any time.

### 4.2 How it grows

After each authoring session and after long chat sessions, the host
runs a small **memory-extraction** call against the chat transcript:

- Input: the chat transcript plus the current overlay.
- Output: a proposed delta — additions / amendments to the overlay.
- The user sees the proposed delta with a diff view.
- The user can accept, edit, or reject.

The model is instructed to extract only durable preferences:

- "User defaults to IFC4."
- "User works mostly with residential building models."
- "User prefers exports grouped by storey."

Not:

- Specific model content.
- File paths.
- BYOK / credentials (the model never sees these).
- One-off questions.

### 4.3 What goes in the overlay (good vs. bad)

Good:

> The user is a structural engineer. They work in metric (kN, mm). They
> prefer to validate against IDS "structural-load-bearing" before
> running any quantity export. They group CSV exports by storey. They
> often round numerical values to integers in user-facing output.

Bad:

> The user is working on the Acme Tower project for client X. They
> uploaded a 230 MB model called `tower-rev42.ifc`. They asked about
> column 42 on storey 5.

The system prompt for memory extraction explicitly distinguishes these
categories and the host's output filter rejects deltas that mention
specific file names, GlobalIds, or human PII.

### 4.4 Overlay lifecycle

- Edit anytime in settings.
- Export as part of the flavor.
- Reset to empty at any time.
- The host audit log records every overlay change with timestamp and
  source (manual edit vs. accepted suggestion).

### 4.5 What it does for the AI

Concretely, the personal overlay improves:

- Authoring quality — the AI proposes plans that already match the
  user's defaults.
- One-shot chat — fewer follow-up questions ("metric or imperial?",
  "by storey or by type?").
- Code style consistency — the AI mirrors the user's idioms.

We do not retrain the model. The overlay is a prompt addition; the
underlying model is the same model everyone uses.

## 5. SDK-update repair, summarised

(Full detail in 04-ai-authoring.md.) When the SDK version moves:

1. Every installed extension runs its tests against fixtures.
2. Failures are categorised: capability removed, API shape changed,
   bridge type narrowed, fixture changed, etc.
3. Each category has a tailored repair prompt that includes the
   relevant changelog excerpt.
4. The user sees a single "Some extensions need a tweak" notification;
   batch repair is one click.
5. Each repaired extension goes through its own review screen with a
   capability diff.

This is the loop that delivers on "self-healing" — extensions stay
working as the platform evolves, with the AI doing most of the work
and the user retaining authority over each change.

## 6. Evaluation harness for the loops

Each loop has its own evals to catch regressions in the loop's
behaviour, not in user extensions:

### 6.1 Repair loop evals

- A set of canonical "deliberately broken" extensions (e.g. extension
  that calls a removed SDK method). The repair loop must succeed on
  each within the iteration budget at a target pass rate ≥ 85%.
- Adversarial set: extensions that should *not* be silently auto-repaired
  (e.g. ones whose semantics changed). The repair loop must surface
  these as needing human review.

### 6.2 Pattern miner evals

- Synthetic action logs with known plant patterns; the miner should
  surface them.
- Synthetic noise-only logs; the miner should propose nothing.
- Logs that mix the two; precision/recall over labelled patterns.

### 6.3 Memory loop evals

- Transcripts with planted durable preferences; the extractor should
  capture them.
- Transcripts with sensitive content (file names, GlobalIds, PII); the
  extractor should *not* capture them.
- Drift test: the same overlay after many sessions does not exceed the
  token cap and remains coherent.

These evals run in CI for the host. Regressions block release.

## 7. Privacy summary

A one-paragraph statement we surface to the user in settings:

> IFClite logs a record of high-level actions (loaded a model, ran a
> query, applied a lens) to your local device. The log stays on your
> device; it is the basis for suggesting new extensions and improving
> AI personalization. No content from your models, your chats, or your
> files is logged. You can turn logging off, export the log, or delete
> it at any time. The personal prompt overlay is editable text you
> control; the AI never reads your saved chats unless you keep them in
> the chat panel.

If we ever change this — if we propose any cross-device sync, any
cloud upload, any telemetry — it requires a new settings section, a
clear opt-in flow, and an updated version of this document.

## 8. Self-improvement is bounded

A guard against over-aspiration: this system does not improve itself.
It improves the user's *flavor*. The host application — the React
code, the SDK, the renderer — improves only through normal upstream
development. We do not let the AI rewrite host code at runtime, no
matter how compelling the framing.

The reason: host code controls the trust boundary. Self-modifying
hosts have no boundary. Every "self-improving" system we admire (Emacs,
Smalltalk, TiddlyWiki) predates a serious adversarial threat model and
made trade-offs we cannot.

If we ever want host self-modification, it ships as a separate
product-line decision with its own RFC and its own threat model.
