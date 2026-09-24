# @ifc-lite/flow

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
