# Contextual viewer assistant

Open **Clash**, **Data validation**, **Compare** or **Flow** and choose **Discuss with AI** in the panel header. The Assistant opens in the existing panel workspace. Select a model, inspect the evidence, and send a question. Sending is the action that contacts the selected provider; opening the panel does not send evidence.

The assistant explains a frozen snapshot of native results. Native verdicts remain authoritative. Clash and comparison evidence retains native counts and model references; validation includes IDS and information-rule results. Manual checklists are not included. Flow discussion includes graph structure, excluding node parameters, inputs, outputs and execution status.

Snapshots include at most 100 rows. Large values can be shortened or omitted; the panel reports the number of included rows and any projection limits. Inspect the JSON to see exactly which evidence accompanies the question. The model is instructed to cite rows as `[E1]`, distinguish inference from native findings, and acknowledge missing provenance. A citation does not establish that the explanation is correct.

If the source or model changes, sending is disabled. **Refresh evidence and start a new conversation** captures the current source and clears the previous discussion. A native result that predates an edit must first be rerun in its source panel. **Return to source** opens that panel.

Model selection and API keys use the existing scripting assistant controls. A request has an output budget and time limit. Incomplete answers are marked. Cancel stops the active request. Failed or cancelled questions stay in the composer for retry and do not consume conversation history.

This first assistant layer is read-only and keeps its conversation in the current browser session. Closing the panel preserves it; reloading the page clears it. It does not run scripts, change model data, execute Flow graphs or create BCF issues. Reviewed actions and durable conversations are subsequent layers of the [viewer AI implementation plan](../architecture/viewer-ai-plan.md).
