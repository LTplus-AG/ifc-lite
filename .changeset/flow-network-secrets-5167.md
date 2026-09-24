---
"@ifc-lite/extensions": minor
"@ifc-lite/sandbox": minor
"@ifc-lite/flow-nodes": minor
"@ifc-lite/flow": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

Add outbound network requests and environment secrets to flow graphs (#5167 phases 3.3/3.5), deny-by-default throughout.

`@ifc-lite/extensions` gains a `secret` capability scope: `secret.read:<NAME>` grants a graph read access to one named env var, with a strict exact-match target (`[A-Z][A-Z0-9_]*`, no glob, no universal wildcard) — the one capability target grammar stricter than the general pattern grammar.

`@ifc-lite/sandbox` gains `bim.network.fetch`, gated by a new `network` permission (off by default) plus an exact-host allow-list re-checked on every call against the running graph's actual `network.fetch:<host>` grants. Requests are restricted to `https:`, matched against `new URL(url).hostname` (never the raw URL string, so userinfo/suffix spoofing is rejected by construction), refuse every redirect, cap the response body mid-stream, enforce a combined timeout/abort signal, and strip `Host`/`Cookie`/hop-by-hop headers. The core request logic (`network-request.ts`) is the single implementation shared by the sandbox bridge and the new `HttpRequest` flow node.

`@ifc-lite/flow-nodes` gains the `http.request` node and a `secrets.ts` module: a node param may reference `{{secret:NAME}}`, validated against the graph's declared `secret.read:<NAME>` capabilities and the real environment BEFORE a run starts (an undeclared or unset reference is a validation error, never a silently empty string), then substituted into a throwaway copy of the document. Every resolved secret at least 6 characters long is redacted (`<secret:NAME>`) from run logs, node outputs, and errors — applied at the outer boundary, so a secret that comes back inside a fetched response body is still caught.

Secrets resolve from `process.env` ONLY in `ifc-lite flow run` (`@ifc-lite/cli`) and MCP's `run_flow` (`@ifc-lite/mcp`), which now also redact their `--json`/tool-result output. The viewer's `HostFeatures.secrets` stays always-empty (the browser has no `process.env`), so a graph referencing a secret is reported `unavailable` before it runs, not mid-run; `HostFeatures.network` is `true` there too, so `http.request` runs subject to the browser's own CORS enforcement, surfacing a blocked cross-origin request as an explicit CORS-likely error rather than a silent empty result.

`@ifc-lite/flow` now owns the `{{secret:NAME}}` grammar (`referencedSecrets`, `replaceSecretRefs`), and `checkAvailability` reports a node whose params reference a secret the host lacks as `unavailable`, so `flow validate` no longer calls such a graph runnable.
