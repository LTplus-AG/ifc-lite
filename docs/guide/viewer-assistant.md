# Contextual viewer assistant

Open **Clash**, **Data validation**, **Compare** or **Flow** and choose **Discuss with AI** in the panel header. The Assistant opens in the existing panel workspace. Select a model, inspect the evidence, and send a question. Sending is the action that contacts the selected provider; opening the panel does not send evidence.

The assistant explains a frozen snapshot of native results. Native verdicts remain authoritative. Clash and comparison evidence retains native counts and model references; validation includes IDS and information-rule results. Manual checklists are not included. Flow discussion includes graph structure, excluding node parameters, inputs, outputs and execution status.

Snapshots include at most 100 rows. Large values can be shortened or omitted; the panel reports the number of included rows and any projection limits. Inspect the JSON to see exactly which evidence accompanies the question. The model is instructed to cite rows as `[E1]`, distinguish inference from native findings, and acknowledge missing provenance. A citation does not establish that the explanation is correct.

If the source or model changes, sending is disabled. **Refresh evidence and start a new conversation** captures the current source and clears the previous discussion. A native result that predates an edit must first be rerun in its source panel. **Return to source** opens that panel.

Model selection and API keys use the existing scripting assistant controls. A request has an output budget and time limit. Incomplete answers are marked. Cancel stops the active request. Failed or cancelled questions stay in the composer for retry and do not consume conversation history.

Explanations preserve native results. Unsaved conversations stay in the current browser session; closing the panel preserves them. Open **Saved conversations**, enter a name and choose **Save conversation** to keep completed turns after reload. Storage failures retain an exportable draft and expose retry or conflict controls. Library backup export/import includes saved assistant conversations.

Opening a saved conversation displays archived evidence and disables sending. Refresh captures current native results and starts a new conversation. Backup imports preserve originals when identities conflict and do not grant archived evidence permission to continue. It does not run scripts, change model data, execute Flow graphs or create BCF issues.

For Flow, ask for a graph patch. Open **Review Flow changes** and choose **Review latest Flow answer**. A complete typed patch must pass native node, parameter, wiring and cycle validation. Inspect before/after JSON, tracking warnings and additional graph capabilities, then mark the review checkbox and choose **Apply graph changes**. Applying changes the current editable graph without executing it. Save the graph in Flow to retain the edits after reload; saving the conversation saves its transcript and evidence separately. Pending graph reviews and their undo receipts stay in the current browser session. **Undo graph changes** restores the reviewed predecessor while the graph and model remain unchanged. Changed or extension-owned graphs refuse apply; later edits or model changes refuse undo. Native Run and its preflight remain separate. Patch review currently accepts at most 50 operations, 100 nodes and 200 edges within its bounded JSON contract. Other reviewed actions are subsequent layers of the [viewer AI implementation plan](../architecture/viewer-ai-plan.md).

## Reviewed report drafts

After a completed Clash, Data validation or Compare answer, expand **Review report draft**, enter a name and choose **Prepare report draft**. Inspect the narrative and captured evidence, verify its claims, then tick the review checkbox before saving or exporting. Unknown row citations, incomplete answers and changed live evidence block saving. A saved conversation can produce an explicitly historical report.

The document includes the provider model, capture time, actual included/native row counts, omission notices and the full evidence sent with that discussion. Citation existence is checked; human review establishes whether a claim is supported. AI prose does not change native verdicts or certify compliance. Values that resemble model bindings remain literal captured text.

**Save reviewed document** uses the existing Documents library. If storage refuses the write, its native recovery/export controls retain the draft. Open the saved document to edit it, export document JSON or generate PDF using the normal Documents controls. Every preparation creates a new document and preserves earlier human edits. Broader structured narrative generation and refresh reconciliation remain required work in the [implementation ledger](../architecture/viewer-ai-implementation.md).

## Load diagnostics

Open **Load report** and choose **Discuss with AI** to attach the native per-model load reports. Rows represent model reports, not a list of every affected element. Native counters, approximation settings, load path and supplied affected-entity identities are retained; the original load time remains in each report. A source without captured diagnostics is explicitly unavailable and never counted as clean. Diagnostics describe the original load and do not validate later edits.

The same conversation Save/Open and reviewed document controls apply. Model replacement or edits invalidate an active discussion; saved evidence remains historical. Large federations and long diagnostics use the common bounded evidence projection with explicit omission notices.
