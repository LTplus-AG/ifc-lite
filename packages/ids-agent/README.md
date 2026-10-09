# @ifc-lite/ids-agent

The IDS authoring agent of ifc-lite: a tool-calling loop over the operation
vocabulary of [`@ifc-lite/ids-authoring`](../ids-authoring/README.md). It
drafts, edits, explains, repairs, reviews, infers and translates IDS
(buildingSMART Information Delivery Specification) documents.

The model never states IFC or bSDD facts from memory. It looks them up with
tools and changes the document only through `ids_apply_ops`. Every batch goes
through the grounding gate first, so an invented name comes back to the model
as a refusal with ranked candidates instead of reaching the document. The
agent works on a sandbox copy. Its result is a **proposal** the user reviews
batch by batch; nothing reaches the user's document until they accept it.

- **Headless.** No UI, no network client and no credentials. The host brings
  the model transport, and optionally a model bridge (loaded IFC models), a
  bSDD client and a clarification handler.
- **Provider-neutral.** Turns run through `runToolTurn` from `@ifc-lite/ai`
  (root budget, deadline, cancel, usage receipt). Adapters:
  `@ifc-lite/ids-agent/anthropic` (default, `claude-opus-5-5`) and
  `@ifc-lite/ids-agent/openai` (Chat Completions).
- **Testable without a key.** `@ifc-lite/ids-agent/testing` has scripted fake
  models, recorded transcripts with replay, and doubles for the bridges.

## Run the agent

```ts
import { acceptProposal, initialSelection, proposalView, runAgent } from '@ifc-lite/ids-agent';
import { scriptedTransport, toolCall, turn } from '@ifc-lite/ids-agent/testing';
import { createLintContext, createStudioDocument, createStudioState } from '@ifc-lite/ids-authoring';

const lint = await createLintContext();
const doc = createStudioDocument({ title: 'Fire safety' });

// A scripted model stands in for a provider here; see "Providers" below.
const { transport } = scriptedTransport([
  turn([toolCall('schema_find_property', { name: 'FireRating', version: 'IFC4', entity: 'IfcDoor' })]),
  turn([{ type: 'text', text: 'Looked up the door fire rating.' }]),
]);

const run = await runAgent({
  transport,
  mode: 'draft',
  request: 'Every door needs a fire rating.',
  doc,
  gate: lint.gate,
  lint,
  onEvent: (event) => { if (event.type === 'text') console.log(event.delta); },
});

console.log(run.status, run.proposal.summary, run.proposal.receipt.totals);

// Review, then accept the selected batches into the live document (re-gated, one undo step).
const selection = initialSelection(run.proposal);
const view = proposalView(run.proposal, selection);
console.log(view.specs.length, view.unresolved.length);
const { state } = acceptProposal(createStudioState(doc), run.proposal, { gate: lint.gate, batchIds: selection });
console.log(state.doc.ids.specifications.length);
```

## Providers

```ts
import { anthropicTransport, type AnthropicMessagesClient } from '@ifc-lite/ids-agent/anthropic';

// The host builds the SDK client (`new Anthropic()` from `@anthropic-ai/sdk`) with its own credentials.
declare const client: AnthropicMessagesClient;
const transport = anthropicTransport(client, { fallbacks: true });
```

The Anthropic adapter streams with adaptive thinking (summarized), effort per
mode, strict tools where the schema allows, eager input streaming, prompt
caching (tools, then the frozen system prompt, then the run's context),
`output_config.task_budget` and server-side refusal fallbacks. Turn
`fallbacks`, `taskBudgets` or `eagerInputStreaming` off for a platform or
proxy that rejects them. `@anthropic-ai/sdk` is an optional peer dependency.

`openAiTransport({ apiKey, baseUrl })` from `@ifc-lite/ids-agent/openai`
speaks OpenAI-compatible Chat Completions through the host's `fetch`.

## Modes

| Mode | Effort | What it does |
|---|---|---|
| `draft` | high | New IDS from text or attachments; every statement becomes ops or an unresolved entry |
| `edit` | medium | The smallest op batch that does what the instruction asks |
| `explain` | low | Plain-language explanation; no act tools |
| `repair` | medium | Lint errors first, quick fixes where one fits |
| `review` | high | Critique with suggested batches, one per change |
| `infer` | medium | Specifications from what the loaded model already does (needs a model bridge) |
| `translate` | medium | Human-readable text only; the sandbox refuses any other op |

The system prompt is versioned (`SYSTEM_PROMPT_VERSION`, `src/prompts/system-v1.ts`)
and names no IFC class or property set: facts live in the tools.

## Tools

| Group | Tools |
|---|---|
| Schema | `schema_search_entities`, `schema_entity`, `schema_psets_for`, `schema_pset`, `schema_find_property` |
| Document | `ids_read`, `ids_apply_ops`, `ids_undo`, `ids_lint`, `ids_apply_fix`, `ids_mark_unresolved`, `ids_ask_user` |
| Model (with a `ModelBridge`) | `model_stats`, `model_count`, `model_distinct_values`, `model_infer`, `model_coverage` |
| bSDD (with a `BsddClient`) | `bsdd_search`, `bsdd_class`, `bsdd_properties`, `bsdd_resolve_uri` |

Every tool is one JSON Schema plus a handler. The schema handed to the
provider is the schema the input is validated against before the handler
runs (`validateJson` of `@ifc-lite/ids-authoring`). `ids_apply_ops` embeds
the op vocabulary's own schema (`getOpJsonSchema`), with the fidelity ops
removed, `opId` optional and node handles (`"@doors"`) allowed for nodes
created in the run.

`createWorkerModelBridge(port)` / `serveModelBridge(port, impl)` carry a
`ModelBridge` over a message port, so model data stays in a worker.

## Stop conditions, receipts and privacy

A run stops when the model ends its turn, the root budget is spent, the same
failure signature comes back twice in a row, the caller cancels, a request
times out, the wall-clock cap passes, or the model refuses. It always returns
the proposal built so far.

`run.proposal.receipt` lists every request's usage receipt, every tool call,
token totals, an optional cost (from host-supplied pricing) and a SHA-256
digest of what was sent. `privacyView(run)` turns the run into "what was
sent" view data: each request's new content, attributed to its source
(instructions, document, attachments, model data, schema, bSDD).

## Testing and evaluation

```ts
import { recordingTransport, replayTransport, parseTranscript, scriptedTransport } from '@ifc-lite/ids-agent/testing';

const live = scriptedTransport([]);
const recorder = recordingTransport(live.transport);
// ... runAgent({ transport: recorder.transport, ... })
const file = JSON.stringify(recorder.transcript('claude-opus-5-5'));
const replay = replayTransport(parseTranscript(JSON.parse(file)));
```

A recorded run replays deterministically (with the same `runId`), which is how
CI and the evaluation harness exercise the loop without a key.

## License

MPL-2.0.
