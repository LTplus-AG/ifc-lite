# @ifc-lite/ai

Provider-independent core for AI requests in ifc-lite: the web viewer, Flow AI nodes and headless hosts (CLI) share it, so a budget or an outcome means the same thing everywhere.

It holds no provider client, no credentials and no UI state. A host brings its own transport (a browser SSE client, a BYOK provider client, a headless HTTP call) and this package does the rest:

- **Typed outcomes.** `runModelRequest` resolves to `completed`, `truncated`, `cancelled`, `timeout`, `error` or `refused`, never an exception, with an overall deadline and caller cancellation.
- **Root budgets.** A `RootBudget` caps the requests and output tokens of one task end to end. Every retry, repair, chunk, Flow lane or resumed run reserves from the same root, so no loop can spend more than it allows. Budgets are plain data and can be persisted and restored (`restoreRootBudget`) without resetting what was spent.
- **Usage receipts.** One receipt per request that reached the transport: model, route, times, outcome and the provider-reported token counts. Counts are never estimated; `usageReported: false` says the provider did not report them. A receipt never holds a prompt, a reply or a credential.
- **Bounded JSON output.** `parseJsonOutput` accepts one complete JSON value (optionally in a single ```json fence), bounded by size, depth and value count, and refuses truncated replies and prototype keys. It never extracts JSON from prose.
- **Response schemas.** An optional `outputSchema: JsonResponseSchema` carries an actual JSON object contract to the transport. A transport that sends it reports `onOutputFormat('json-schema')`; a parser-only transport reports `text`. Typed-request receipts include `outputFormat`, describing the outgoing protocol rather than promising model quality or validating evidence. Receipts never contain the schema or its source identifiers. Unsupported schema requests fail without a hidden retry as text.

## Install

```bash
npm install @ifc-lite/ai
```

## One request

```ts
import { createRootBudget, parseJsonOutput, runModelRequest, type AiTransport } from '@ifc-lite/ai';

type Message = { role: 'user' | 'assistant'; content: string };

// Your transport: call `onChunk` for every piece of output and `onComplete` with the whole text.
const transport: AiTransport<Message> = async (call) => {
  const text = '{"label":"routing"}';
  call.onChunk(text);
  call.onFinishReason('stop');
  call.onTokenUsage({ inputTokens: 120, outputTokens: 9 });
  call.onComplete(text);
};

const budget = createRootBudget({ maxRequests: 6, maxOutputTokens: 8000 });
const outcome = await runModelRequest({
  model: 'my-model', route: 'my-host', transport,
  messages: [{ role: 'user', content: 'Classify this clash.' }],
  maxOutputTokens: 1024, routeCeiling: 8192, budget, timeoutMs: 60_000,
}, { onReceipt: (receipt) => console.log(receipt.outcome, receipt.usageReported) });

if (outcome.kind === 'completed') {
  const parsed = parseJsonOutput(outcome.text);
  if (parsed.ok) console.log(parsed.value);
}
```

Two optional hooks let a host observe requests without wrapping the core:

- `onStart({ id, model, route, startedAt, cancel })` runs once when a request is handed to the transport (never for one refused by the budget or cancelled before dispatch). Its `id` is the id of the receipt the request will produce, and `cancel()` aborts it, so an activity list can show it running and offer Cancel.
- `onReceipt(receipt)` runs once per dispatched request, before the outcome resolves.

A transport must not retry on its own: a retry is a new request that spends the root budget again, and only the caller decides that.

## License

MPL-2.0

## Portable native change artifacts

`@ifc-lite/ai/artifacts` is a separate entry exposing `parseModelChangeBatch`,
`changeKey`, native change types, editable attributes and bounded provider
guidance. It is the canonical parser consumed by viewer correction previews
and Flow `ai.propose`. Parsing validates the native data contract; hosts must
resolve targets and recheck current values, permissions and reviewer selection
before applying any changes. Importing the request core alone does not load
the artifact validator. See the [Flow guide](../../docs/guide/flow.md).

`@ifc-lite/ai/chat-completions` exposes the shared opt-in `flowAiConfig` and
`chatCompletionsTransport` consumed by CLI and MCP Flow hosts. Both hosts route
every call through `runModelRequest` with one persistable root pool; credentials
remain host configuration. The request-core and artifact entries stay separate.

`FlowAiConfig.structuredOutput` explicitly enables `response_format` for a
compatible upstream. `flowAiConfig` reads `IFC_LITE_AI_STRUCTURED_OUTPUT=true`
or `false`; the exact official OpenAI endpoint defaults to enabled, while
arbitrary compatible endpoints, including the default OpenRouter endpoint,
default to parser-only. Configure support for the actual upstream model.
