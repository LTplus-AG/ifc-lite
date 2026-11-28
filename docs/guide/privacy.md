# Privacy

Everything the customisation system stores stays on your device: the action log, audit log, flavor library, and prompt overlay never leave your browser. The default local-file loader runs parsing and geometry in your browser. Hosted cloud imports also send source data through IFClite services for downloading or native conversion. This page covers what's stored, where, and how to inspect or clear it, plus what the hosted viewer sends over the network.

## TL;DR

- **Action log** — content-free intents (model loaded, lens applied, export run) used by the local pattern miner. Never records model content, chat content, file names, or API keys.
- **Audit log** — append-only ledger of extension lifecycle events.
- **Flavor library** — your extensions, lenses, queries, layout, settings, prompt overlay.
- **Prompt overlay** — durable notes the AI assistant sees in every chat (per flavor).

All four live in your browser's IndexedDB. None of it is sent off-device unless you explicitly export. Separately, the hosted viewer can emit anonymous, scrubbed product analytics — see [What flows over the network](#what-flows-over-the-network).

## Where data is stored

| Store | Backend | Purpose | TTL |
|-------|---------|---------|-----|
| `ifc-lite-user-content` | IndexedDB | Saved validation/comparison reports, document templates, migration originals | Until explicit deletion or browser/site-data clearing; originals have a recovery download |
| `ifc-lite-extensions` | IndexedDB | Installed `.iflx` bundles + their records | Forever (or until uninstall) |
| `ifc-lite-flavors` | IndexedDB | Flavor library + snapshots | Forever (snapshots cap at 10 per flavor) |
| Action log | IndexedDB (ring buffer) | Pattern miner input | 50,000 events / 8 MiB rolling |
| Audit log | IndexedDB (ring buffer) | Lifecycle events | 10,000 entries / 10 MiB rolling |

The action and audit logs are held in an in-memory ring buffer and mirrored to IndexedDB, so they survive a reload (both are hydrated from IDB on startup). Clearing a log wipes both the in-memory copy and its persisted copy.

## Settings → Privacy

Open **Settings → Privacy** to control product analytics and inspect or clear local data. The hosted viewer sends anonymous, coarse usage and error events unless you opt out. The switch is stored in this browser and stops both explicit event calls and PostHog automatic capture. A self-hosted viewer without a PostHog key sends no product analytics.

The page also contains these local-data controls:

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

Settings → Privacy's **Extract from chat** button runs a rule-based scanner over your current session transcript. It looks for stable preferences (sentences starting with `Always`, `Never`, `I prefer`, etc.) and proposes them as overlay additions.

The extractor is **privacy-first by design**:

- **Drops anything matching the blocklist.** GUIDs, file paths, email addresses, API key fragments, long alphanumeric blobs, and any phrasing with 2+ numeric tokens get filtered out. Borderline cases are dropped silently — the UI never says "we couldn't redact this".
- **Drops modal-verb noise.** "I will always check" doesn't extract; only direct preferences do.
- **Rule-based, not LLM-driven.** No round trip to a model. The extractor runs entirely on your device.
- **Always reviewable.** Every proposal lists its confidence + lets you discard before saving.

A caveat banner sits above the proposal list: "Rule-based scan — review each line before saving." Heuristics are heuristics; the user is the final filter.

## What flows over the network

The customisation system itself does not make network calls. The default local-file loader parses and renders files in your browser without uploading them. Opening a hosted cloud source downloads source data through IFClite services, and native Autodesk conversion runs on a server. Attaching model content to an AI chat message sends that content to your chosen provider. The following surfaces send data over the network.

