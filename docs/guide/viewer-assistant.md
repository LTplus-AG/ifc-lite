# Contextual viewer assistant

For models that require your own credentials, open the chat key settings and
paste a key from the provider's API console. Anthropic keys are recognized by
the `sk-ant-` prefix; the viewer does not require a particular key version.
Personal and service-account keys scoped to one workspace need only the key.
For an unscoped key, also enter its **Workspace ID** from the Claude Console's
**Settings → Workspaces**. Save commits both fields together. The provider
checks the key's permissions, expiration, and workspace access when you send
a message. See [Anthropic authentication](https://platform.claude.com/docs/en/manage-claude/authentication).

OpenAI project and service-account API keys use the existing API-key flow.
They need access to the selected model and inference endpoint, and available
API billing. The viewer currently supports API keys; ChatGPT account sign-in
and ChatGPT plan usage require a separate OAuth integration. See
[OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication).

The current Anthropic choices are Claude Opus 5.5, Fable 5.1, Sonnet 5.5,
and Haiku 4.5. The current OpenAI choices are GPT-6 Astra, GPT-6.1 Sol, and
GPT-6 Luna; GPT-5.3 Codex remains an older specialized option. Saved Sonnet 5
and GPT-6 Sol selections migrate to Sonnet 5.5 and GPT-6.1 Sol respectively,
keeping the same provider. Model access still depends on your API account.
See the [Claude model catalog](https://platform.claude.com/docs/en/models/overview)
and [OpenAI model catalog](https://developers.openai.com/api/docs/models).

Open the **Assistant** from the Coordinate rail, or choose **Discuss with AI** in the header of an analysis panel: Clash (including duplicate scans), Data validation (IDS, information rules or the manual checklist, whichever side is shown), Lens, BCF, Compare, Changes, Change sets, Zones, Placement, Schedule, Linked records, Layers, Lists, Charts, Cost, Measurements, 2D drawing, Point clouds, Load report, Properties (the current selection), Flow (the graph; the run bar discusses the last run), Script and Document. Opened directly, the Assistant asks what to discuss and lists every source, grouped as Checks, Coordination, Quantities, Model and Automation, with its live status (for example "155 findings", "Not run yet", "Needs two models"): **Discuss** attaches it, **Run clash detection** runs the native check in place and attaches the result, and **Open** takes you to tools that need input such as an IDS file or a comparison pair. **Not discussable** at the end of the list names the panels that have no analysis result (Appearance, Model, Extensions, Session, Sources, Presentation, Environment and the Assistant itself) and why. **Discuss something else** (the arrows in the evidence header) returns to that list; switching asks before it clears an unsaved discussion. The Assistant opens in the existing panel workspace. Its header line names the source, its state (**Current**, **Out of date** or **Saved**) and how many rows are attached; **Evidence details** holds the full caveats and captured JSON. Pick a suggested question or type your own, choose a model below the composer, and press Enter to send (Shift+Enter adds a line). Sending is the action that contacts the selected provider; opening the panel does not send evidence.

The assistant explains a frozen snapshot of native results. Native verdicts remain authoritative. Comparison evidence lists changed entries first and adds the [impact on loaded analyses](model-diff.md#impact-on-other-analyses) and the latest [cross-revision reconciliation](model-diff.md#reconciling-findings-across-revisions) as separate row sections, with their limitations; incompatible runs are sent as a refusal with reasons and no findings, and a reconciliation whose runs predate later model edits is sent as stale, without counts or findings. Every source keeps native totals in its summary, separate from the included sample, with units stated per row or column; values of different kinds, units or currencies are never added together, and unknown provenance stays unknown. Validation includes IDS and information-rule results; a rules result computed before an edit is out of date like an IDS one. Manual checklist answers are human verdicts, not native results. Flow discussion includes graph structure, excluding node parameters, inputs, outputs and execution status. The last run is a separate source: its native diagnostics (status, per-node status, lane errors, error and warning messages, incoming edges, tracking counts, output previews, run warnings and artifact metadata); node parameters appear only for nodes that failed in that run (an error or lane errors; skipped nodes only follow an upstream failure) and the nodes feeding them, with script source withheld and credential-like text such as bearer tokens, URL passwords and token query values redacted. Failing nodes and their inputs come first, so a large run's budget cuts healthy detail rather than the failure. Script evidence never includes the script source, and document, BCF, Flow and point-cloud evidence never include images, snapshots or artifact bytes. Selection evidence covers effective attributes, property sets and quantities of up to 100 selected elements, including unsaved edits. The [adapter register](../architecture/viewer-ai-adapters.md) lists each source's rows, freshness and limits.
