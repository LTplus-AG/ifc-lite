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
      touched.push(ext);
      try {
        await opts.callbacks.deactivate(ext.id);
        await opts.callbacks.setEnabled(ext.id, false);
        disabled.push(ext.id);
      } catch (err) {
        failures.push(ext.id);
        await rollback(opts.callbacks, touched);
        return { ok: false, active: opts.current ?? opts.target, failures, disabled, enabled };
      }
    }
  }

  // Step 2: enable + load extensions the target requires.
  for (const ext of opts.installed) {
    if (wanted.has(ext.id) && !ext.enabled) {
      touched.push(ext);
      try {
        await opts.callbacks.setEnabled(ext.id, true);
        const ok = await opts.callbacks.reload(ext.id);
        if (!ok) throw new Error(`reload returned false`);
        enabled.push(ext.id);
      } catch (err) {
        failures.push(ext.id);
        await rollback(opts.callbacks, touched);
        return { ok: false, active: opts.current ?? opts.target, failures, disabled, enabled };
      }
    }
  }

  // Step 3: commit the new active-flavor pointer.
  try {
    await opts.callbacks.setActiveFlavor(opts.target.id);
  } catch (err) {
    await rollback(opts.callbacks, touched);
    return { ok: false, active: opts.current ?? opts.target, failures: [...failures, '<pointer>'], disabled, enabled };
  }

  return { ok: true, active: opts.target, failures, disabled, enabled };
}

async function rollback(
  callbacks: FlavorSwitcherCallbacks,
  touched: readonly FlavorExtensionState[],
): Promise<void> {
  // Restore each touched extension to its prior `enabled` state.
  // Best effort — log but don't throw further.
  for (const ext of touched) {
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