1. **Hosted viewer analytics.** The hosted viewer at ifclite.com, including its `/mcp` pages, can send exactly these, and nothing else of its own accord:

   | What | Service | When | Switched off by |
   |------|---------|------|-----------------|
   | Product usage and error events (below) | PostHog | After the first-visit notice, unless you opted out | **Opt out of product analytics**; host: `privacy.analytics` |
   | Page-view counts (cookieless): the page address without query string or hash, and on the first page view the referring address when it is another site | Vercel Web Analytics | After the first-visit notice, unless you opted out | The same opt-out; host: `privacy.vercel-analytics` |
   | An error report you choose to make | IFClite report service | When you open the report form, check for an existing issue, or send the report (see below) | Not opening the form |

   As with any web request, Vercel and PostHog also receive your IP address and browser user agent with each request.

   At build time, not in your browser, the production build uploads the viewer's JavaScript source maps to PostHog (`scripts/vercel-build.sh`) so error stack traces can be read. They contain the viewer's own code, never user data.

   All of this lives only in the viewer app (`apps/viewer`). The published npm packages (`@ifc-lite/*`) contain no analytics code at all, and a viewer you build yourself with no PostHog key configured (`VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST`) sends nothing to PostHog.

   **Before the notice and after an opt-out.** Neither PostHog nor the Vercel script is started before the first-visit notice has been shown in this browser, so no analytics identifier is created or stored and nothing is sent before you have been told about the opt-out. The notice appears in the viewer and on the `/mcp` pages. Events that happen before it are held in the page's memory only, at most 100 of them. This includes a model opened from a link, an error the viewer reports, and an uncaught error or unhandled promise rejection during start-up. Once the notice has been shown they are sent, unless you opt out first, in which case they are dropped. Usage events keep their original time. Error events are sent with the time of sending, carry the original time as the `held_at` property and are marked `held_before_notice`. When you have opted out, PostHog is not started at all on later visits (no request to PostHog), and whatever PostHog stored earlier in this browser (every `ph_` entry in local storage, session storage and cookies) is deleted; the Vercel script is not injected. Switching the opt-out on in an open tab stops every capture at once, drops held events and deletes the same stored entries. Other open tabs of the viewer in the same browser do the same as soon as they see the change. A notice shown in another tab is not passed on to tabs that are already open: such a tab starts its analytics when it shows the notice itself, or on its next page load. A host that switches the notice off (`privacy.notice`) informs its visitors itself, so its analytics do not wait for it. The embed viewer (`apps/viewer-embed`), which runs inside other sites' pages, sends no product analytics and injects no page-view script.

   **What PostHog may record.** The viewer's PostHog configuration (`posthogInitConfig` in `apps/viewer/src/lib/analytics-start.ts`) switches off, in code and regardless of the PostHog project's settings: session recording, autocapture, heatmaps, rage-click and dead-click capture, console log capture, web vitals, surveys, product tours, conversations and experiments. The PostHog project's settings cannot switch any of them back on: for each, the client setting wins, and the console-log extension is left out of the SDK. Unhandled errors may be captured as error events; they pass through the same scrubber as every other event. PostHog keeps a random identifier in this browser (a cookie, local storage, and session storage for the current tab and window) so events from one visit can be grouped; it is not linked to a name, email or account.

   What it records: coarse product events such as `viewer_session_started`, `ifc_model_loaded` (schema string and integer counts/sizes), `export_completed`, `ids_validation_completed`, `clash_detection_run`, `lens_applied`, tour progress, AI chat turns (`ai_chat_message_sent` and `ai_chat_response_completed`: built-in or own-key provider, the model family from the viewer's fixed model list, the turn kind, message and attachment counts, the outcome (success, error or aborted), a coarse error class, latency and time to first token; never the prompt, the response, an attachment or the provider's error text), `stale_reload_resumed` (after the viewer reloads onto a new version: how many open models were reopened automatically and how many the user was asked to open again, counts only; the file names stay in the tab's own session storage), UI interaction events (`command_executed`, `panel_opened`, `panel_replaced`, `tool_activated`, `tool_exited`, `view_reset`, `error_shown`, `file_open_rejected`, `onboarding_surface`: which command, panel, tool or surface was used, as fixed ids only; opens the app makes by itself are not counted), and crash/error reports tagged with the build version for regression triage. `viewer_session_started` marks consenting viewer sessions, including those that load no model. Events are anonymous by default (PostHog `person_profiles: 'identified_only'`, no autocapture, no page-view capture; a page-leave event with the route is captured).

   What it never records: every event passes through a `before_send` scrubber (`apps/viewer/src/lib/analytics-scrub.ts`) that strips any property whose key looks like a file name, model name, title, path, comment, query, or property/pset name; redacts string values that look like a file path or a model file name; and removes the query string and hash from URLs (keeping only the route). The UI interaction events are held to a stricter allowlist (`apps/viewer/src/lib/analytics-ui-events.ts`): any property not declared for the event, and any value that is not a plain id, is dropped. Model content, GlobalIds, property values, and file names never leave the browser through analytics.

   **Error reports.** The viewer contacts the report service only for a report you choose to make. Opening the report form starts a report-service session (a secure cookie; nothing about the error is sent yet). **Check for an existing issue** sends the ID of the one captured error event and the build version, to find a matching GitHub issue. An error that happened before the first-visit notice was held in the page, not yet captured by PostHog, so it has no event ID: **Check for an existing issue** is not offered for it, but you can still send it as a new report. The viewer does not assign held errors an ID of its own, so they keep PostHog's suppression rules and rate limits for error events. **Send report** creates the report from the text you reviewed and, if you attached a model, uploads it, then submits. Reopening a saved report reads its status. The report does not carry the analytics session ID, and no event or session ID is ever published. Reports that the report service stored before this change had their session ID removed when the service next started; database backups taken before then still contain it until the backups expire.

   First visits send nothing until the notice has been shown and the visitor has not opted out. Held usage events then arrive with their original times (error events with `held_at`), but a visit that ends before the notice (about 3.5 seconds into the viewer) sends nothing at all. So first-visit sessions that leave within those seconds are missing from the counts below, and cohorts that span the change that introduced the notice gate are not comparable with earlier ones.

   To measure the first-run charter (#5614), use a PostHog SQL insight grouped by `$session_id`: count distinct sessions with `viewer_session_started` as the denominator and those with `ifc_model_loaded` as the numerator. Measure over a 30-day window: keep only sessions whose first `viewer_session_started` has `timestamp >= now() - INTERVAL 30 DAY`, and count their `ifc_model_loaded` and tour events from the same sessions; without that filter the query counts all time. Several tabs or reloads can send start events for one session, so count distinct IDs rather than raw events. For tour noncompletion, group `tour_started` and `tour_completed` by `$session_id` and `tour_id`, and count starts without a completion after at least 30 minutes without captured activity. Filter cohorts by the start event's `app_build_sha`; later events can come from a newer deploy. Sessions opted out before capture are absent; opting out later stops future events but does not erase earlier events. Do not use PostHog's page-view-based web analytics session count for this viewer, because page-view capture is disabled.

2. **Chat with the AI assistant.** When you send a chat message, your prompt + the (cached) system prompt + any attachments + recent conversation goes to your chosen provider (Anthropic / OpenAI), either through the BYOK direct flow or the proxy. Attachments can include model content (GlobalIds, property values, selected entities), so attaching model context to a chat message deliberately sends that content off-device to the provider. The chat panel's existing privacy notes apply.

3. **Extension code with `network.fetch:<host>` capability.** An extension can ONLY make fetches you explicitly grant during install. The capability is host-scoped — `network.fetch:api.example.com` cannot reach any other host. Network egress is red-tier in the Capability Review screen; you have to type `approve` to grant it.

4. **Hosted cloud sources.** Signing into Autodesk, Dropbox or OneDrive authorizes the configured IFClite gateway to read data from your vendor account. The gateway handles account identity, project/file references and downloaded model bytes. Native Forma resources are converted on the Autodesk gateway; Data Exchange conversion also sends the initiating user's delegated token and source reference to the authenticated Windows worker. The resulting IFC or IFCX then loads through the viewer's browser loader.

   Vendor passwords are entered on the vendor's sign-in page. IFClite keeps delegated access and refresh tokens in backend memory; the browser receives a secure HttpOnly session cookie. Gateways use temporary artifact files while preparing and delivering imports, with deletion on completed, cancelled or expired jobs. Unclaimed prepared results expire after two minutes and active jobs are bounded to fifteen minutes. Sign-out or gateway restart ends the IFClite session. See [Cloud sources](cloud-sources.md) for consent, source access and deployment details.

## What you can do

| Goal | How |
|------|-----|
| Audit what's stored | Settings → Privacy → **Export JSON** on the action log; Extensions → Audit → **Export** on the audit log |
| Wipe pattern suggestions | Settings → Privacy → **Clear** the action log |
| Stop the assistant from "remembering" preferences | Settings → Privacy → clear the textarea + Save overlay |
| Stop product analytics | Settings → Privacy → **Opt out of product analytics** |
| Stop the miner entirely | Disable every action log emit by clearing the log; the miner has no input to act on |
| Forget an extension | Extensions tab → trash icon — removes bundle bytes, install record, granted capabilities |
| Forget a flavor | Flavors dialog → delete on the row (active flavor can't be deleted; switch first) |
| Reset everything | Flavors dialog → **Reset** restores the baseline empty flavor and deactivates extensions |
| Start clean for one session | Append `?safe=1` to the URL (see [Safe mode](extensions.md#safe-mode)) |

## First-launch disclosure

On the first launch where the extensions subsystem comes up, a one-time toast surfaces the headline:

> IFClite stores an action log on your device. The hosted viewer also sends anonymous product analytics unless you opt out in Privacy settings.

The toast has a **Privacy settings** action that opens the opt-out switch and local-data controls. The acknowledgement is persisted in localStorage so you only see it once per browser. Analytics start only once it has been shown. To re-show it, clear the `ifclite.extensions.privacy-disclosure.v2` key.

## Source-of-truth references

- The no-content rule: [RFC §06 §7](../architecture/ai-customization/06-self-improvement.md)
- Action log schema: `packages/extensions/src/log/types.ts`
- Memory extractor: `packages/extensions/src/flavor/memory-extractor.ts`
- Audit log: `packages/extensions/src/audit/log.ts`
- Capability gating: `packages/extensions/src/host/check.ts`

### Saved reports and documents

Validation reports, comparison reports, and documents stay in the browser’s `ifc-lite-user-content` IndexedDB database. Library backup and recovery downloads are local exports; no account or upload is required. Migrated originals are retained for recovery, including content that cannot be parsed. Storage controls report failures and let you export unsaved drafts. Protecting browser storage requests permission from the browser; it does not send report content to a server. See [Storage, backup, and migration](documents.md#storage-backup-and-migration).


## Next steps

- [Extensions](extensions.md) — install, run, audit
- [Flavors](flavors.md) — what's in a flavor (and what isn't — the action log doesn't travel)
