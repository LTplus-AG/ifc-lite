# 08 — Prior Art: Research Notes

A long-form companion to the prior-art section of [`00-overview.md`](./00-overview.md).
Each system is reviewed against the same questions:

1. What is the model?
2. What worked?
3. What broke?
4. What we take.
5. What we explicitly reject.

The point of this document is to be honest about why we are not building
what others have built. None of the systems below are bad. They solved
different problems with different constraints.

## 1. VS Code extensions

**Model.** Contribution-point manifest in `package.json`. Extensions are
Node.js modules. The Extension Host runs in a separate process for
isolation from the renderer. Marketplace publishes, scans for malware,
signs publishers.

**Worked.** The contribution-point taxonomy is the most successful
extension API of the last decade. Themes, languages, debuggers, source
control providers, custom views, commands, keybindings — all
contributable through typed slots. Activation events keep cold start
fast. The marketplace UX is good enough that millions of users install
extensions casually.

**Broke.** The Extension Host runs with full Node.js capabilities.
`require('fs')`, `child_process.spawn()`, network — all available. This
has produced real harm: typo-squatting that stole crypto wallets in
2023, supply-chain compromises through dependency hijacks, ongoing
review burden on Microsoft's security team. Permission scoping is
essentially absent; users either install or do not.

**Take.** The contribution-point model. Manifest-driven activation.
Typed slots with explicit `when` clauses. Slot composition rules.

**Reject.** The full-Node trust model. Our extensions run in QuickJS
with capability scoping; there is no `fs`, there is no `spawn`.

## 2. Obsidian community plugins

**Model.** Community-maintained plugins distributed through a curated
list. Plugins run in the renderer with access to the Obsidian API and
DOM. Plugins are written in TypeScript and compiled to JS bundles.

**Worked.** The plugin-list curation created a healthy long tail of
domain-specific functionality (academic writing, knowledge management,
graph views). Hot-reload during development is great DX.

**Broke.** Several malicious plugins exfiltrated vault contents in
2022-2024 before community review caught them. Optimistic publishing —
"reviewers will catch it" — is structurally inadequate against a
motivated adversary. The plugin API has no permission model.

**Take.** The community-curated-list pattern (Phase 4 registry). The
hot-reload DX is a useful authoring loop.

**Reject.** Optimistic publishing without capability scoping. We
require capability declarations in the manifest and surface them at
install time.

## 3. Chrome / WebExtensions (Manifest V3)

**Model.** Declarative manifest with permissions and host-pattern
allow-lists. Background service worker, content scripts, popup UI.
Permissions requested at install time.

**Worked.** Host-pattern permissions (`https://*.example.com/*`) are
genuinely scoped. The transition from V2 to V3 narrowed the API and
removed long-standing security holes (no more blocking `webRequest`).
The declarative permission model is closer to capability-based than
most precedents.

**Broke.** Click-through fatigue on install prompts. Permission lists
described in vague terms ("read your data on all websites") that
sophisticated users skim past. Optional permissions are rarely used
because most extensions request everything up front.

**Take.** Host-pattern allow-lists for network. Manifest schema
versioning with migrations. Required permission declaration at
install.

**Reject.** The click-through UX. Our review screen requires explicit
user attention; for high-risk caps (mutate wildcards, network
fetch wildcards) we require typed confirmation.

## 4. Figma plugins

**Model.** Two-realm execution: a sandboxed plugin worker with the
Figma API only, and an optional UI iframe with full DOM but no Figma
API. The two communicate via `figma.ui.postMessage`. Plugins are
single-author projects published in a community gallery.

**Worked.** The two-realm model is the cleanest sandbox-plus-UI design
in any major plugin system. It maps cleanly to "logic without DOM,
DOM without authority." Figma's API surface is intentionally narrow,
which kept the surface stable across years of updates.

**Broke.** The optional UI iframe allows arbitrary HTML/JS, which is a
real cross-site scripting surface inside the Figma origin. Compromised
plugin UIs have leaked sensitive data. The two-realm design is
beautiful but the second realm is wide open.

**Take.** The two-realm split. Logic in a sandbox, UI elsewhere.

**Reject.** Free-form HTML/JS in the UI realm. We use a declarative
widget DSL rendered by the host, which keeps the UI realm typed and
auditable.

## 5. Greasemonkey / Tampermonkey userscripts

**Model.** User-installed JavaScript that runs on matching pages.
Activation by URL pattern (`@match`). Capability declarations via
`@grant` (e.g. `GM_xmlhttpRequest`, `GM_setValue`).

**Worked.** Scripts are tiny, focused, and shareable as a single file.
The `@grant` model is genuinely capability-based: a script that does
not `@grant GM_xmlhttpRequest` cannot make cross-origin requests.
Users who never thought of themselves as developers ended up writing
or modifying scripts.

