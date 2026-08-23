---
'@ifc-lite/viewer': patch
---

Tell the user when a flavor switch could not apply part of the flavor, instead
of warning about it in the console.

`ExtensionHostService.switchFlavor` restores three pieces of viewer state after
the extension switch itself has landed: saved lenses, the clash rule-set +
detection settings, and the sidebar layout. Each of those can be refused on its
own — the store commits a config only once it has actually persisted, and a
browser that blocks `localStorage` outright refuses every write. The refusals
were `console.warn`ed and the method returned `void`, so `FlavorDialog` toasted
an unqualified "Switched to X" over a flavor whose clash config had not been
applied at all. In a locked-down browser, switching flavor changed nothing the
user could see and nothing told them why (#3002).

`switchFlavor` now returns `{ unapplied }`, one entry per part that did not land
(`'lenses' | 'clash' | 'layout'`) carrying the refusal's own message, and the
dialog reports those parts and their reason in place of the success toast.

The gate is the store's own verdict, not "was a write refused": a write refused
over bytes identical to what is already stored changed nothing, and
`applyClashFlavorConfig` already answers `ok` for that case. Such a switch keeps
reporting a plain success, because the state the user asked for is the state
they have.

This does not make the config apply in a browser that refuses storage — it
cannot, since the flavor's config would silently revert on the next reload. What
changes is that the refusal is now visible and names its cause.
