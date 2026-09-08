/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flavor switcher — deactivate the current flavor's extension set,
 * activate the new flavor's set, restore state on failure.
 *
 * v1 only switches the extension list. Lenses, saved queries, layout,
 * keybindings, settings, and the prompt overlay live in the flavor
 * but are read by individual viewer features as they consume those
 * stores — the switcher doesn't have to push them anywhere.
 *
 * The switcher is host-agnostic: callers wire deactivate/activate
 * primitives (typically `ExtensionLoader.unload` / `load` + the
 * `ExtensionRuntime.deactivate`) and a way to enumerate the
 * currently-installed extensions. On any failure the switcher rolls
 * back: extensions that came up under the prior flavor are restored,
 * the active-flavor pointer is unchanged, and the caller sees the
 * specific failure.
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md §4.
 */

import type { Flavor } from './types.js';

export interface FlavorExtensionState {
  id: string;
  enabled: boolean;
}

export interface FlavorSwitcherCallbacks {
  /** Set the enabled flag on an installed extension. */
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** Stop any running activation for an extension that's being disabled. */
  deactivate(id: string): Promise<void>;
  /** Load + activate an extension that's being enabled. Returns false on failure. */
  reload(id: string): Promise<boolean>;
  /** Persist the active-flavor pointer. */
  setActiveFlavor(id: string): Promise<void>;
  /**
   * Read the persisted active-flavor pointer back, if the host can.
   *
   * Optional. Supplying it lets the switcher tell a refused pointer write
   * that would have changed nothing from one that would have: without it,
   * every refusal fails the switch, which is the behaviour a host that does
   * not supply it already had.
   */
  readActiveFlavor?(): Promise<string | undefined>;
}

export interface FlavorSwitchResult {
  /** True iff the whole switch succeeded. */
  ok: boolean;
  /** The flavor that's now active. */
  active: Flavor;
  /** Extensions that failed to load under the new flavor, if any. */
  failures: string[];
  /** Extensions that were disabled because they're not part of the new flavor. */
  disabled: string[];
  /** Extensions that were enabled by the switch. */
  enabled: string[];
}

export interface FlavorSwitchOptions {
  target: Flavor;
  /** Currently-installed extension records — id + enabled bit. */
  installed: readonly FlavorExtensionState[];
  /** Currently-active flavor (for rollback context). */
  current?: Flavor;
  callbacks: FlavorSwitcherCallbacks;
}

/**
 * The exact id the active-flavor pointer stores for `target` — the value
 * `setActiveFlavor` is handed here, and the value a `FlavorStorage.setActiveId`
 * is handed elsewhere. The single source of it, so a caller asking whether a
 * pointer write would change anything compares the value that would actually
 * be written.
 */
export function activeFlavorPointer(target: Flavor): string {
  return target.id;
}

/**
 * Whether the persisted active-flavor pointer already holds exactly
 * `pointer` — i.e. whether writing `pointer` would change nothing.
 *
 * `read` is the host's way of reading the pointer back and `pointer` is the
 * value that would have been written, which callers build with
 * `activeFlavorPointer` so the compared value is the written value by
 * construction. Every host that asks this question asks it in exactly this
 * shape, so it lives here once: an encoding change to the pointer lands in
 * `activeFlavorPointer` and this comparison follows it, in every package.
 *
 * One-directional on purpose: `false` only means "not provably a no-op". A
 * host that cannot read the pointer back, or whose read fails, answers
 * `false`, because the write really might have changed it. A caller uses this
 * to let a refused write pass, and letting one pass that would have moved the
 * pointer is the failure that matters.
 *
 * The same asymmetry governs a non-string `pointer`: the type forbids it, but
 * if one arrives, `undefined === undefined` against an unset pointer would
 * report a refused write with nothing stored as a successful one. That is the
 * unsafe direction, so it answers `false`.
 */
export async function activeFlavorPointerAlreadyStored(
  read: (() => Promise<string | undefined>) | undefined,
  pointer: string | undefined,
): Promise<boolean> {
  if (!read) return false;
  // Nothing is provably stored for a pointer that is not a value we write.
  if (typeof pointer !== 'string') return false;
  try {
    return (await read()) === pointer;
  } catch {
    // Unreadable pointer: nothing is provably stored.
    return false;
  }
}

/**
 * Drive the switch. For each installed extension:
 *
 *   - If the target flavor declares it → enable + reload.
 *   - Otherwise → deactivate + disable.
 *
 * On any reload failure the switcher backs out completely: every
 * extension we touched is restored to its prior enabled state, and
 * the active-flavor pointer stays on `current` (if supplied).
 */
