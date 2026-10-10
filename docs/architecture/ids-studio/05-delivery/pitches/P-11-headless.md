# P-11 — Headless everywhere

**Problem.** Developers and AI agents need authoring, lint, diff, test and draft in CI and agent loops. The only alternatives are Python-only, or early MCP servers without grounding.

**Appetite.** 2 weeks (C2: audit/lint/fmt and MCP batch 1) + 3 weeks (C5: everything else and embed), Track D.

**Solution.**
- CLI commands, MCP tools and an SDK namespace over the same packages (`03-architecture/08-cli-mcp-sdk.md`).
- An embeddable Studio mode.
- Flow nodes.
- Docs.

**Rabbit holes.** Keeping generated docs regions and the API-surface snapshot in sync. Follow AGENTS.md per PR.

**No-gos.** No hosted API service.

**Scopes.** IDS-115 … IDS-123.

**Done means.** Every UI capability is available headless (parity checklist), and docs are generated and typechecked.

**Evidence.** CI examples; an MCP session transcript of an external agent building an IDS through `ids_apply_ops`.
