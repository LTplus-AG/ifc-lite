# Privacy

Everything the customisation system stores stays on your device: the action log, audit log, flavor library, and prompt overlay never leave your browser. Your models are processed entirely client-side too — parsing and geometry run in your browser, and model content is never uploaded. This page covers exactly what's stored, where, and how to inspect or clear it, plus an honest account of what the hosted viewer sends over the network.

## TL;DR

- **Action log** — content-free intents (model loaded, lens applied, export run) used by the local pattern miner. Never records model content, chat content, file names, or API keys.
- **Audit log** — append-only ledger of extension lifecycle events.
- **Flavor library** — your extensions, lenses, queries, layout, settings, prompt overlay.
- **Prompt overlay** — durable notes the AI assistant sees in every chat (per flavor).

All four live in your browser's IndexedDB. None of it is sent off-device unless you explicitly export. Separately, the hosted viewer can emit anonymous, scrubbed product analytics — see [What flows over the network](#what-flows-over-the-network).

## Where data is stored

| Store | Backend | Purpose | TTL |
|-------|---------|---------|-----|
| `ifc-lite-extensions` | IndexedDB | Installed `.iflx` bundles + their records | Forever (or until uninstall) |
| `ifc-lite-flavors` | IndexedDB | Flavor library + snapshots | Forever (snapshots cap at 10 per flavor) |
| Action log | IndexedDB (ring buffer) | Pattern miner input | 50,000 events / 8 MiB rolling |
| Audit log | IndexedDB (ring buffer) | Lifecycle events | 10,000 entries / 10 MiB rolling |

The action and audit logs are held in an in-memory ring buffer and mirrored to IndexedDB, so they survive a reload (both are hydrated from IDB on startup). Clearing a log wipes both the in-memory copy and its persisted copy.

## The Privacy panel

Open the Extensions panel (Command Palette → "Extensions") and click the **Privacy** tab. Three sections:

### What we store locally

A plain-English summary of the stores above — the same content as this page in short form.

### Action log

Shows the current size: event count + byte size. Two buttons:

| Button | What it does |
|--------|-------------|
| **Export JSON** | Downloads a JSON snapshot you can audit / archive. Includes every event with timestamp, intent, and content-free parameters. |
| **Clear** | Wipes the action log. Confirms first. Suggestions reset until the miner builds up new patterns. |

### Prompt overlay

Per-flavor durable notes the AI assistant sees in every chat for that flavor. Used for stable preferences ("Always export CSV with semicolon separators", "Default lens for IfcWall: by-fire-rating").

