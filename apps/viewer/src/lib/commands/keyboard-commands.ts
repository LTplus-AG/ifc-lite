/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's keyboard commands: one row per action a key performs, with the
 * keys that perform it and the context they work in (#5836, charter #5610).
 *
 * This table is the single home of every key binding's DISPLAY. The shortcuts
 * dialog is generated from it, and every tooltip, palette row and menu item
 * that names a key asks `shortcutLabel(id)` for it, so a key can no longer be
 * documented one way in the dialog and another on a button.
 *
 * Handlers register by command id with the layered dispatcher (#5841), which
 * reads the chords and contexts here. Surfaces work (#5870) adds icons and
 * placements in its own registry.
 *
 * Adding a binding = adding a row here, in the same PR as its handler.
 * `keyboard-commands.test.ts` fails when two rows claim one chord in one
 * context.
 */

import type { TranslationKey } from '@/i18n';
import { ACTION_NAME_KEYS } from './action-names';
import type { KeyChord } from './chord';

/**
 * Where a binding is live. Two commands may share a chord only in different
 * contexts: a tool context wins over `global` while that tool is active.
 */
export type KeyContext =
  | 'global'
  /** Menus, popovers and dialogs: the top open one takes the key. */
  | 'overlay'
  | 'tool.walk'
  | 'tool.measure'
  | 'tool.addElement'
  | 'tool.spaceSketch'
  /** While a modeling command runs (Model workspace, charter #6232). */
  | 'command'
  /** One modeling command's own keys, e.g. `command.wall.place`. */
  | `command.${string}`
  /** While the Model workspace is open (not while walking): its tool rail keys. */
  | 'workspace.model'
  /** The 2D drawing's measure and annotation tools. */
  | 'drawing2d'
  /** While right mouse is held in the 3D view (fly). */
  | 'flight'
  /** While the search field steps through matches with n / N. */
  | 'search.cycle'
  /** While the search field has focus. */
  | 'search.field'
  | 'panel.reposition'
  | 'panel.chat'
  /** While the Schedule (Gantt) panel has focus. */
  | 'panel.schedule'
  /** While the script editor has focus. */
  | 'panel.script'
  /** While a schedule bar is being dragged. */
  | 'schedule.drag';

export type KeyCommandCategory =
  | 'editing' | 'tools' | 'selection' | 'visibility' | 'camera' | 'search' | 'ui' | 'help';

/** Dialog order: categories render in this order, commands in table order. */
export const KEY_COMMAND_CATEGORIES: readonly KeyCommandCategory[] = [
  'editing', 'tools', 'selection', 'visibility', 'camera', 'search', 'ui', 'help',
];

export interface KeyCommandDefinition {
  readonly id: string;
  /** What the keys do, as the shortcuts dialog says it (`commands.en.ts`). */
  readonly labelKey: TranslationKey;
  readonly category: KeyCommandCategory;
  readonly when: KeyContext;
  /** Every chord that performs this command, the primary one first. */
  readonly keys: readonly KeyChord[];
  /**
   * `range` shows the first and last chord (`Alt+1…0`) instead of listing
   * every one; the keys must form a sequence for that to read correctly.
   */
  readonly display?: 'range';
}

const k = (key: string, mods: Omit<KeyChord, 'key'> = {}): KeyChord => ({ key, ...mods });

const DIGITS: readonly KeyChord[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => k(d));

const ALT_DIGITS: readonly KeyChord[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
  .map((d) => k(`code:Digit${d}`, { alt: true }));

export const KEY_COMMANDS = [
  // ── Editing ───────────────────────────────────────────────────────────
  { id: 'edit.undo', labelKey: 'commands.edit.undo', category: 'editing', when: 'global', keys: [k('z', { mod: true })] },
  { id: 'edit.redo', labelKey: 'commands.edit.redo', category: 'editing', when: 'global', keys: [k('z', { mod: true, shift: true }), k('y', { mod: true, only: 'other' })] },
  { id: 'edit.toggleEditMode', labelKey: 'commands.edit.toggleEditMode', category: 'editing', when: 'global', keys: [k('e')] },
  { id: 'edit.rotate', labelKey: 'commands.edit.rotate', category: 'editing', when: 'global', keys: [k('r'), k('r', { shift: true })] },
  { id: 'edit.duplicate', labelKey: 'commands.edit.duplicate', category: 'editing', when: 'global', keys: [k('d', { mod: true }), k('d', { mod: true, shift: true }), k('d', { mod: true, alt: true })] },

  // ── Tools ─────────────────────────────────────────────────────────────
  { id: 'tool.select', labelKey: 'commands.tool.select', category: 'tools', when: 'global', keys: [k('v')] },
  { id: 'tool.walk', labelKey: 'commands.tool.walk', category: 'tools', when: 'global', keys: [k('c')] },
  { id: 'tool.measure', labelKey: 'commands.tool.measure', category: 'tools', when: 'global', keys: [k('m')] },
  { id: 'tool.annotate', labelKey: 'commands.tool.annotate', category: 'tools', when: 'global', keys: [k('p')] },
  { id: 'tool.section', labelKey: 'commands.tool.section', category: 'tools', when: 'global', keys: [k('x')] },
  { id: 'tool.split', labelKey: 'commands.tool.split', category: 'tools', when: 'global', keys: [k('k')] },
  { id: 'walk.move', labelKey: 'commands.walk.move', category: 'tools', when: 'tool.walk', keys: [k('w'), k('a'), k('s'), k('d')] },
  { id: 'walk.moveArrows', labelKey: 'commands.walk.moveArrows', category: 'tools', when: 'tool.walk', keys: [k('arrowup'), k('arrowleft'), k('arrowdown'), k('arrowright')] },
  { id: 'measure.toggleSnap', labelKey: 'commands.measure.toggleSnap', category: 'tools', when: 'tool.measure', keys: [k('s')] },
  { id: 'measure.cancel', labelKey: 'commands.measure.cancel', category: 'tools', when: 'tool.measure', keys: [k('escape')] },
  { id: 'measure.finish', labelKey: 'commands.measure.finish', category: 'tools', when: 'tool.measure', keys: [k('enter')] },
  { id: 'addElement.commit', labelKey: 'commands.addElement.commit', category: 'tools', when: 'tool.addElement', keys: [k('enter')] },
  { id: 'addElement.clearPending', labelKey: 'commands.addElement.clearPending', category: 'tools', when: 'tool.addElement', keys: [k('escape')] },
  { id: 'addElement.toggleSnap', labelKey: 'commands.addElement.toggleSnap', category: 'tools', when: 'tool.addElement', keys: [k('s')] },
  { id: 'spaceSketch.undo', labelKey: 'commands.spaceSketch.undo', category: 'tools', when: 'tool.spaceSketch', keys: [k('z', { mod: true })] },
  { id: 'spaceSketch.redo', labelKey: 'commands.spaceSketch.redo', category: 'tools', when: 'tool.spaceSketch', keys: [k('z', { mod: true, shift: true })] },
  { id: 'spaceSketch.commit', labelKey: 'commands.spaceSketch.commit', category: 'tools', when: 'tool.spaceSketch', keys: [k('enter')] },
  { id: 'spaceSketch.cancel', labelKey: 'commands.spaceSketch.cancel', category: 'tools', when: 'tool.spaceSketch', keys: [k('escape')] },
  { id: 'command.commit', labelKey: 'commands.command.commit', category: 'tools', when: 'command', keys: [k('enter')] },
  { id: 'command.cancel', labelKey: 'commands.command.cancel', category: 'tools', when: 'command', keys: [k('escape')] },
  { id: 'command.undoPoint', labelKey: 'commands.command.undoPoint', category: 'tools', when: 'command', keys: [k('backspace')] },
  { id: 'command.nextField', labelKey: 'commands.command.nextField', category: 'tools', when: 'command', keys: [k('tab')] },
  { id: 'command.typeValue', labelKey: 'commands.command.typeValue', category: 'tools', when: 'command', keys: DIGITS, display: 'range' },
  { id: 'command.toggleSnap', labelKey: 'commands.command.toggleSnap', category: 'tools', when: 'command', keys: [k('s')] },
  { id: 'command.column.rotate', labelKey: 'commands.command.columnRotate', category: 'tools', when: 'command.column.place', keys: [k('r')] },
  { id: 'model.wall', labelKey: 'commands.model.wall', category: 'tools', when: 'workspace.model', keys: [k('w')] },
  { id: 'model.slab', labelKey: 'commands.model.slab', category: 'tools', when: 'workspace.model', keys: [k('s', { shift: true })] },
  { id: 'model.column', labelKey: 'commands.model.column', category: 'tools', when: 'workspace.model', keys: [k('c', { shift: true })] },
  { id: 'model.beam', labelKey: 'commands.model.beam', category: 'tools', when: 'workspace.model', keys: [k('b', { shift: true })] },
  { id: 'model.room', labelKey: 'commands.model.room', category: 'tools', when: 'workspace.model', keys: [k('o', { shift: true })] },
  { id: 'model.storeyUp', labelKey: 'commands.model.storeyUp', category: 'tools', when: 'workspace.model', keys: [k('pageup')] },
  { id: 'model.storeyDown', labelKey: 'commands.model.storeyDown', category: 'tools', when: 'workspace.model', keys: [k('pagedown')] },
  { id: 'model.move', labelKey: 'commands.model.move', category: 'tools', when: 'workspace.model', keys: [k('m', { shift: true })] },
  { id: 'model.rotate', labelKey: 'commands.model.rotate', category: 'tools', when: 'workspace.model', keys: [k('q', { shift: true })] },
  { id: 'command.element.rotate.pivot', labelKey: 'commands.command.rotatePivot', category: 'tools', when: 'command.element.rotate', keys: [k('p')] },
  { id: 'drawing2d.cancel', labelKey: 'commands.drawing2d.cancel', category: 'tools', when: 'drawing2d', keys: [k('escape')] },
  { id: 'drawing2d.delete', labelKey: 'commands.drawing2d.delete', category: 'tools', when: 'drawing2d', keys: [k('delete'), k('backspace')] },
  { id: 'drawing2d.orthogonal', labelKey: 'commands.drawing2d.orthogonal', category: 'tools', when: 'drawing2d', keys: [k('shift')] },
  { id: 'reposition.apply', labelKey: 'commands.reposition.apply', category: 'tools', when: 'panel.reposition', keys: [k('enter')] },
  { id: 'reposition.cancel', labelKey: 'commands.reposition.cancel', category: 'tools', when: 'panel.reposition', keys: [k('escape')] },
  { id: 'reposition.constrain', labelKey: 'commands.reposition.constrain', category: 'tools', when: 'panel.reposition', keys: [k('x'), k('y'), k('z')] },
  { id: 'reposition.nudge', labelKey: 'commands.reposition.nudge', category: 'tools', when: 'panel.reposition', keys: [k('arrowup'), k('arrowdown')] },
  { id: 'schedule.undo', labelKey: 'commands.schedule.undo', category: 'editing', when: 'panel.schedule', keys: [k('z', { mod: true })] },
  { id: 'schedule.redo', labelKey: 'commands.schedule.redo', category: 'editing', when: 'panel.schedule', keys: [k('z', { mod: true, shift: true }), k('y', { mod: true })] },
  { id: 'script.run', labelKey: 'commands.script.run', category: 'editing', when: 'panel.script', keys: [k('enter', { mod: true })] },
  { id: 'script.save', labelKey: 'commands.script.save', category: 'editing', when: 'panel.script', keys: [k('s', { mod: true })] },
  { id: 'script.undo', labelKey: 'commands.script.undo', category: 'editing', when: 'panel.script', keys: [k('z', { mod: true })] },
  // CodeMirror's historyKeymap: Mod-y, with Mod-Shift-z on macOS instead.
  { id: 'script.redo', labelKey: 'commands.script.redo', category: 'editing', when: 'panel.script', keys: [k('z', { mod: true, shift: true, only: 'apple' }), k('y', { mod: true, only: 'other' })] },
  { id: 'schedule.cancelDrag', labelKey: 'commands.schedule.cancelDrag', category: 'tools', when: 'schedule.drag', keys: [k('escape')] },

  // ── Selection ─────────────────────────────────────────────────────────
  { id: 'selection.escape', labelKey: 'commands.selection.escape', category: 'selection', when: 'global', keys: [k('escape')] },

  // ── Visibility ────────────────────────────────────────────────────────
  { id: 'visibility.hideSelection', labelKey: 'commands.visibility.hideSelection', category: 'visibility', when: 'global', keys: [k('delete'), k('backspace'), k(' ')] },
  { id: 'visibility.showAll', labelKey: ACTION_NAME_KEYS.showAll, category: 'visibility', when: 'global', keys: [k('a')] },
  { id: 'basket.isolate', labelKey: 'commands.basket.isolate', category: 'visibility', when: 'global', keys: [k('i')] },
  { id: 'basket.add', labelKey: 'commands.basket.add', category: 'visibility', when: 'global', keys: [k('='), k('+')] },
  { id: 'basket.remove', labelKey: 'commands.basket.remove', category: 'visibility', when: 'global', keys: [k('-')] },
  { id: 'basket.toggleDock', labelKey: 'commands.basket.toggleDock', category: 'visibility', when: 'global', keys: [k('d')] },
  { id: 'basket.saveView', labelKey: 'commands.basket.saveView', category: 'visibility', when: 'global', keys: [k('b')] },

  // ── Camera ────────────────────────────────────────────────────────────
  { id: 'camera.home', labelKey: 'commands.camera.home', category: 'camera', when: 'global', keys: [k('h')] },
  { id: 'camera.fitAll', labelKey: 'commands.camera.fitAll', category: 'camera', when: 'global', keys: [k('z')] },
  { id: 'camera.frameSelection', labelKey: 'commands.camera.frameSelection', category: 'camera', when: 'global', keys: [k('f')] },
  { id: 'camera.viewTop', labelKey: 'commands.camera.viewTop', category: 'camera', when: 'global', keys: [k('1')] },
  { id: 'camera.viewBottom', labelKey: 'commands.camera.viewBottom', category: 'camera', when: 'global', keys: [k('2')] },
  { id: 'camera.viewFront', labelKey: 'commands.camera.viewFront', category: 'camera', when: 'global', keys: [k('3')] },
  { id: 'camera.viewBack', labelKey: 'commands.camera.viewBack', category: 'camera', when: 'global', keys: [k('4')] },
  { id: 'camera.viewLeft', labelKey: 'commands.camera.viewLeft', category: 'camera', when: 'global', keys: [k('5')] },
  { id: 'camera.viewRight', labelKey: 'commands.camera.viewRight', category: 'camera', when: 'global', keys: [k('6')] },
  { id: 'camera.pan', labelKey: 'commands.camera.pan', category: 'camera', when: 'global', keys: [k('arrowup'), k('arrowleft'), k('arrowdown'), k('arrowright')] },
  { id: 'flight.move', labelKey: 'commands.flight.move', category: 'camera', when: 'flight', keys: [k('w'), k('a'), k('s'), k('d')] },
  { id: 'flight.upDown', labelKey: 'commands.flight.upDown', category: 'camera', when: 'flight', keys: [k('e'), k('q')] },

  // ── Search ────────────────────────────────────────────────────────────
  { id: 'search.focus', labelKey: 'commands.search.focus', category: 'search', when: 'global', keys: [k('f', { mod: true }), k('/')] },
  { id: 'search.openAdvanced', labelKey: 'commands.search.openAdvanced', category: 'search', when: 'global', keys: [k('f', { mod: true, shift: true })] },
  { id: 'search.openAdvancedFromField', labelKey: 'commands.search.openAdvancedFromField', category: 'search', when: 'search.field', keys: [k('enter', { mod: true })] },
  { id: 'search.nextMatch', labelKey: 'commands.search.nextMatch', category: 'search', when: 'search.cycle', keys: [k('n')] },
  { id: 'search.previousMatch', labelKey: 'commands.search.previousMatch', category: 'search', when: 'search.cycle', keys: [k('n', { shift: true })] },
  { id: 'search.exitCycle', labelKey: 'commands.search.exitCycle', category: 'search', when: 'search.cycle', keys: [k('escape')] },

  // ── UI ────────────────────────────────────────────────────────────────
  { id: 'ui.commandPalette', labelKey: 'commands.ui.commandPalette', category: 'ui', when: 'global', keys: [k('k', { mod: true })] },
  { id: 'ui.openPanel', labelKey: 'commands.ui.openPanel', category: 'ui', when: 'global', keys: ALT_DIGITS, display: 'range' },
  { id: 'ui.toggleSidebar', labelKey: 'commands.ui.toggleSidebar', category: 'ui', when: 'global', keys: [k('code:Backslash', { alt: true })] },
  { id: 'ui.closeAllPanels', labelKey: 'commands.ui.closeAllPanels', category: 'ui', when: 'global', keys: [k('escape', { double: true })] },
  { id: 'ui.closeOverlay', labelKey: 'commands.ui.closeOverlay', category: 'ui', when: 'overlay', keys: [k('escape')] },
  { id: 'ui.toggleTheme', labelKey: 'commands.ui.toggleTheme', category: 'ui', when: 'global', keys: [k('t')] },
  { id: 'chat.focusInput', labelKey: 'commands.chat.focusInput', category: 'ui', when: 'panel.chat', keys: [k('l', { mod: true })] },
  { id: 'chat.close', labelKey: 'commands.chat.close', category: 'ui', when: 'panel.chat', keys: [k('escape')] },

  // ── Help ──────────────────────────────────────────────────────────────
  { id: 'help.shortcuts', labelKey: 'commands.help.shortcuts', category: 'help', when: 'global', keys: [k('?')] },
] as const satisfies readonly KeyCommandDefinition[];

export type KeyCommandId = (typeof KEY_COMMANDS)[number]['id'];

/**
 * Pointer gestures the dialog documents beside the keys. They are not
 * commands (nothing dispatches them by id), so they carry their own
 * translated "keys" text instead of chords.
 */
export interface PointerGesture {
  readonly id: string;
  readonly gestureKey: TranslationKey;
  readonly labelKey: TranslationKey;
  readonly category: KeyCommandCategory;
}

export const POINTER_GESTURES: readonly PointerGesture[] = [
  { id: 'flight.look', gestureKey: 'commands.gesture.flightLook.keys', labelKey: 'commands.gesture.flightLook', category: 'camera' },
  { id: 'flight.speed', gestureKey: 'commands.gesture.flightSpeed.keys', labelKey: 'commands.gesture.flightSpeed', category: 'camera' },
  { id: 'camera.panDrag', gestureKey: 'commands.gesture.panDrag.keys', labelKey: 'commands.gesture.panDrag', category: 'camera' },
  { id: 'camera.fineZoom', gestureKey: 'commands.gesture.fineZoom.keys', labelKey: 'commands.gesture.fineZoom', category: 'camera' },
];
