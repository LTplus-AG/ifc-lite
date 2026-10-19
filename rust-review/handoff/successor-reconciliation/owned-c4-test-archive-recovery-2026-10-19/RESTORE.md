# Restore relocated C4 test executables

Archives are standard GNU/PAX tar compressed by zstd. Each `batches/bNNN-<target>.json` binds the exact archive path/SHA256 and complete original absolute path, relative tar member, executable bytes/SHA256, mode, numeric uid/gid and nanosecond mtime. Original inodes/ctimes cannot and are not promised to survive restoration. V23 provenance hashes remain historical identities, now explicitly relocated.

Before restoration, acquire the same existing maintenance/target resource exclusions, confirm no live consumer/queued target work, verify archive SHA256 against the batch manifest, and ensure sufficient native disk space for the original uncompressed bytes **in addition to** the retained archive. Do not restore over a new build or silently overwrite anything. Keep archives/manifests durable even after restoration.

For a completed batch whose original paths are all absent, the standard restore argv is:

```
/usr/bin/tar --zstd --extract --file=ABSOLUTE_ARCHIVE.tar.zst --directory=ORIGINAL_TARGET_ROOT --keep-old-files --same-permissions --same-owner --numeric-owner
```

Use the literal archive/root values from its manifest (also recorded as `restoreArgv` after successful relocation). PAX timestamps preserve the original nanosecond mtime; mode and ownership are stored numerically. All selected files originally belong to the current user and have one link; no hard-link reconstruction is required. If the operator lacks permission to restore an original numeric group, stop rather than substituting ownership.

For an interrupted batch, some originals may still exist. Inspect every manifest path and byte hash first, then supply only the verified absent relative names via a private `--null --files-from=...` list; retain `--keep-old-files`. Never treat an existing file with different bytes as the original. Verify all restored executable SHA256, mode, uid/gid and mtime against the batch manifest. No restoration/build/test/benchmark is executed by these instructions.

Only completed, fully verified `.tar.zst` archives authorize missing original paths. A `.partial` file or failed verification never authorizes removal. The original executable SHA256 authority is the accepted V23 full-content manifest, rebound to unchanged original inode/size/mode/uid/gid/mtime/ctime/link metadata before archive creation; every archived member is freshly hashed and matched to that original authority before unlinking.
