---
'@ifc-lite/collab-server': minor
---

Add garbage collection for content-addressed blobs. Blobs were one file per mesh
and were never deleted, so a long-lived server exhausted its volume's INODES
rather than its bytes: production hit 305,741 blobs against a 5 GB volume's
305,175 inodes with only 2.9 GB of 4.9 GB used, and every geometry upload began
failing with ENOSPC. Mean blob size is well under the default 16 KB-per-inode
ratio, so a larger volume only delays this.

The sweep deletes a blob only when no persisted room log references it, no
loaded room references it, and it is older than a 24h grace window covering the
upload-then-reference race. References are unioned across every room, since
content-addressed blobs are shared between rooms and branch forks. Enabled by
default; `COLLAB_BLOB_GC=0` disables it.