**Broke.** No marketplace curation; scripts come from forums and
GitHub gists. Provenance and integrity are entirely on the user.
Several script repositories have been compromised over the years.

**Take.** The `@grant` model — capability declarations are a hard gate,
not a hint. Single-file shareability.

**Reject.** Zero-curation distribution. Even local extensions in our
system have a review screen; community ones (Phase 4+) are signed.

## 6. Excel macros / VBA

**Model.** A scripting language with first-class access to the
spreadsheet object model and (historically) the full Win32 API.
Macros bundled in `.xlsm` files. Activation on document open.

**Worked.** For decades, this was the most powerful end-user
programming environment that existed. Quants, accountants, engineers
built non-trivial software in VBA.

**Broke.** Macro viruses. Melissa (1999), countless phishing payloads
since. The eventual response was "macros disabled by default with a
yellow banner." Microsoft now defaults to blocking macros from the
internet entirely.

**Take.** Off-by-default for risky activation. Provenance signals to
the user. Make the safe path the default path.

**Reject.** Document-attached macros as a distribution model. We do
not bundle extensions with IFC files; extensions live in the user's
flavor, never inside a model file.

## 7. Home Assistant blueprints

**Model.** Parameterized automation recipes shared as YAML. Users
import a blueprint URL, fill in their specific sensors / actuators,
and get a working automation. Blueprints are version-controlled in a
community forum.

**Worked.** The blueprint pattern is brilliant for end-user
distribution. The author writes once, parameterized; the user
customizes on import without ever editing YAML directly. The forum's
review-and-rate culture handles most quality control.

**Broke.** Limited to Home Assistant's automation surface, which is a
small slot in a much larger application. Discoverability outside the
forum is poor.

**Take.** The blueprint pattern. Flavors are parameterized; the
import flow customizes on instantiation. The three-way merge we
describe in [`05-flavors-and-sharing.md`](./05-flavors-and-sharing.md)
is the blueprint pattern generalized.

**Reject.** Forum-as-distribution. We will not require users to
search a forum to find functionality.

## 8. Notion / Coda / Airtable

**Model.** Database with rich view types (table, board, calendar,
gallery) and a formula language. Users compose views and formulas; few
write JavaScript. Notion and Coda have added plugin/automation systems
on top.

**Worked.** Most users never write code. They build complex workflows
with views, formulas, and templates. The expressivity ceiling is high
enough that "developer" extensions feel optional.

**Broke.** Performance regressions as users build deep stacks of
views and formulas. Hard to debug when a chain of formulas breaks.

**Take.** **Most personalization should not require code.** Before we
build an AI authoring path, we make sure lenses, saved queries, panel
layout, keybindings, and prompt overlays cover 80% of personalization.
Code is the escape hatch.

**Reject.** Nothing structurally. Notion is the prior art that most
shapes how we sequence the roadmap: low-code first, code second.

## 9. Replit Agent / Bolt.new / v0 / Lovable

**Model.** LLM agents that generate full applications from a prompt.
Output is real code in a real framework; the agent iterates against a
preview.

**Worked.** Schema-aware prompting (the model knows the framework's
API surface) lifts correctness substantially. Plan-before-code UX
(Copilot Workspace inherits this) reduces wasted generation.

**Broke.** First-shot output looks plausible and runs once. Without
tests it rots within a few changes. The agents have weak feedback
loops; failures often surface as silent regressions.

**Take.** Schema-aware system prompts (we already do this via
`NAMESPACE_SCHEMAS`). Plan-before-code as a mandatory step. The
authoring contract from [`04-ai-authoring.md`](./04-ai-authoring.md).

**Reject.** Trusting first-shot output. Tests are the deliverable.

## 10. GitHub Copilot Workspace

**Model.** The agent generates a multi-step plan (file list, change
descriptions) before writing code. Users edit the plan; only after
approval does code generation begin.

**Worked.** The plan stage is the single highest-leverage UX
intervention in agentic coding. Users can correct misunderstandings
cheaply, before tokens have been spent on wrong code.

**Broke.** Plans for large changes can themselves be misleading or
incomplete. The plan UI must support edit, not only accept/reject.

**Take.** Plan-before-code with an editable structured plan card.

**Reject.** Auto-approval of plans without user review.

## 11. MCP (Model Context Protocol)

**Model.** A protocol for capability discovery between agents and
tools. Tools declare typed surfaces (functions, resources, prompts);
agents query and invoke them. Permission scopes are part of the
protocol.

**Worked.** Universal capability discovery means the agent's tool
surface is not hardcoded. The protocol's typing catches integration
bugs at the boundary. Our existing `packages/mcp` server is the
agent-facing IFClite.

