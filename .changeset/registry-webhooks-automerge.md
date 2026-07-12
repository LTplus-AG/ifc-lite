---
"@ifc-lite/collab-server": minor
"@ifc-lite/merge": minor
---

Registry webhooks + auto-merge (08-review.md §8.7, 10-registry.md §10.4): the registry emits HMAC-SHA256-signed events (layer pushed, ref moved/merged, review opened/updated/commented) to configured consumers, and `RefPolicy.autoMerge` merges conflict-free, all-checks-green candidates with a declared base unattended on push — fail-closed with `requireHumanApproval` and for baseless candidates.
