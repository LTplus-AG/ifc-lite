<!-- SPDX-License-Identifier: MPL-2.0 -->
# Private-source provisioning failure

Request `auto-d1a4b398c4b946919b37895d6f2b263a` for source4066 returned1 before a job: PC lacked the private commit and origin refused an unadvertised-object fetch. No tests, Clippy or job qualification ran. The registered source_transfer helper subsequently verified a 51,409-byte incremental bundle for source5f103 under refs/ifc-fleet, without public publication or history rewriting. A fresh distinct fleet request is required; the original is not replayed.
