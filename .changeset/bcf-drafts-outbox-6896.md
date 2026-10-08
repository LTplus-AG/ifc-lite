---
"@ifc-lite/viewer": minor
---

BCF drafts & publication (#6896). Draft BCF topics from a clash grouping workspace or from checked clashes, review them (fields, assignee from the server's user list, remove/split/merge findings, comments), reconcile them against a newer clash run by explicit per-topic proposals, and exchange them as plain `.bcfzip` archives that keep the finding mapping. Publishing to a connected BCF server goes through a durable outbox: project permissions and vocabulary are checked first, every write is recorded before it is sent, receipts are kept, a write with an unknown outcome is never resent until "Check server" finds it or confirms its absence, interrupted writes become unknown after reload, and outbox records imported from a library backup arrive blocked. Flow `bcf.createTopic` / `bcf.addComment` runs share the same outbox.
