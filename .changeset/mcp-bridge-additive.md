---
"@ifc-lite/mcp": minor
---

`--bridge` now adds the paired browser tab to the normal stdio server instead of replacing it. Headless tools, resources, prompts and file arguments stay; the tab's tools are added as `tab_<name>` when it pairs and removed when it disconnects (`model_audit` runs on a model loaded here, `tab_model_audit` in the tab). The surface tools are `tab_show_ui` and `tab_ui_events`. No port is bound until the agent first calls `bridge_status`, and when 21517 is taken (a second session) the bridge uses the next free port and puts it in the pairing link; an explicit `--bridge-port` does not fall back. A tab's UI event is accepted only for a surface the agent showed it; a prompt the agent did not write there is marked `promptVerified: false` and quoted as data on the channel.
