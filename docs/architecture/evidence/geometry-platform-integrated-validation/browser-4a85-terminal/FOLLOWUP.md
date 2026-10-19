<!-- SPDX-License-Identifier: MPL-2.0 -->
# Corrected-source dispatch and storage follow-up

The original PC setup attempt and the completed WASM/browser attempt remain
unchanged in this archive. Their published vault output was independently read
back and verified before closing their two explicit task IDs. Only these closed
tasks were submitted for managed reclamation; shared compatibility caches and
the active Pop job are not cleanup targets.
Managed reclamation refuses the uncatalogued staged
`rust/geometry-runtime/smlib/LICENSE` file. Both requests therefore leave the
checkout intact. No manual deletion, catalog bypass or foreign cleanup follows.

The subsequent explicit recovery task
`ifclite-browser-4a85-assets-recovery-20261019` adopted only that owned checkout
and selected 55 staged assets and browser-failure files (22,185,901 bytes).
Publication stopped with `ValueError: archive needs explicit digest review; do
not publish whole build trees` on the 4,661-byte Playwright trace archive.
An authoritative task read confirms `evidence_pending` and no published manifests.
The original staged assets and trace remain intact; this is not successful
reclamation or recovered capacity. No archive renaming, policy change, manual
deletion or repeat publication was used to bypass that refusal. The task state
and exact selected-file hashes are retained in `storage-recovery-pending.json`.

A fresh corrected-source attempt was submitted at
`a2040ef13e279e8cb4dc93cfe53713b04d1412aa` as request
`auto-4cdb3cc8bdbb4d50aa6cccd4fd17293c`. The original launcher terminates with:

```json
{"state":"blocked","unavailable":[{"host":"pc-wsl","error":"job kind is disabled on this host"}]}
```

No worker job ID or execution receipt exists for that attempt, and it was not
replayed. A fresh fleet status also reports both hosts refused with guard 78.
The already admitted Pop job `0468a83b-07c8-4268-be78-5eb2c26ed777` remains live.

The corrected command supplies the previously missing test-runner separators
and the shared acceptance method on wasm32. It also selects ChromeDriver
`153.0.8010.52` for PC's installed Chrome build `153.0.8010`, using the official
Chrome-for-Testing linux64 archive, whose SHA256 is
`7726029da262768fd8770212ac54296f4d31afe790a951f98d5580437da533b1`.
The original attempt auto-downloaded driver 155 while Chrome was 153; that
mismatch is observed, but its causal connection to the HTTP 404 is unproved.
The corrected driver/browser execution remains UNRUN. No browser-runtime,
canonical generated-type, root typecheck or CI-readiness pass follows from this
provisioning preparation.
