<!-- SPDX-License-Identifier: MPL-2.0 -->
Source ddfafab6d11e2b361aa504723ead2673e2829977 executed unchanged on PC/WSL.
Strict workspace/all-target Clippy failed (101): the cfg(test) parser nesting
re-export is unused when source-resource-tracking is disabled. No pass is claimed.
The corrective change gates that private re-export with the same tracking feature
as its owner consumer, preserving parser grammar and default behavior.

The earlier local owner test request 1a07763f-fea6-4f47-b3a8-5787e0c4d6c0
omitted source-resource-tracking and could not execute these owner tests.
It was cancelled while still queued, before any command ran; its receipt confirms
unchanged source. The replacement must enable the feature explicitly and check
that the named owner tests execute. The original SDK qualification and native
diagnostic requests remain separate and untouched.
