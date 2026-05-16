# Extensions

IFClite extensions are **small, sandboxed bundles** that add commands, panels, lenses, exporters, or context-menu items to the viewer. They run inside a QuickJS-WASM sandbox with explicit capability grants — they cannot read your file system, hit the network, or mutate your model unless you've granted them permission.

This guide covers the user-facing side: installing an extension someone shared with you, running it, managing it, and the Ideas panel that suggests new ones based on what you do most. For authoring your own, see [Authoring Extensions](extension-authoring.md).

## What is an extension?

A `.iflx` file is a gzipped JSON bundle containing:

- a **manifest** declaring what the extension contributes (commands, panels, etc.) and which capabilities it needs
- one or more **JavaScript modules** that run in the sandbox when triggered
- optional **widget JSON** describing UI to render inside a panel
- optional **declared tests** the runner can execute against the extension

The viewer enforces three things for every extension:

1. **Capability gating.** Each extension declares a list like `model.read`, `viewer.colorize`, `export.create:csv`. You see and approve each one before install.
2. **Sandbox isolation.** Extension code never touches the page's `globalThis`, `window`, `document`, or `fetch`. Everything goes through the `ctx.bim` API.
3. **Audit logging.** Every install, enable, disable, capability grant, and unexpected runtime error is recorded in the local audit log.

## Quick start

### Install a `.iflx` file

1. Open the viewer.
2. Open the **Command Palette** (`Ctrl+K` / `Cmd+K`) and run **"Extensions"** — the Extensions panel docks on the right.
3. Drag a `.iflx` file onto the panel (or click **Import**).
4. The **Capability Review** dialog opens:

    - The header shows the overall risk tier (green / yellow / red).
    - Each requested capability has a per-row description and risk badge.
    - Uncheck any capability you don't want to grant — the extension still installs, but methods that need the denied capability will fail loudly at runtime.
    - Click **Source** to read the bundle's code before approving.
    - Red-tier capabilities require typing `approve` as friction.

5. Click **Install**. The extension's contributions register immediately; commands appear in the Command Palette under the extension's name.

!!! tip "Upgrade vs. fresh install"
    If the bundle id matches one you already have installed, the review screen shows a **Capability changes since v1.x.y** banner highlighting newly-requested or dropped capabilities — re-consent only kicks in for new red-tier grants.

### Run an extension command

Any way you'd run a built-in command works for extensions:

- **Command Palette** (`Ctrl+K`) → type the command title
- **Toolbar** — if the extension contributes a `toolbar.right` button it sits next to the built-in tools
- **Keybinding** — if the extension declares one
- **Context menu** — right-click on an entity / canvas surfaces contributed items the extension declared with a matching `when` clause

### Enable, disable, uninstall

In the Extensions panel each row has:

| Control | What it does |
|---------|-------------|
| ![fork] Fork | Seed the chat with the bundle's manifest + source as an editing prompt (see [Authoring](extension-authoring.md#forking-an-existing-extension)) |
| ![tests] Run tests | Execute every test in `manifest.tests` against the bundle |
| Switch | Enable / disable without uninstalling — the bundle stays on disk, contributions register on enable |
| ![trash] Trash | Uninstall — removes the bundle bytes, the install record, and revokes all grants |

[fork]: data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48Y2lyY2xlIGN4PSIxOCIgY3k9IjYiIHI9IjMiLz48Y2lyY2xlIGN4PSI2IiBjeT0iNiIgcj0iMyIvPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTgiIHI9IjMiLz48cGF0aCBkPSJNNiA5djJjMCAuNTUyLjQ0OCAxIDEgMWg2Ii8+PHBhdGggZD0iTTEyIDEydjMiLz48L3N2Zz4=
[tests]: data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNNCAyMmgxNiIvPjxwYXRoIGQ9Ik0xMCAxNHY0YTIgMiAwIDAgMCAyIDIiLz48cGF0aCBkPSJNMTQgMnY2bC0zIDR6Ii8+PC9zdmc+
[trash]: data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMyA2aDE4Ii8+PHBhdGggZD0iTTE5IDZ2MTRhMiAyIDAgMCAxLTIgMkg3YTIgMiAwIDAgMS0yLTJWNiIvPjxwYXRoIGQ9Ik04IDZWNGEyIDIgMCAwIDEgMi0yaDRhMiAyIDAgMCAxIDIgMnYyIi8+PC9zdmc+

## The Extensions panel

Five tabs across the header:

=== "Installed"

    The default view — every installed extension as a row. Lists granted capabilities (collapsed to 4 with an overflow count), install date, and the four per-row controls above.

