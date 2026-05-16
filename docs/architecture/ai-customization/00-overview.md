# 00 — Overview, Principles, and Prior Art

## 1. Vision

Each IFClite user grows a personal version of the app. They describe what
they want in plain language — *"add a button that exports a fire-rating
report grouped by storey"* — and the app produces a sandboxed, persisted,
revertible extension that surfaces exactly that capability. Over time the
app learns the patterns the user repeats and proposes extensions before the
user asks. The user is always in the loop; the AI is a co-author, never a
quiet rewriter of the running system.

The product shape that results:

- A baseline app that ships identically to everyone.
- A user-owned **flavor** layered on top: extensions, lens presets, prompt
  overlay, keybindings, panel layout.
- A flavor is local-first, exportable as a single JSON bundle, and
  shareable by link or import.
- Every piece of generated code is sandboxed, capability-scoped, tested
  against fixtures, and undoable.

## 2. Design principles

These are non-negotiable. Every decision in subsequent documents is
checked against them.

**P1 — Sandbox is the only trust boundary.**
There is no "trusted" extension tier, no privileged author, no opt-out from
QuickJS. The sandbox is the wall; the wall does not move.

**P2 — Host renders chrome, sandbox returns data.**
Extensions do not generate DOM, JSX, or CSS. They emit declarative widget
descriptors that the host renders. This protects the trust boundary from
expressivity creep and makes UI updates the host's responsibility, not the
extension's.

**P3 — Capabilities, not permissions.**
A capability is a specific authority over a specific resource
(`network.fetch:bsdd.buildingsmart.org`, `mutate:Pset_WallCommon.*`), not a
broad flag (`network: true`). Reasoning: every Chrome-extension malware
post-mortem since 2014 traces back to overbroad permission flags. Scoped
capabilities make the blast radius visible.

**P4 — Local-first, then opt-in to share.**
Flavors live in IndexedDB. No telemetry leaves the device unless the user
flips an explicit toggle with a clear-text disclosure. The action log used
for pattern mining is local-only by construction.

**P5 — Tests are the deliverable, not the code.**
When the AI authors an extension, the artifact that proves it works is a
test against canonical fixtures. We ship the test alongside the code. On
SDK updates we re-run all extension tests; failures trigger the repair
loop before the user notices.

**P6 — Reversibility is a first-class feature.**
Every extension install, every flavor merge, every action an extension
takes against the model is undoable. The `@ifc-lite/mutations` package
already provides the primitive; we generalize it.

**P7 — Make the right thing the easy thing.**
If a user can save a script and that script can become a tool with one
click, they will. If they have to fill in a manifest first, they won't.
The progressive disclosure path is: chat → run → "save as tool" → "make
this a proper extension." Each step adds metadata, never re-authors code.

**P8 — The AI is co-author, not co-owner.**
Generated code is never run without a visible diff, capability summary,
and a "what could this do" plain-English description. Auto-execute is a
mode the user opts into per session, never the default for new
extensions.

## 3. Prior art — what we learn from each precedent

The literature on user-customizable software is decades deep. We map the
landscape, then take only what survives our principles.

### 3.1 The Emacs / Smalltalk lineage — "the running system is yours"

**Emacs** (1976-) and **Smalltalk** (1972-) established the canonical
form: a live image the user modifies from inside. Emacs Lisp is the user's
configuration language *and* the implementation language. Smalltalk's
image-based persistence saved every change automatically.

*What survives:* The thesis. Software the user reshapes daily, not
quarterly. The user owns the running system.

*What does not:* Lispy openness assumed a single trusted author. Modern
software faces supply-chain attacks; we cannot evaluate untrusted code in
the host process. The sandbox is non-negotiable.

### 3.2 TiddlyWiki — single-file self-modification

**TiddlyWiki** is a wiki where every page is also a piece of editable
JavaScript. The entire app is one HTML file the user modifies and saves
back to disk. It survives because the trust boundary is the user's own
machine and a single file.

*What survives:* Exportability. A flavor should be one JSON file. No
server is required to share it.