export async function switchFlavor(
  opts: FlavorSwitchOptions,
): Promise<FlavorSwitchResult> {
  const wanted = new Set(opts.target.extensions.map((e) => e.id));
  const enabled: string[] = [];
  const disabled: string[] = [];
  const failures: string[] = [];
  const touched: FlavorExtensionState[] = [];

  // Step 1: deactivate / disable extensions not in the target.
  for (const ext of opts.installed) {
    if (!wanted.has(ext.id) && ext.enabled) {
      try {
        await opts.callbacks.deactivate(ext.id);
        await opts.callbacks.setEnabled(ext.id, false);
        touched.push(ext);
        disabled.push(ext.id);
      } catch (err) {
        // Don't push the failing entry to touched — rollback would
        // re-call the same op that just failed. If deactivate threw
        // mid-flight, set the prior enabled=true to make sure the
        // ledger lines up, then roll back the items that did succeed.
        try {
          await opts.callbacks.setEnabled(ext.id, ext.enabled);
        } catch {
          // Best effort.
        }
        failures.push(ext.id);
        await rollback(opts.callbacks, touched, ext.id);
        return { ok: false, active: opts.current ?? opts.target, failures, disabled, enabled };
      }
    }
  }

  // Step 2: enable + load extensions the target requires.
  for (const ext of opts.installed) {
    if (wanted.has(ext.id) && !ext.enabled) {
      try {
        await opts.callbacks.setEnabled(ext.id, true);
        const ok = await opts.callbacks.reload(ext.id);
        if (!ok) throw new Error('reload returned false');
        touched.push(ext);
        enabled.push(ext.id);
      } catch (err) {
        // Reset the persisted enabled flag back to what it was so the
        // ledger matches reality, then roll back the previous touches.
        try {
          await opts.callbacks.setEnabled(ext.id, ext.enabled);
        } catch {
          // Best effort.
        }
        failures.push(ext.id);
        await rollback(opts.callbacks, touched, ext.id);
        return { ok: false, active: opts.current ?? opts.target, failures, disabled, enabled };
      }
    }
  }

  // Step 3: commit the new active-flavor pointer.
  try {
    await opts.callbacks.setActiveFlavor(activeFlavorPointer(opts.target));
  } catch (err) {
    // A refused write that would have stored exactly what is stored already
    // changed nothing, so it must not undo the toggles that landed above.
    // Switching to the flavor that is already the active one — a re-apply
    // after a partial switch, or a reload that re-runs the switch — writes the
    // pointer it already holds; failing here would disable every extension the
    // target declares and report the flavor as not applied while the pointer on
    // disk names it.
    //
    // Everything this check needs is built inside the `try`. We are already
    // inside a `catch` with toggles applied and the rollback still ahead of
    // us, so a throw from here would escape `switchFlavor` and skip that
    // rollback — leaving applied exactly the toggles this branch exists to
    // preserve or undo. A host that hands a non-function `readActiveFlavor`,
    // or a target whose id cannot be read, is therefore not provably a no-op:
    // it takes the refusal path below like any other unreadable pointer.
    let alreadyStored = false;
    try {
      const read =
        typeof opts.callbacks.readActiveFlavor === 'function'
          ? opts.callbacks.readActiveFlavor.bind(opts.callbacks)
          : undefined;
      alreadyStored = await activeFlavorPointerAlreadyStored(
        read,
        activeFlavorPointer(opts.target),
      );
    } catch {
      alreadyStored = false;
    }
    if (!alreadyStored) {
      await rollback(opts.callbacks, touched);
      return { ok: false, active: opts.current ?? opts.target, failures: [...failures, '<pointer>'], disabled, enabled };
    }
  }

  return { ok: true, active: opts.target, failures, disabled, enabled };
}

async function rollback(
  callbacks: FlavorSwitcherCallbacks,
  touched: readonly FlavorExtensionState[],
  skipId?: string,
): Promise<void> {
  // Restore each touched extension to its prior `enabled` state.
  // Skip the one that just failed so we don't re-trigger the same op.
  // Best effort — log but don't throw further.
  for (const ext of touched) {
    if (ext.id === skipId) continue;
    try {
      await callbacks.setEnabled(ext.id, ext.enabled);
      if (ext.enabled) {
        await callbacks.reload(ext.id);
      } else {
        await callbacks.deactivate(ext.id);
      }
    } catch (err) {
      console.error(`[flavor-switcher] rollback failed for ${ext.id}:`, err);
    }
  }
}
