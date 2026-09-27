/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One ordered keyboard listener for viewer commands (#5841). */
import { eventKey, isTextEntryTarget } from '@/lib/keyboard-event';
import { chordOnPlatform, isApplePlatform, type KeyChord } from './chord';
import { KEY_COMMANDS, type KeyCommandId, type KeyContext } from './keyboard-commands';

export type KeyboardLayer = 'global' | 'tool' | 'popover' | 'modal';
export type CommandRun = (event: KeyboardEvent) => boolean | void;

export interface RunnableKeyBinding {
  readonly id: string;
  readonly when: KeyContext;
  readonly keys: readonly KeyChord[];
  readonly layer: KeyboardLayer;
  readonly run: CommandRun;
  readonly active?: () => boolean;
  /** Existing continuous camera movement also accepts held modifiers. */
  readonly ignoreModifiers?: boolean;
  /** E.g. Ctrl+K still works when a plain text input has focus. */
  readonly allowInTextEntry?: boolean | ((event: KeyboardEvent) => boolean);
}

const BUILTIN = new Map(KEY_COMMANDS.map((command) => [command.id, command]));
const registrations = new Set<RunnableKeyBinding>();
const keyUpRegistrations = new Set<(event: KeyboardEvent) => void>();
const LAYER_ORDER: readonly KeyboardLayer[] = ['modal', 'popover', 'tool', 'global'];
const DOUBLE_PRESS_MS = 500;
let lastGlobalEscapeAt = 0;
let listening = false;

function layerForContext(when: KeyContext): KeyboardLayer {
  if (when === 'global') return 'global';
  if (when === 'overlay') return 'popover';
  return 'tool';
}

function matches(chord: KeyChord, event: KeyboardEvent, key: string, double: boolean, ignoreModifiers: boolean): boolean {
  if (!chordOnPlatform(chord, isApplePlatform())) return false;
  if (!ignoreModifiers && Boolean(chord.mod) !== (event.ctrlKey || event.metaKey)) return false;
  if (!ignoreModifiers && Boolean(chord.alt) !== event.altKey) return false;
  // A shifted printable key carries the shift in `key` itself (`?`, `+`).
  // Letter shortcuts require the modifier to be declared explicitly.
  const shiftedSymbol = chord.key === '?' || chord.key === '+' || (chord.key === '-' && key === '_');
  if (!ignoreModifiers && Boolean(chord.shift) !== event.shiftKey && !shiftedSymbol) return false;
  if (chord.double && !double) return false;
  if (chord.key.startsWith('code:')) return event.code === chord.key.slice('code:'.length);
  if (chord.key === '+' && key === '=' && event.shiftKey) return true;
  if (chord.key === '-' && key === '_' && event.shiftKey) return true;
  return key === chord.key;
}

function openLayer(): KeyboardLayer | null {
  if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return 'modal';
  if (document.querySelector('[role="menu"], [role="listbox"], [data-state="open"][role="dialog"]')) return 'popover';
  return null;
}

/** Dispatch one keydown through the active layer, then stop at the first match. */
export function dispatchKeyboardDown(event: KeyboardEvent): string | null {
  if (event.defaultPrevented) return null;
  const key = eventKey(event);
  if (key === null) return null;
  const textEntry = isTextEntryTarget(event);
  const domLayer = openLayer();
  const overlay = domLayer === 'modal' || [...registrations].some((entry) => entry.layer === 'modal' && (entry.active?.() ?? true))
    ? 'modal' : domLayer;
  const now = Date.now();
  // A tool or modal Escape does not start the global double-Escape gesture.
  const double = key === 'escape' && now - lastGlobalEscapeAt < DOUBLE_PRESS_MS;

  for (const layer of LAYER_ORDER) {
    if (layer === 'modal' && overlay !== 'modal') continue;
    if (overlay === 'modal' && layer !== 'modal') break;
    if (overlay === 'popover' && (layer === 'tool' || layer === 'global')) break;
    const bindings = [...registrations].filter((entry) => entry.layer === layer && (entry.active?.() ?? true));
    // A two-press binding wins over the single-press binding on press two.
    bindings.sort((a, b) => Number(Boolean(b.keys.some((chord) => chord.double))) - Number(Boolean(a.keys.some((chord) => chord.double))));
    for (const entry of bindings) {
      const allowInText = typeof entry.allowInTextEntry === 'function'
        ? entry.allowInTextEntry(event) : entry.allowInTextEntry;
      if (textEntry && !allowInText) continue;
      if (!entry.keys.some((chord) => matches(chord, event, key, double, entry.ignoreModifiers ?? false))) continue;
      if (entry.run(event) === false) continue;
      event.preventDefault();
      if (entry.id === 'selection.escape' || entry.id === 'ui.closeAllPanels') lastGlobalEscapeAt = now;
      return entry.id;
    }
  }
  return null;
}

function onKeyDown(event: KeyboardEvent): void {
  dispatchKeyboardDown(event);
}

function onKeyUp(event: KeyboardEvent): void {
  // Release must run even after focus moves into an input or another layer
  // prevents the event; otherwise a held walk key leaves the camera moving.
  for (const release of keyUpRegistrations) release(event);
}

function syncListener(): void {
  const needed = registrations.size > 0 || keyUpRegistrations.size > 0;
  if (needed === listening) return;
  listening = needed;
  if (needed) {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  } else {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    lastGlobalEscapeAt = 0;
  }
}

/** Bind a displayed command to its live action; the table owns its chords. */
export function registerKeyboardCommand(
  id: KeyCommandId,
  run: CommandRun,
  options: Pick<RunnableKeyBinding, 'active' | 'allowInTextEntry' | 'ignoreModifiers'> & { layer?: KeyboardLayer } = {},
): () => void {
  const definition = BUILTIN.get(id);
  if (!definition) throw new Error(`Unknown keyboard command: ${id}`);
  return registerKeyboardBinding({
    id, when: definition.when, keys: definition.keys,
    layer: options.layer ?? layerForContext(definition.when),
    run, active: options.active, allowInTextEntry: options.allowInTextEntry,
    ignoreModifiers: options.ignoreModifiers,
  });
}

/** Used for extension keybindings after built-in registrations. */
export function registerKeyboardBinding(binding: RunnableKeyBinding): () => void {
  registrations.add(binding);
  syncListener();
  return () => { registrations.delete(binding); syncListener(); };
}

export function registerKeyboardKeyUp(release: (event: KeyboardEvent) => void): () => void {
  keyUpRegistrations.add(release);
  syncListener();
  return () => { keyUpRegistrations.delete(release); syncListener(); };
}

export function runnableKeyboardBindings(): readonly RunnableKeyBinding[] {
  return [...registrations];
}
