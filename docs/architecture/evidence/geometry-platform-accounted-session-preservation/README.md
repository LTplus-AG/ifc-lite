# Accounted session failure preservation review

Original failing execution: source082aab27df3b2a2550d29510798c0a7cea5a9b23,
job3f4fe221-d5a8-43c9-95d6-dbd116545dc6 output.log failure summary around6793.
Current inspected assembled source base is recorded in manifest.json.

## Typed stop failure

The original every_recoverable_work_kind test called session_work::execute with
Context::default() for every variant. The canonical VoidedSubmeshes implementation
returns an empty collection before body callbacks when void_index has no entry.
Consequently no callback cancels the account, and expecting Cancelled is false.
This is not a lost typed stop. Current inner-program integration already repairs
that test by supplying actual opening200, the host's void-index entry, and a full
request/execute/accept loop through the selected boundary. Original output-empty,
no fingerprint/volume and exactly-one callback assertions are retained.
Added a real public voided-submesh negative control with empty void-index:
no geometry, zero cancelling callback entries, healthy account and restored TLS.
This distinguishes the old invalid test assumption from a reached stop failure.
No production stop propagation change was justified by this diagnosis.

## Panic/live-byte failure

Original352 is a conservative resource charge, not proof of surviving product
output. Mapping frame storage is reserved before callback entry. The exact
Reservation::retain contract retains that charge until the request account dies,
including when the backing Vec already dropped. Usage.live_bytes deliberately is
not precise heap reconciliation. Account.keepalive may additionally be retained
by independently completed valid router cache entries. Reached cache publication
must not be rolled back merely because a later sibling callback panics.

Replaced the misleading usage.live_bytes==0 assertion with stronger actual pooled
ownership witnesses in two cases. Both invoke the real extension exactly once,
observe its unwind, assert TLS restoration, and reacquire decoder/router leases.
Without completed geometry before the callback, admitted output_bytes remains0;
dropping caller account must return the whole model resident permit while router
is still alive. With a real IfcBlock before the panicking extrusion, numerical
output is admitted and its completed local cache must keep the whole conservative
request permit after caller account drop. Dropping the actual router finally must
return total pool residency to0, and a subsequent request must admit successfully.
No hardcoded architecture-dependent352 value is used. Panicking callback call
count prevents an unrelated earlier invariant panic from satisfying the witness.

No session or resource production source was changed. All behavioral tests remain
UNCOMPILED/UNRUN pending coordinated heavy admission. Static path review and diff
whitespace check are not substituted for actual execution receipts.