**Broke.** Early protocol; ecosystem is still settling. Security
posture varies wildly across servers.

**Take.** MCP as the second authoring channel: external agents can
author IFClite extensions through MCP tools, not only the in-app
chat. Capability declarations align with MCP scopes naturally.

**Reject.** Nothing. MCP shapes how we expose authoring to non-app
clients.

## 12. Anthropic computer use, Claude Code, agentic SDK

**Model.** Anthropic's own tools for computer-using and code-writing
agents. Safety considerations published explicitly: do not execute
without approval, surface high-risk actions, log everything.

**Worked.** The "human in the loop" framing is durable. Telemetry for
risky actions catches outliers.

**Broke.** When safety prompts become routine, click-through fatigue
returns. The same hazard as Manifest V3.

**Take.** Risk badges on review screens. Typed confirmation for the
highest-risk capabilities. Audit log for everything material.

**Reject.** Permissive autopilot. We do not auto-install authored
extensions, regardless of which model wrote them.

## 13. WASI Preview 2 / Bytecode Alliance

**Model.** Capability-based I/O for WebAssembly. The runtime provides
explicit handles (filesystem, network, clocks); no ambient authority.

**Worked.** The model is rigorous and audited. Implementations are
maturing across runtimes.

**Broke.** The ecosystem is early; tooling and library support lag
the standard.

**Take.** The capability discipline. Our bridge is the OCAP surface;
we audit it as one.

**Reject.** Nothing structural. If WASI Preview 2 components become
mature inside the browser, we may move the sandbox to a component
model in a future phase.

## 14. Emacs / Smalltalk / TiddlyWiki / Pharo / Glamorous Toolkit

**Model.** Living systems the user modifies from inside. Image-based
or single-file persistence. The boundary between application and
user code is blurred.

**Worked.** Users who invest become more productive than fixed-UI
counterparts by an order of magnitude. The thesis of self-shaping
software is vindicated daily by users of these systems.

**Broke.** The trust model assumes a single user or a trusted code
provenance. None of these systems were designed against modern
adversarial threats. Glamorous Toolkit moves cautiously here by
running in a desktop process with normal OS-level isolation.

**Take.** The thesis. The product shape (your app, not the vendor's).

**Reject.** The trust model. We will not let arbitrary code run in
the host realm.

## 15. n8n / Zapier / Make

**Model.** Visual workflow builders for connecting cloud services.
Workflows are nodes-and-edges; users compose them without code.

**Worked.** Many users automate non-trivial multi-step workflows
without writing a line. The visual representation is durable across
edits.

**Broke.** Performance and debuggability suffer as workflows grow.
Vendor lock-in is high; exporting workflows to another tool is hard.

**Take.** The principle that the visual / declarative representation
is the artifact. We do not build a node-based UI in v1, but the
flavor data model is a declarative representation users could later
edit visually.

## 16. What we are not learning from

Some bodies of work we considered and did not draw from heavily:

- **Browser bookmarklets.** Too small a surface; no analog.
- **Operating-system shells (zsh, fish).** Different paradigm; their
  customization is text-config-driven and they have no permission
  model.
- **Game modding (Bethesda games, Minecraft Forge).** Rich, but the
  trust model is "you trust the modder" and content is the artifact;
  doesn't translate.
- **Adobe extensions (CEP, UXP).** Mostly an enterprise-RPC model.
  The newer UXP is the closest to a modern plugin API; we may revisit.

## 17. Summary table

| System | Sandbox? | Caps? | Curated? | Author UX | Takeaway |
|---|---|---|---|---|---|
| VS Code | weak | no | yes | typed | contribution points |
| Obsidian | no | no | yes | typed | community lane is real |
| Chrome MV3 | yes | scoped | yes | declarative | host patterns |
| Figma | yes | implicit | yes | typed | two-realm execution |
| Tampermonkey | partial | `@grant` | no | text | `@grant` model |
| Excel VBA | no | no | no | text | off-by-default |
| Home Assistant | n/a | n/a | yes | YAML | blueprint pattern |
| Notion | n/a | n/a | n/a | formula | low-code first |
| Bolt.new etc. | n/a | n/a | n/a | LLM | plan before code |
| Copilot Workspace | n/a | n/a | n/a | plan | editable plan card |
| MCP | n/a | scoped | n/a | typed | discovery protocol |
| Emacs / Smalltalk | no | no | no | live | thesis only |

Our system is closest to: Figma's two-realm execution + VS Code's
contribution points + Manifest V3's scoped permissions + Tampermonkey's
`@grant` + Home Assistant's blueprints + Copilot Workspace's plan card
+ MCP's capability discovery. None of these alone fits, but the
combination matches our threat model and our product shape.