*What does not:* No security model — anything you load runs. We cannot do
this with AI-authored code.

### 3.3 VS Code extensions — the maximalist contribution-point model

VS Code's `package.json` declares **contribution points**: commands,
menus, keybindings, languages, themes, debuggers, views. Each one is a
typed slot. Extensions activate on events (`onLanguage:python`,
`onCommand:foo`). The marketplace is signed, scanned, and reviewed.

*What survives:* The contribution-point model. Named slots with typed
manifests. Activation events. We mirror this directly.

*What does not:* Extensions in VS Code run with the full Node.js
capability set. They can `require('fs')` and `child_process.spawn()`.
This has produced real harm — see the `material-icon-theme` typosquat
incidents and several wallet-stealing extensions in 2023-2025. We will
not replicate that trust model.

### 3.4 Chrome / WebExtensions — permission scoping done partly right

Manifest V3 introduced **declarative permissions** with host matching
(`https://*.example.com/*`) and required at install time. This is closer
to capability-based. However, request strings remain coarse and
permission prompts have well-documented click-through fatigue.

*What survives:* Declarative host-pattern permissions. Install-time
review. Manifest schema versioning.

*What does not:* Click-through prompts. We will not surface a permission
prompt the user has not asked for; capability grants are part of the
extension review screen, shown once with plain-English explanations.

### 3.5 Figma plugins — sandboxed UI done right

Figma plugins run in two parts: the **plugin sandbox** (no DOM access, no
network, only the Figma API) and an optional **UI iframe** (DOM access,
explicit `figma.ui.postMessage` bridge). The API is intentionally narrow.

*What survives:* The two-realm model. Logic in a sandbox, optional UI in
an iframe with an explicit message bridge.

*What does not:* Figma allows arbitrary HTML/JS in the UI iframe. We
prefer a declarative widget DSL because (a) it survives host upgrades
better, (b) it gives us accessibility for free, (c) it lets us render the
same extension in mobile / embed / desktop without per-target porting.

### 3.6 Obsidian plugins — community ecosystem, real lessons

Obsidian's community-plugin model demonstrated that a small, vocal
community of power users will produce hundreds of plugins for a vertical
app. It also demonstrated supply-chain hazards: several malicious plugins
exfiltrated vault contents before review caught them.

*What survives:* Community-plugin as a phase, not a launch. Curated
first, opened later.

*What does not:* Optimistic publishing. Anything in our registry is
signed, reviewed, and the user sees a capability diff on every update.

### 3.7 Excel macros / VBA — the cautionary tale

Decades of Excel macros are why "macros disabled by default" is now
universal. VBA had the full Win32 API. Macro viruses (Melissa, 1999) and
ongoing macro-based phishing are direct results.

*What survives:* "Off by default" for any extension that performs network
egress or mutation. Trust on first use, not on first download.

### 3.8 Greasemonkey / Tampermonkey — user scripts in the wild

Userscripts proved that motivated users will modify other people's apps
through a tiny seam. Tampermonkey's manifest declares `@grant` for
specific APIs and host patterns for activation.

*What survives:* The `@grant` model. Scripts declare what they touch,
not just what they want.

### 3.9 Home Assistant blueprints — shareable user automations

Home Assistant's **blueprints** are parameterized automations the user
imports by URL. The user fills in slots (sensors, triggers, targets)
without writing YAML. The blueprint author writes once; many users
instantiate.

*What survives:* The blueprint pattern. A flavor is *not* a single
extension; it is a parameterized recipe the receiving user can customize
on import. We adopt this directly.

### 3.10 Notion / Coda / Airtable — formula-driven personalization

The lesson here is the opposite of "more power." A small, well-typed
formula language plus a rich view system gave non-developers more
leverage than a general-purpose plugin model would have. Most users
never wrote code; they composed formulas and views.

*What survives:* The principle that **most personalization should not
require code**. Lens authoring, view configuration, panel layout,
keybindings, and saved queries should be first-class flavor elements
*before* we ask anyone to author an extension.

