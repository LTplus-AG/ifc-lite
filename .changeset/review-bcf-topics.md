---
"@ifc-lite/collab-server": minor
"@ifc-lite/mcp": minor
---

Review comments as BCF topics (08-review.md §8.6): registry reviews gain `GET/POST /api/v1/reviews/:id/topics` — topics bound to (entity, componentKey?) with server-derived authors, optional viewpoints, and the named-reviewers write gate. The MCP review loop matches: new `add_review_topic` tool, and `get_review_feedback` returns the topics.
