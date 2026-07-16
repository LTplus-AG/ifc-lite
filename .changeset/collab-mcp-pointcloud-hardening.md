---
'@ifc-lite/collab-server': patch
'@ifc-lite/mcp': patch
'@ifc-lite/pointcloud': patch
---

Harden the collab server, MCP path guard, and point-cloud decoders against abuse and hostile input.

- collab-server: rate-limit the unauthenticated fresh-room token-mint path per client IP (authenticated admin re-mints are exempt), cap `claimedRooms` growth (`COLLAB_MAX_CLAIMED_ROOMS`, default 100k), and coalesce access-control persistence behind an async debounced write instead of a synchronous full-file write per claim.
- collab-server: a ref that requires human approval now refuses approvals when its reviewer allowlist is empty (previously any non-author principal could self-approve past the merge gate).
- collab-server: metrics-token comparison hashes both sides to fixed-length digests before `timingSafeEqual`, removing the length oracle; startup without `COLLAB_TOKEN_SECRET` on a non-loopback host logs an explicit OPEN-server warning; idle rooms unload after `COLLAB_IDLE_UNLOAD_MS` (default 5 min) so long-lived deployments can't wedge at `maxRooms`.
- mcp: the safe-path guard now also refuses shell startup/persistence files (`.bashrc`, `.zshrc`, `.profile`, `.gitconfig`, …) and the `~/.config` tree for both read and write.
- pointcloud: E57/PCD/PLY decoders reject header-declared record/point/vertex counts (and LZF uncompressed sizes) that the actual body bytes cannot back, so a small hostile file can no longer force multi-GB allocations before the first read fails.
