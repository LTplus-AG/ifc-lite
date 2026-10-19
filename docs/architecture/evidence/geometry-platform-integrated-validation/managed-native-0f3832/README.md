<!-- SPDX-License-Identifier: MPL-2.0 -->
# Managed native object lifetime integration

The source and two independent review scopes are pinned in `integration.json`.
The original b20 foreign-release defect is preserved in its review; 0f3832 closes
it in source. Managed object Drop invalidates and queues only its exact object.
Cancellation and uncertain cleanup still retire the captured process.

No Cargo, SDK or actual browser run qualifies this assembled source yet. The
existing running baseline job is source 9be and excludes this integration.
Raw escape, shared-lease identity, slot reuse, foreign release and queued failure
regressions still require execution. Affine integration must add its input handle
to post-drain checks and acquire the same managed lease for each sealed copy.