### 3.11 Replit Agent / Bolt.new / v0 / Lovable — AI generates whole apps

These tools demonstrate that LLMs can scaffold real applications from a
prompt. They also demonstrate the failure mode: the output looks
plausible, runs once, and rots within weeks because nothing tests it
against the host's evolving surface.

*What survives:* AI authoring is real and works. Schema-aware system
prompts (we already have this via `NAMESPACE_SCHEMAS`) dramatically
improve correctness.

*What does not:* Trusting first-shot output. Generated extensions must
pass a test against a fixture before they are even offered to the user.

### 3.12 GitHub Copilot Workspace — task plans before code

Copilot Workspace's contribution is the **plan-before-code** UX. The
agent proposes a multi-step plan; the user edits it; only then does code
generation begin.

*What survives:* For any non-trivial extension authoring, surface a
plan: *"I will add a toolbar button labeled X, on click run Y, write
results to Z."* User edits the plan; AI then produces the manifest plus
code.

### 3.13 Anthropic MCP — capability discovery as protocol

MCP (Model Context Protocol) treats tool surfaces as discoverable,
typed, named, and permissioned. The agent learns capabilities at
connection time rather than being hardcoded.

*What survives:* The protocol. Our `@ifc-lite/mcp` server already
implements MCP. Extension authoring is just another MCP tool surface;
external agents can author IFClite extensions via MCP, not only the
in-app chat.

### 3.14 Object-capability security (E, Caja, SES)

The OCAP model: authority is held in objects passed by reference, not
named in ambient strings. The seminal lesson is that *capability
forgery* and *ambient authority* (globals like `fetch`) are the
attack surface, not the API names.

*What survives:* The discipline. In the sandbox, the extension receives
a `bim` capability object. There is no `globalThis.fetch`. If the
extension was not handed a `network.fetch` capability, no API call can
produce one. We code-review the bridge with this lens.

### 3.15 WASI Preview 2 / Bytecode Alliance — capability-based runtimes

WASI Preview 2 made capability-based I/O the default for WebAssembly
component model. The runtime provides explicit handles for filesystem,
network, clocks. No ambient authority.

*What survives:* The model. QuickJS-in-WASM gives us a comparable
isolation story. The bridge layer in `@ifc-lite/sandbox` is our
capability surface; we audit it as such.

## 4. What this lets us build

With those lessons compiled, the system we describe in subsequent
documents has these properties:

- **Slot-based contribution model** (VS Code) — typed, named extension
  points.
- **Two-realm execution** (Figma) — logic in QuickJS, UI declared
  declaratively and rendered by the host.
- **Scoped capability grants** (OCAP, WASI, MCP) — no ambient authority,
  every capability is a handle the bridge issues.
- **Manifest with `@grant` semantics** (Tampermonkey, Manifest V3) —
  install-time declared, plain-English summarized, never silently
  upgraded.
- **Blueprint-style flavors** (Home Assistant) — parameterized, importable
  bundles the receiving user can customize.
- **Plan-before-code AI authoring** (Copilot Workspace) — every authoring
  session produces a reviewable plan first.
- **Test-as-deliverable** (CI discipline) — generated extensions ship
  with fixtures; SDK upgrades re-run them; failures trigger repair.
- **Off-by-default mutation and network** (Excel macros lesson) —
  capabilities that can change shared state require explicit user
  approval and are visible in the status bar while active.
- **Pattern mining only, local-only** (privacy by construction) — the
  app proposes extensions from local action logs; nothing leaves the
  device.

## 5. Out of scope (for the initial design)

- Paid extensions, monetization, payment rails.
- Cross-device sync. Flavors export as JSON; you can move them yourself.
- Generating new IFC schema or Rust crates from the AI. Authoring is in
  the JS sandbox layer only.
- Headless / server-side extensions. The CLI and server consume the same
  manifest, but the v1 authoring UX is browser-only.
- Multi-user collaborative extensions. One author per extension in v1;
  collaboration is a Phase 4 concern.
