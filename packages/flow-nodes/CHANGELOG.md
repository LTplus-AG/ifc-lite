# @ifc-lite/flow-nodes

## 0.2.0

### Minor Changes

- [#5233](https://github.com/LTplus-AG/ifc-lite/pull/5233) [`04b5467`](https://github.com/LTplus-AG/ifc-lite/commit/04b54673aa1a888ebf8f5d2f48b27558d3e6c4f0) Thanks [@louistrue](https://github.com/louistrue)! - Make the Flow Script node usable over a list, and give its source a real editor.
  
  `ParamKind` gains `'code'` (with an optional `language`), which tells a host that the parameter needs a multi-line editor rather than the single-line `<input>` a `'string'` gets. `script.run`'s `code` parameter now declares it. The value is still a plain string, so a host without a code editor degrades to the string field.
  
  **Fixed: a Script node laced over a list only ever computed its first lane.** Every lane shares one sandbox and QuickJS evaluates a program in the *global* lexical scope, so the second lane's `const inputs = …` — and any `const` in the user's own code — threw "redeclaration of 'x'". The lane error was logged and that lane yielded `null`, which a downstream `core.filter` reads as a legitimate answer, so a per-element script silently produced wrong results for every element but the first. The source is now evaluated through a direct `eval` inside a function, giving each lane its own variable environment while keeping both contract points: `inputs` in scope, and the last expression as the value.
  
  New node `script.list` ("Script (list)"): the same sandbox with `list` ports instead of `item` ports, so the code sees whole lists and returns an array. Sorting, ranking, top-N and de-duplication are not expressible per element; they are three lines here. A result that is not an array is rejected rather than handed to a list port.

- [#5168](https://github.com/LTplus-AG/ifc-lite/pull/5168) [`0ee73f7`](https://github.com/LTplus-AG/ifc-lite/commit/0ee73f70b0aa08c811e37fe3b2c20fe176d3d8f1) Thanks [@louistrue](https://github.com/louistrue)! - New package: the standard node library for `@ifc-lite/flow` over the ifc-lite SDK — `core.*` values and restructuring, `model.*` reads (selector, properties, quantities, relationships, storey grouping), typed `table.*` nodes, `viewer.*` feedback that is a no-op headlessly, capability-gated `model.setProperty`/`model.setAttribute`, parametric `element.*` specs with the tracked `model.addElement` and `model.delete`, and a sandboxed `script.run` node.

### Patch Changes

- Updated dependencies [[`0eafae1`](https://github.com/LTplus-AG/ifc-lite/commit/0eafae1cb19e70828815c658a6ee3c14f9c4c8a8), [`04b5467`](https://github.com/LTplus-AG/ifc-lite/commit/04b54673aa1a888ebf8f5d2f48b27558d3e6c4f0), [`0ee73f7`](https://github.com/LTplus-AG/ifc-lite/commit/0ee73f70b0aa08c811e37fe3b2c20fe176d3d8f1), [`0eafae1`](https://github.com/LTplus-AG/ifc-lite/commit/0eafae1cb19e70828815c658a6ee3c14f9c4c8a8), [`b0d489e`](https://github.com/LTplus-AG/ifc-lite/commit/b0d489ea7270b84c1d373b5e340fc09ba0c798e6)]:
  - @ifc-lite/sdk@7.0.0
  - @ifc-lite/flow@0.2.0
  - @ifc-lite/sandbox@2.6.1
