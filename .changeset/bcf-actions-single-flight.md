---
"@ifc-lite/viewer": patch
---

A double-click or Enter+click no longer runs an async action twice. This covers BCF topic creation (BCF panel, compare, Clash and Clash groups, layer review), Add viewpoint and Capture 2D, BCF import and export, the BCF server's Connect and Load topics, draft publish and export, and draft edits, as well as saved-report deletion and review decisions. An action from a form or panel that has since closed creates nothing.

When the viewpoint a new topic asked for can't be captured, the topic is no longer created without it (or silently skipped). The viewer says the viewpoint couldn't be captured and creates nothing, so the person can retry. With no model loaded there is no viewport, so the BCF panel offers no snapshot, and a topic is created without a viewpoint as before.
