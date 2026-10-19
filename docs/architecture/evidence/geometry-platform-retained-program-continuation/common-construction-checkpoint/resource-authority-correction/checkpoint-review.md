# Checkpoint resource review

Nine owned source paths frozen; SHA-256 identities are in checkpoint-after.json. No source edits outside those paths.

Independent review identified a concrete precedence defect: an earlier local cancellation cached in the owned terminal or account could replace a later authoritative source ancestor fault. OwnedResourceContext::remember now retains account-local first-fault state while returning and caching the actual source-chain result whenever present. A real root/child execution-epoch invariant covers both unaccounted and bounded-account modes, local cancellation before ancestor refusal, scope restoration, and resource state surviving expired execution authority.

Static integration review found no further concrete type/ownership blocker: intact ticket/context/source/owner checks precede installation of captured resources; resource checks precede SDK issue, post-SDK delivery and acceptance take; ledger capacity is admitted before take and retained alongside its account. Explicit original None excludes later ambient accounts. No lexical guard is retained in an issued packet.

Validation: all nine files parse through rustfmt stdout with skip_children; no formatting writes. Rust source-text assertions guard passes. Refwalk guard passes (0 unguarded; 12 existing fan-out review warnings). git diff --check passes. Production files have 133,104,317,86,154,106 lines; all below400. Compilation, Clippy, SDK fixtures and behavioral tests remain UNRUN here. Parent will submit full workspace validation.

Missing broader gates remain explicit: final-net publication, complete mapped/Boolean/opening retained coverage, fully bounded SDK/source/scratch allocations, actual browser continuation integration, and end-to-end performance. Permanent exact default unchanged.
