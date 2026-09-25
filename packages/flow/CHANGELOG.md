# @ifc-lite/flow

## 0.4.0

### Minor Changes

- [#5446](https://github.com/LTplus-AG/ifc-lite/pull/5446) [`e40213f`](https://github.com/LTplus-AG/ifc-lite/commit/e40213f0806bf40fcbd1a93bce68fb7ad791bcef) Thanks [@louistrue](https://github.com/louistrue)! - Add outbound network requests and environment secrets to flow graphs ([#5167](https://github.com/LTplus-AG/ifc-lite/issues/5167) phases 3.3/3.5), deny-by-default throughout.
  
  `@ifc-lite/extensions` gains a `secret` capability scope: `secret.read:<NAME>` grants a graph read access to one named env var, with a strict exact-match target (`[A-Z][A-Z0-9_]*`, no glob, no universal wildcard) — the one capability target grammar stricter than the general pattern grammar.
  
  `@ifc-lite/sandbox` gains `bim.network.fetch`, gated by a new `network` permission (off by default) plus an exact-host allow-list re-checked on every call against the running graph's actual `network.fetch:<host>` grants. Requests are restricted to `https:`, matched against `new URL(url).hostname` (never the raw URL string, so userinfo/suffix spoofing is rejected by construction), refuse every redirect, cap the response body mid-stream, enforce a combined timeout/abort signal, and strip `Host`/`Cookie`/hop-by-hop headers. The core request logic (`network-request.ts`) is the single implementation shared by the sandbox bridge and the new `HttpRequest` flow node.
  
  `@ifc-lite/flow-nodes` gains the `http.request` node and a `secrets.ts` module: a node param may reference `{{secret:NAME}}`, validated against the graph's declared `secret.read:<NAME>` capabilities and the real environment BEFORE a run starts (an undeclared or unset reference is a validation error, never a silently empty string), then substituted into a throwaway copy of the document. Every resolved secret at least 6 characters long is redacted (`<secret:NAME>`) from run logs, node outputs, and errors — applied at the outer boundary, so a secret that comes back inside a fetched response body is still caught.
  
  Secrets resolve from `process.env` ONLY in `ifc-lite flow run` (`@ifc-lite/cli`) and MCP's `run_flow` (`@ifc-lite/mcp`), which now also redact their `--json`/tool-result output. The viewer's `HostFeatures.secrets` stays always-empty (the browser has no `process.env`), so a graph referencing a secret is reported `unavailable` before it runs, not mid-run; `HostFeatures.network` is `true` there too, so `http.request` runs subject to the browser's own CORS enforcement, surfacing a blocked cross-origin request as an explicit CORS-likely error rather than a silent empty result.
  
  `@ifc-lite/flow` now owns the `{{secret:NAME}}` grammar (`referencedSecrets`, `replaceSecretRefs`), and `checkAvailability` reports a node whose params reference a secret the host lacks as `unavailable`, so `flow validate` no longer calls such a graph runnable.

- [#5928](https://github.com/LTplus-AG/ifc-lite/pull/5928) [`4c7bd47`](https://github.com/LTplus-AG/ifc-lite/commit/4c7bd47e5e8c9bf62d88af6260cc6384a77e0cdf) Thanks [@louistrue](https://github.com/louistrue)! - A Script node that calls `bim.network.fetch` is no longer served a stale memoised result on a rerun ([#5634](https://github.com/LTplus-AG/ifc-lite/issues/5634)). `NodeRunContext` gains an optional `markVolatile()`: a node calls it when a run's result came from outside the graph, and the scheduler then does not memoise that run. `script.run` / `script.list` call it only when the evaluation actually sent a request, so a script that never touches the network stays memoised. The sandbox's `SandboxConfig.network` accepts a `transport`, and the Script node now routes `bim.network.fetch` through the host's `networkTransport`, as `HttpRequest` already did.

## 0.3.0

### Minor Changes

- [#5359](https://github.com/LTplus-AG/ifc-lite/pull/5359) [`94324e2`](https://github.com/LTplus-AG/ifc-lite/commit/94324e2a69a6cf41cf23488ccdc56b2b7d2c069f) Thanks [@louistrue](https://github.com/louistrue)! - Add `describe_flow` and `run_flow` MCP tools ([#5167](https://github.com/LTplus-AG/ifc-lite/issues/5167) Phase 4.3): agents can now discover and execute a `.flow.json` graph headlessly through MCP, exactly as `ifc-lite flow run` does. `describe_flow` returns a graph's declared inputs/outputs with types and registry-aware wiring diagnostics (`validateFlowWiring`, not just the registry-free `parseFlowDocument`) without throwing on an invalid graph. `run_flow` executes a graph against a loaded model, rejects `inputs` keys naming no declared parameter, and reports the run status plus a summary of tracked writes. `@ifc-lite/flow` gains `describeFlowIO`, `resolveDeclaredParam`, `unknownInputKeys`, and `declaredInputKeys` — the introspection/input-validation helpers now shared between `@ifc-lite/cli`'s `flow` command and the new MCP tools, so the two callers cannot independently drift on what counts as a declared parameter.

### Patch Changes

- [#5240](https://github.com/LTplus-AG/ifc-lite/pull/5240) [`46f79e3`](https://github.com/LTplus-AG/ifc-lite/commit/46f79e38649c6d78753587aeaefbf3d5bbef0d95) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix a tracked node whose `NodeDef` has no `remove` hook reporting vanished elements as removed and dropping their entries from the tracking store, orphaning them in the model with no way to retry. The scheduler now warns, counts them as not removed, and retains their entries, matching how the orphan sweep already handles this case.

## 0.2.0

### Minor Changes

- [#5233](https://github.com/LTplus-AG/ifc-lite/pull/5233) [`04b5467`](https://github.com/LTplus-AG/ifc-lite/commit/04b54673aa1a888ebf8f5d2f48b27558d3e6c4f0) Thanks [@louistrue](https://github.com/louistrue)! - Make the Flow Script node usable over a list, and give its source a real editor.
  
  `ParamKind` gains `'code'` (with an optional `language`), which tells a host that the parameter needs a multi-line editor rather than the single-line `<input>` a `'string'` gets. `script.run`'s `code` parameter now declares it. The value is still a plain string, so a host without a code editor degrades to the string field.
  
  **Fixed: a Script node laced over a list only ever computed its first lane.** Every lane shares one sandbox and QuickJS evaluates a program in the *global* lexical scope, so the second lane's `const inputs = …` — and any `const` in the user's own code — threw "redeclaration of 'x'". The lane error was logged and that lane yielded `null`, which a downstream `core.filter` reads as a legitimate answer, so a per-element script silently produced wrong results for every element but the first. The source is now evaluated through a direct `eval` inside a function, giving each lane its own variable environment while keeping both contract points: `inputs` in scope, and the last expression as the value.
  
  New node `script.list` ("Script (list)"): the same sandbox with `list` ports instead of `item` ports, so the code sees whole lists and returns an array. Sorting, ranking, top-N and de-duplication are not expressible per element; they are three lines here. A result that is not an array is rejected rather than handed to a list port.

- [#5168](https://github.com/LTplus-AG/ifc-lite/pull/5168) [`0ee73f7`](https://github.com/LTplus-AG/ifc-lite/commit/0ee73f70b0aa08c811e37fe3b2c20fe176d3d8f1) Thanks [@louistrue](https://github.com/louistrue)! - New package: keyed-data graph runtime — `Item`/`List`/`Group`/`Table` values, ports that declare `item`/`list`/`group` access with key-matched lifting and lacing, a memoised scheduler with a structured run log, `*.flow.json` documents with validation and migrations, and element tracking: tracked nodes get create / update / keep per lane against a persisted set, vanished lanes are removed, sets whose node was deleted from the graph are removed on the next run, and GlobalIds derive from a user-visible tracking key.
