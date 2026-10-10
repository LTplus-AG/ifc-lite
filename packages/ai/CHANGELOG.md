# @ifc-lite/ai

## 0.2.0

### Minor Changes

- [#7037](https://github.com/LTplus-AG/ifc-lite/pull/7037) [`667bd74`](https://github.com/LTplus-AG/ifc-lite/commit/667bd747e7aa50c3ca1cf688400517c33fd9b8f5) Thanks [@louistrue](https://github.com/louistrue)! - New `@ifc-lite/ai` package ([#6923](https://github.com/LTplus-AG/ifc-lite/issues/6923)): the provider-independent AI request core the viewer, Flow AI nodes and headless hosts share. `runModelRequest` takes a host-supplied transport and resolves to a typed outcome (`completed`, `truncated`, `cancelled`, `timeout`, `error`, `refused`) with an overall deadline and caller cancellation; root budgets (`createRootBudget`, `reserveRequest`, `settleRequest`, `restoreRootBudget`) cap a task's requests and output tokens across retries, chunks, lanes and resumed runs; one usage receipt per dispatched request carries only provider-reported counts; `onStart` announces a dispatched request (its receipt id and a `cancel`) for activity lists; `parseJsonOutput` accepts one bounded JSON reply and refuses truncated output. The viewer's Assistant request service now runs on this core with unchanged behaviour.

- [#7079](https://github.com/LTplus-AG/ifc-lite/pull/7079) [`fc024e3`](https://github.com/LTplus-AG/ifc-lite/commit/fc024e387d27b7ab21e5e6397a97976fafd46726) Thanks [@louistrue](https://github.com/louistrue)! - Expose the canonical portable model-change artifact parser through `@ifc-lite/ai/artifacts` and add a constrained, review-required `ai.propose` Flow node. Drafts preserve captured expected values, cite sent findings and obey explicit native field/value constraints before a separate native mutation preflight.

- [#7250](https://github.com/LTplus-AG/ifc-lite/pull/7250) [`e8dce32`](https://github.com/LTplus-AG/ifc-lite/commit/e8dce320229c9e70bd54d8d627982f864ff54431) Thanks [@louistrue](https://github.com/louistrue)! - Retain dispatched request grants, deadlines, safe finish reasons, producer-declared prompt versions and versioned logical-input/output-text SHA256 digests in canonical generation receipts. Flow hosts forward native producer versions without persisting raw prompts, responses, credentials or endpoints.
  
  Bind receipt model/route to the actual dispatched identities. Native JSON producers explicitly prepare one parsed snapshot for both dispatch and logical digest; generic opaque custom transports keep unknown input metadata without reflection or changed sent-input semantics.

- [#7083](https://github.com/LTplus-AG/ifc-lite/pull/7083) [`4b17e29`](https://github.com/LTplus-AG/ifc-lite/commit/4b17e29c730cb04a4012ed871139b70eb640f191) Thanks [@louistrue](https://github.com/louistrue)! - Enable explicitly configured AI Flow runs in MCP with durable pending artifacts and a separate digest-approved `resume_flow` call. Continuations recheck graph, native effective model state, current scope and the original root budget, then consume one disk CAS claim. Share the existing compatible provider transport and file checkpoint store with the CLI through separate package entries.

- [#7135](https://github.com/LTplus-AG/ifc-lite/pull/7135) [`5a8dd4e`](https://github.com/LTplus-AG/ifc-lite/commit/5a8dd4e9cbe8ca1f3f7fc4c78a0badc84e8d75d3) Thanks [@louistrue](https://github.com/louistrue)! - Carry native Flow AI response schemas through shared requests and host transports, recording whether the request used JSON Schema or text. Preserve native evidence checks and review checkpoints; compatible headless providers can explicitly enable schema requests.
  
  Add the typed unsupported-schema refusal for known host limitations. The viewer checks Anthropic grammar limits before spending the request budget, and native Flow nodes report the limitation without inventing sent evidence.

### Patch Changes

- [#7082](https://github.com/LTplus-AG/ifc-lite/pull/7082) [`ed524ea`](https://github.com/LTplus-AG/ifc-lite/commit/ed524ea7e7efe8e22099b82677f580a3bcc1bb51) Thanks [@louistrue](https://github.com/louistrue)! - Use structured native change identities so delimiters in model ids, property sets and field names cannot collide. This preserves distinct edits and prevents AI proposals from substituting a field outside the graph's constraints.
- Updated dependencies [[`a352a79`](https://github.com/LTplus-AG/ifc-lite/commit/a352a79ee372def56f79d0a331aaacfc896a95a9), [`29a1648`](https://github.com/LTplus-AG/ifc-lite/commit/29a1648b3ea56a346012b65ab3b7e41ecd598e8f), [`09745f0`](https://github.com/LTplus-AG/ifc-lite/commit/09745f0f3bb99ac07802ae061f13df92e865683f), [`2499fdb`](https://github.com/LTplus-AG/ifc-lite/commit/2499fdb249eeffea22fa01c2f0fb12defe812e4a), [`5a40ad8`](https://github.com/LTplus-AG/ifc-lite/commit/5a40ad89723df2dca70248c5caaba6d402ffc762), [`3474bb6`](https://github.com/LTplus-AG/ifc-lite/commit/3474bb6e8be907d6bd1fa58652addf5728bfdee7), [`b92dd05`](https://github.com/LTplus-AG/ifc-lite/commit/b92dd05495094a47c4a68eb1137a3a1906fc65cc)]:
  - @ifc-lite/export@4.10.0
