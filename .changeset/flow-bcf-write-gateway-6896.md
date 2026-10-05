---
"@ifc-lite/flow-nodes": minor
---

`bcf.createTopic` and `bcf.addComment` send every write through `FlowHost.bcfWrites` when the host supplies one (#6896). The new `BcfWriteGateway` records the intent before sending and the receipt after, and refuses to resend a write whose earlier attempt has an unknown outcome. Hosts without a gateway still write directly, but a lost connection is now reported as an unknown outcome ("check the project before running this node again") instead of a plain failure; nothing is retried.
