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
- **`activeFlavorPointerAlreadyStored(read, pointer)`** is now exported and is
  the single comparison both hosts ask through, so a change to how the pointer
  is encoded lands once. It answers `false` for a pointer that is not a string,
  so an absent id can never match an unset pointer and report a refused write
  with nothing stored as a successful one.
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

The rollback also restores the previous record under its own guard, independent
of the bundle bytes. The record carries the capability grants, the enabled bit,
the install time and the source, none of which need bytes and none of which the
user can reconstruct, so a previous install whose bytes were already gone no
longer has its record deleted by the rollback, and a byte write that fails
during the restore — `putBundle` is the step with a storage-quota path — no
longer takes the record down with it. A record without its bytes is a state the
loader names (`invalid_reference`); reinstalling the same version repairs it and
keeps the grants, but the app offers no route to that today — the Repair queue
passes an extension whose engine range still matches, so it never reports the
missing bytes. Keeping the record is still the better outcome: unloaded *and*
deleted is strictly worse than unloaded.

The rollback now also checks that the record in storage is still the one this
install wrote before undoing anything. `load` is an await point, so a user can
uninstall while a slow load is in flight; restoring the previous record after
that would undo an explicit uninstall. The check is on record identity, never
on whether bytes exist, so it does not reintroduce the gate above.

One cost, in the safe direction: because the snapshot is no longer gated on a
version change, a transient failure reading the previous bundle bytes now fails
a same-version reinstall that previously would have proceeded. Nothing is
written or destroyed in that case; the install has to be retried.

Each comparison is one-directional: `false` means "not provably a no-op", never
a guess, so anything unreadable costs only a refusal that was already the old
behaviour. No path reports success while the stored state differs from what a
successful operation would have left.
