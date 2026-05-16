# AI Customization & User Flavors — RFC

Status: **Draft** — design phase, no implementation merged.
Owner: TBD.
Last updated: 2026-05-16.

This directory contains the design for IFClite's user-customization and
AI-authored-extension system: a layered architecture that lets each user grow
a personal "flavor" of the app — new tools, panels, lenses, workflows — with
the AI acting as a co-author bound by a strict capability sandbox.

## Why this exists

BIM workflows are deeply idiosyncratic. An architect, a structural engineer,
a quantity surveyor, and a facility manager all want a different IFClite. A
fixed UI is always wrong for someone. Today the only "personalization" the
app offers is saved scripts; users repeatedly reproduce the same sequence of
chat → script → run → forget. This RFC turns those one-shot interactions
into a persistent, composable, shareable customization layer.

It is not a marketplace. It is not a low-code platform. It is a small,
opinionated extension surface that grows with the user, optionally aided by
the LLM already wired into the app.

## Reading order

1. [`00-overview.md`](./00-overview.md) — Vision, design principles, prior
   art and what we learn from each precedent. Read this first.
2. [`01-extension-model.md`](./01-extension-model.md) — Extension manifest
   schema, lifecycle, slot bindings, capability declarations.
3. [`02-security.md`](./02-security.md) — Threat model, sandbox boundaries,
   permission grants, signing, supply-chain hygiene.
4. [`03-ui-surface.md`](./03-ui-surface.md) — Slot registry, declarative
   widget DSL, accessibility, the host-renders-chrome contract.
5. [`04-ai-authoring.md`](./04-ai-authoring.md) — Chat-to-tool flow, repair
   loop generalization, evaluation harness, prompt engineering.
6. [`05-flavors-and-sharing.md`](./05-flavors-and-sharing.md) — Flavor
   bundles, three-way merge, registry design, trust UX.
7. [`06-self-improvement.md`](./06-self-improvement.md) — Action log,
   pattern mining, personal memory, evals on SDK updates.
8. [`07-roadmap.md`](./07-roadmap.md) — Phased delivery, success metrics,
   open questions, what we are explicitly *not* shipping.
9. [`08-prior-art-research.md`](./08-prior-art-research.md) — Long-form
   research notes on every precedent we considered, what we take, and
   what we reject.

## Non-goals

- A general-purpose plugin runtime competing with VS Code's extension API.
- A hosted marketplace with monetization, payments, or paid extensions.
- Cloud-stored personal data by default. Flavors live on-device until the
  user opts to publish or sync.
- Replacing the existing `ScriptPanel` or `ChatPanel`. Both remain; the
  extension system is built on top of the same sandbox.
- Bypassing the sandbox for "trusted" extensions. There is no trusted
  extension. Every extension runs in QuickJS-WASM, full stop.

## Glossary

| Term | Definition |
|---|---|
| **Tool** | A named, persistent script with metadata (icon, hotkey, slot). One step beyond a saved script. |
| **Extension** | A tool plus a manifest declaring permissions, triggers, UI slots, and lifecycle hooks. |
| **Flavor** | A user's complete personalization layer: enabled extensions, lens presets, system-prompt overlay, keybindings, panel layout. |
| **Slot** | A named extension point in the host UI (e.g. `toolbar.right`, `dock.right`, `contextMenu.entity`). |
| **Manifest** | A typed, validated JSON document describing an extension's contract with the host. |
| **Capability** | A specific authority the extension is granted (e.g. `mutate`, `network.fetch:example.com`). Capabilities are scoped, not boolean. |
| **Widget DSL** | A small declarative schema the sandbox uses to describe UI; the host renders it. The sandbox never touches the DOM. |
| **Registry** | An optional, signed catalogue of community flavors. Out of scope until Phase 4. |