| Field | Notes |
|-------|-------|
| Textarea | Markdown content. Capped at ~4000 tokens (~16 KB). Excess is truncated client-side on save with a `[truncated]` marker. |
| **Extract from chat** | Scans the current session transcript for stable preferences and proposes them (see [Memory extractor](#memory-extractor) below). |
| **Save overlay** | Persists to the active flavor. |

## What the action log records

The action log uses a content-free vocabulary defined in `packages/extensions/src/log/types.ts`. Each event is `{seq, ts, intent, params, success, durationMs?}`. The full intent + param shape:

| Intent | Params | What's recorded |
|--------|--------|-----------------|
| `model.load` | `schema`, `entityCount`, `sizeBytes` | Schema string, integer counts |
| `model.unload` | — | No params |
| `query.run` | `type`, `resultCount` | IFC type name, integer count |
| `lens.apply` | `id` | **Hashed** lens id (djb2 → 8-char hex) — user-named lenses don't leak |
| `lens.clear` | — | No params |
| `export.run` | `format`, `entityCount` | Format label, integer count |
| `script.execute` | `templateId`, `durationMs` | Optional template id, ms duration |
| `chat.message` | `intent` | Coarse classifier output — `authoring` / `query` / `one-shot` / `fork` |
| `extension.{install,uninstall,enable,disable}` | `id` | Extension id |
| `flavor.{activate,export,import}` | `id` or `{}` | Flavor id where relevant |
| `selection.change` | `count` | Integer selection count |
| `section.apply` | — | No params |
| `view.change` | `mode` | `'2d'` or `'3d'` |

What is **never** in the log:

- Model content, GlobalIds, property values
- Chat message text
- File names or file paths
- API keys or credentials
- User identifiers (the system doesn't have any)

## Memory extractor

The Privacy panel's **Extract from chat** button runs a rule-based scanner over your current session transcript. It looks for stable preferences (sentences starting with `Always`, `Never`, `I prefer`, etc.) and proposes them as overlay additions.

The extractor is **privacy-first by design**:

- **Drops anything matching the blocklist.** GUIDs, file paths, email addresses, API key fragments, long alphanumeric blobs, and any phrasing with 2+ numeric tokens get filtered out. Borderline cases are dropped silently — the UI never says "we couldn't redact this".
- **Drops modal-verb noise.** "I will always check" doesn't extract; only direct preferences do.
- **Rule-based, not LLM-driven.** No round trip to a model. The extractor runs entirely on your device.
- **Always reviewable.** Every proposal lists its confidence + lets you discard before saving.

A caveat banner sits above the proposal list: "Rule-based scan — review each line before saving." Heuristics are heuristics; the user is the final filter.

## What flows over the network

The customisation system itself does not make network calls, and the model-loading path keeps your IFC models on your device: parsing and geometry run entirely in your browser, and there is no upload endpoint in the load path. That guarantee covers loading, parsing, and geometry only — if you explicitly attach model content to an AI chat message (see below), that content is sent to your chosen provider. Three adjacent surfaces send data over the network.

1. **Hosted viewer product analytics.** The hosted viewer at ifclite.com emits anonymous, coarse product-usage events via PostHog. This is the only telemetry in the project, and it lives only in the viewer app (`apps/viewer`). The published npm packages (`@ifc-lite/*`) contain no analytics code at all, and a viewer you build yourself with no PostHog key configured (`VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST`) sends nothing.

   What it records: coarse product events such as `ifc_model_loaded` (schema string and integer counts/sizes), `export_completed`, `ids_validation_completed`, `clash_detection_run`, `lens_applied`, tour progress, `ai_chat_message_sent`, and crash/error reports tagged with the build version for regression triage. Events are anonymous by default (PostHog `person_profiles: 'identified_only'`, no autocapture, no page-view capture).

   What it never records: every event passes through a `before_send` scrubber (`apps/viewer/src/lib/analytics-scrub.ts`) that strips any property whose key looks like a file name, model name, title, path, comment, query, or property/pset name; redacts string values that look like a file path or a model file name; and removes the query string and hash from URLs (keeping only the route). Model content, GlobalIds, property values, and file names never leave the browser through analytics.

2. **Chat with the AI assistant.** When you send a chat message, your prompt + the (cached) system prompt + any attachments + recent conversation goes to your chosen provider (Anthropic / OpenAI), either through the BYOK direct flow or the proxy. Attachments can include model content (GlobalIds, property values, selected entities), so attaching model context to a chat message deliberately sends that content off-device to the provider. The chat panel's existing privacy notes apply.

3. **Extension code with `network.fetch:<host>` capability.** An extension can ONLY make fetches you explicitly grant during install. The capability is host-scoped — `network.fetch:api.example.com` cannot reach any other host. Network egress is red-tier in the Capability Review screen; you have to type `approve` to grant it.

## What you can do

| Goal | How |
|------|-----|
| Audit what's stored | Privacy tab → **Export JSON** on the action log; Audit tab → **Export** on the audit log |
| Wipe pattern suggestions | Privacy tab → **Clear** the action log |
| Stop the assistant from "remembering" preferences | Privacy tab → clear the textarea + Save overlay |
| Stop the miner entirely | Disable every action log emit by clearing the log; the miner has no input to act on |
| Forget an extension | Extensions tab → trash icon — removes bundle bytes, install record, granted capabilities |
| Forget a flavor | Flavors dialog → delete on the row (active flavor can't be deleted; switch first) |
| Reset everything | Flavors dialog → **Reset** restores the baseline empty flavor and deactivates extensions |
| Start clean for one session | Append `?safe=1` to the URL (see [Safe mode](extensions.md#safe-mode)) |

## First-launch disclosure

On the first launch where the extensions subsystem comes up, a one-time toast surfaces the headline:

> IFClite keeps a local, content-free action log to suggest one-click tools. Manage or delete it in Extensions → Privacy.

The acknowledgement is persisted in localStorage so you only see it once per browser. To re-show it (e.g. on a different device), clear the `ifclite.extensions.privacy-disclosure.v1` key.

## Source-of-truth references

- The no-content rule: [RFC §06 §7](../architecture/ai-customization/06-self-improvement.md)
- Action log schema: `packages/extensions/src/log/types.ts`
- Memory extractor: `packages/extensions/src/flavor/memory-extractor.ts`
- Audit log: `packages/extensions/src/audit/log.ts`
- Capability gating: `packages/extensions/src/host/check.ts`

## Next steps

- [Extensions](extensions.md) — install, run, audit
- [Flavors](flavors.md) — what's in a flavor (and what isn't — the action log doesn't travel)
