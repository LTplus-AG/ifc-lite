---
'@ifc-lite/extensions': minor
'@ifc-lite/viewer': patch
---

Don't fail a flavor operation on an active-flavor pointer write that changes
nothing, and snapshot a same-version reinstall before overwriting its bundle.

Four sites wrote in two steps, and treated a refused second write as fatal
without first asking whether that write would have stored what was stored
already:

- **`switchFlavor`** rolled every extension toggle back and reported
  `'<pointer>'` when `setActiveFlavor` was refused. Re-applying the flavor that
  is already active writes the id the pointer already holds, so the refusal
  changed nothing — and the rollback disabled every extension the target
  declares. `FlavorSwitcherCallbacks` gains an optional `readActiveFlavor()`;
  when it reports the id `activeFlavorPointer(target)` would have written, the
  switch stands. Without the callback, or when the read fails, the refusal is
  still fatal — the behaviour every host had before.
- **`activeFlavorPointer(target)`** is now exported: it builds the id the
  pointer stores for a flavor, so the value compared is the value written by
  construction rather than a second derivation that can drift.
- **`ExtensionHostService.switchFlavor`** (viewer) wires that callback through
  `FlavorService.activeId()`, also new. It turned a failed switch into a thrown
  error, which skipped the lens, clash and sidebar restores below it.
- **`FlavorService.resetToDefaults`** (viewer) threw when `setActiveId` was
  refused even though the baseline flavor had landed and the pointer already
  named it — the common case, since resetting is the way back from anything.
  It now rethrows only when the pointer is not provably already that id.

Separately, **`installFromBytes`** (viewer) snapshotted the previous install's
bundle bytes only when the incoming version differed. Bundle bytes are keyed by
id and version, so a reinstall of the same version overwrote them; a loader
rejection then deleted the record and the bundle with nothing to restore,
wiping a working extension. The snapshot is now taken for any previous install.
The teardown stays gated on a version change.

Each comparison is one-directional: `false` means "not provably a no-op", never
a guess, so anything unreadable costs only a refusal that was already the old
behaviour. No path reports success while the stored state differs from what a
successful operation would have left.