=== "Ideas"

    Suggestions from the local pattern miner. The miner watches recurring sequences in your action log ("you loaded a model, applied a lens, exported CSV — 5 times in 3 sessions") and proposes one-click tools. Each card has an **Author it** button that opens the [Plan Card](#plan-card) so you can edit the proposal before the AI authors the bundle. See [Self-improvement loops](#self-improvement-loops).

=== "Repair"

    Surfaces SDK-update compatibility. When the viewer version moves, extensions whose declared `engines.ifcLiteSdk` range no longer matches are flagged here with their failing test detail. Click **Repair** to seed the chat with a fix prompt. This tab does **not** run on mount — click **Run check** to spin up the sandboxes.

=== "Audit"

    Append-only ledger of lifecycle events: `install`, `uninstall`, `update`, `enable`, `disable`, `activate`, `deactivate`, `capability_grant`, `capability_revoke`, `unhealthy`, `killed`. Filter by event kind, export the log as JSON, or clear it.

=== "Privacy"

    Controls for the local action log + prompt overlay. See [Privacy](privacy.md).

## Capability Review screen

The Capability Review modal is the consent boundary for everything an extension can touch. Three things make it stricter than a typical "Accept" button:

1. **Per-row checkboxes.** You can grant `model.read` while denying `network.fetch:*`; the extension installs, calls that need the denied capability throw a structured `CapabilityDeniedError`.
2. **Risk tiers.** Green is read-only / scoped. Yellow needs a second look. Red is network egress, model mutation, or unknown capability — those force you to type `approve` before the Install button enables.
3. **Source preview tab.** Click **Source** to browse the manifest plus every JS/widget file in the bundle. Comes from the bundle's `files` map, not an external link; you read the actual installed code.

!!! warning "Unknown capabilities are red"
    A capability the host doesn't recognise is treated as high-risk by default — we'd rather over-warn than under-warn. If a bundle requests something like `experimental.foo:bar` the row shows red until that capability lands in the catalogue.

## Self-improvement loops

The Ideas panel is one of three loops the viewer runs locally. The miner watches your action log; the memory extractor watches your chat transcript; the repair queue watches SDK bumps.

### Pattern miner → Ideas

The miner runs on idle (default: after 60 s of inactivity, no more than once per 5 min). It scans the local action log for **frequent intent sequences** — e.g. `model.load → lens.apply → export.run` — and emits the top-scoring ones, filtered against extensions you already have.

Click **Re-mine** in the Ideas panel to force a run without waiting for idle.

### Plan card

Clicking **Author it** on an Ideas card opens the **Plan Card**: a structured proposal showing summary, rationale, planned contributions, requested capabilities (each with a risk badge), triggers, and tests. You can:

- Edit the summary inline
- Remove contributions you don't want
- Untick capabilities the plan over-requests
- Hit **Author it** to seed the chat with the plan as a starting prompt

The chat panel then drives the regular [authoring pipeline](extension-authoring.md#the-authoring-loop).

## Sandbox limits

Every extension runs with explicit resource caps:

| Limit | Default | Purpose |
|-------|---------|---------|
| Memory | 64 MiB | Heap cap, enforced by QuickJS `setMemoryLimit` |
| CPU | 5 s sync | Interrupt handler kills runaway loops |
| Stack | 1 MiB | `setMaxStackSize` |
| Globals | none | No `globalThis`, `window`, `document`, `fetch` access — only `ctx.bim` + injected globals |

When the authoring loop runs an extension's tests against a candidate bundle, those defaults tighten further (25% memory, 50% CPU) so a broken extension fails fast instead of burning your budget.

## Safe mode

If an extension is misbehaving and you can't reach the Extensions panel, append `?safe=1` to the viewer URL. Safe mode:

- Skips automatic flavor activation
- Doesn't load any installed extension code
- Surfaces a banner so you know the UI is intentionally minimal
- Leaves the storage / install records intact — you can still uninstall from the panel once you've reached it

```
https://your-viewer.example.com/?safe=1
```

## Troubleshooting

??? question "An extension doesn't appear after install"
    Refresh the page. The install hot-registers contributions but a few slot types (status bar items, dock panels) only mount on the next render pass.

??? question "A command throws `CapabilityDeniedError`"
    The extension is calling a method that requires a capability you denied during install. Open the Extensions panel, click the row's Audit entry, and re-install with the capability granted — or read the source first to decide whether the call is reasonable.

??? question "Tests fail with `Entry "src/foo.js" missing from bundle files`"
    The manifest declares an entry that isn't packed into the `.iflx`. If you authored the bundle, run `ifc-lite ext validate <bundle-dir>` to catch this before packing.

??? question "I want to inspect what an extension is doing"
    The **Audit** tab logs every lifecycle event and unhealthy runtime error. For per-command observability, run the extension and then check the browser DevTools console — `console.log` calls from sandbox code surface there with an `[ext:<id>]` prefix.

## Next steps

- [Authoring extensions](extension-authoring.md) — build your own with the CLI
- [Flavors](flavors.md) — bundle your extensions + lenses + settings into a shareable profile
- [Privacy](privacy.md) — what gets stored locally and how to clear it
