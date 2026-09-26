/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export command registry — the single source of truth for which formats the
 * viewer's toolbars can export.
 *
 * The viewer ships two toolbar styles: the classic `MainToolbar` strip and the
 * tabbed `RibbonToolbar`. Both render their Export cluster by mapping over
 * `EXPORT_COMMANDS`, so a format can never be reachable in one style and
 * missing in the other — there is one list, one order, one gating rule.
 *
 * Adding a format = adding one entry here. `ExportCommandId` is derived from
 * the array, so every `Record<ExportCommandId, …>` — notably each toolbar
 * style's icon map — stops compiling until that style has been taught the new
 * format. `export-ui-parity.test.tsx` then checks at runtime that both styles
 * actually render every id, and that neither hand-rolls an entry beside it.
 *
 * Extension-contributed exporters are the registry's runtime half: they are
 * not known until an extension installs them, so `useExportCommands` resolves
 * them from the `exportMenu` slot (`useExtensionExporters`) and every surface
 * renders them after the built-in groups (#5838).
 *
 * Out of scope: exports that belong to a panel rather than a toolbar (IDS
 * reports, BCF, clash BCF, list/schedule tables, compare reports, drawing
 * sheets). Those live in exactly one panel each and are opened the same way
 * from both toolbar styles, so they cannot drift.
 */

import type React from 'react';
import type { TranslationKey } from '@/i18n';
import type { UiSurface } from '@/lib/analytics-ui-events';
import { ExportDialog } from '../ExportDialog';
import { ExportChangesButton } from '../ExportChangesButton';
import { AnonymizedExportDialog } from '../anonymized-export/AnonymizedExportDialog';
import { GLBExportDialog } from '../GLBExportDialog';
import { KmzExportDialog } from '../KmzExportDialog';
import { EnergyModelExportDialog } from '../EnergyModelExportDialog';
import { UsdExportDialog } from '../UsdExportDialog';
import { PdfViewExportDialog } from '../PdfViewExportDialog';

/** The CSV tables the exporter can emit. */
export type CsvExportType = 'entities' | 'properties' | 'quantities' | 'spatial';

/** Every export dialog takes the calling toolbar's own element as its trigger. */
export type ExportDialogComponent = React.ComponentType<{ trigger?: React.ReactNode; surface: UiSurface }>;

interface ExportCommandBase {
  /** Stable id — also the `data-export-command` attribute both styles render. */
  readonly id: string;
  /**
   * Translation keys, not text — this registry has no React import, so it
   * cannot call `t()` itself (`shared-commands.en.ts` holds the English).
   * Renderers call `t(command.labelKey)` etc; see `AXIS_INFO` in
   * `sectionConstants.ts` for the same pattern.
   *
   * Short label: ribbon buttons, where the icon carries most of the meaning.
   */
  readonly labelKey: TranslationKey;
  /** Long label: classic dropdown rows, which have only text to go on. */
  readonly menuLabelKey: TranslationKey;
  /** Tooltip / accessible name. */
  readonly tooltipKey: TranslationKey;
  /**
   * What has to be loaded first. `model` means any loaded model (federated or
   * legacy single-result); `dataStore` means a parsed entity store; `changes`
   * means at least one model has unexported edits.
   */
  readonly requires: 'model' | 'dataStore' | 'changes';
  /**
   * Visual cluster. Consecutive commands sharing a group render as one small
   * button stack in the ribbon and one separator-delimited block in the
   * classic menu. Keep a group at three commands or fewer — that is the
   * ribbon stack's height.
   */
  readonly group: number;
  /**
   * `large` marks the headline command of the Export cluster — the ribbon
   * draws it as a big button; everything else is a small stacked row.
   */
  readonly emphasis: 'large' | 'small';
}

/** A format whose options live in a dialog (the dialog owns the download). */
export interface ExportDialogCommand extends ExportCommandBase {
  readonly kind: 'dialog';
  readonly Dialog: ExportDialogComponent;
}

/** A one-click export handled by `useExportCommands`. */
export interface ExportActionCommand extends ExportCommandBase {
  readonly kind: 'action';
  readonly action: 'json' | 'screenshot';
}

/** A format offered as a menu of tables (CSV). */
export interface ExportTableMenuCommand extends ExportCommandBase {
  readonly kind: 'table-menu';
  readonly items: readonly {
    readonly type: CsvExportType;
    readonly labelKey: TranslationKey;
    /** Draw a separator above this row. */
    readonly separatorBefore: boolean;
  }[];
}

export type ExportCommand =
  | ExportDialogCommand
  | ExportActionCommand
  | ExportTableMenuCommand;

/**
 * The registry. Order and grouping here are the order and grouping the user
 * sees in *both* toolbar styles.
 */
export const EXPORT_COMMANDS = [
  {
    id: 'ifc',
    kind: 'dialog',
    Dialog: ExportDialog,
    labelKey: 'exportCommands.ifc.label',
    menuLabelKey: 'exportCommands.ifc.menuLabel',
    tooltipKey: 'exportCommands.ifc.tooltip',
    requires: 'model',
    group: 0,
    emphasis: 'large',
  },
  {
    // Own group (a fractional number between 'ifc' and 'glb' — group numbers
    // only need to differ from their neighbours, not be sequential integers):
    // sharing group 0 with 'ifc' would put the ribbon's headline `large`
    // button inside the same small-button stack as this `small` one (the
    // group-of-1-large special case in `RibbonExportGroup` no longer
    // applies once the group has two members).
    id: 'anonymized',
    kind: 'dialog',
    Dialog: AnonymizedExportDialog,
    labelKey: 'exportCommands.anonymized.label',
    menuLabelKey: 'exportCommands.anonymized.menuLabel',
    tooltipKey: 'exportCommands.anonymized.tooltip',
    requires: 'model',
    group: 0.5,
    emphasis: 'small',
  },
  {
    // Every model with unexported edits, edits applied, after a review. The
    // amber toolbar button stays as the standing "you have edits" prompt; this
    // entry is the same dialog reached from the menus and the palette.
    id: 'modified-ifc',
    kind: 'dialog',
    Dialog: ExportChangesButton,
    labelKey: 'exportCommands.modifiedIfc.label',
    menuLabelKey: 'exportCommands.modifiedIfc.menuLabel',
    tooltipKey: 'exportCommands.modifiedIfc.tooltip',
    requires: 'changes',
    group: 0.5,
    emphasis: 'small',
  },
  {
    id: 'glb',
    kind: 'dialog',
    Dialog: GLBExportDialog,
    labelKey: 'exportCommands.glb.label',
    menuLabelKey: 'exportCommands.glb.menuLabel',
    tooltipKey: 'exportCommands.glb.tooltip',
    requires: 'model',
    group: 1,
    emphasis: 'small',
  },
  {
    id: 'kmz',
    kind: 'dialog',
    Dialog: KmzExportDialog,
    labelKey: 'exportCommands.kmz.label',
    menuLabelKey: 'exportCommands.kmz.menuLabel',
    tooltipKey: 'exportCommands.kmz.tooltip',
    requires: 'model',
    group: 1,
    emphasis: 'small',
  },
  {
    id: 'usd',
    kind: 'dialog',
    Dialog: UsdExportDialog,
    labelKey: 'exportCommands.usd.label',
    menuLabelKey: 'exportCommands.usd.menuLabel',
    tooltipKey: 'exportCommands.usd.tooltip',
    requires: 'model',
    group: 2,
    emphasis: 'small',
  },
  {
    id: 'energy',
    kind: 'dialog',
    Dialog: EnergyModelExportDialog,
    labelKey: 'exportCommands.energy.label',
    menuLabelKey: 'exportCommands.energy.menuLabel',
    tooltipKey: 'exportCommands.energy.tooltip',
    requires: 'model',
    group: 2,
    emphasis: 'small',
  },
  {
    id: 'csv',
    kind: 'table-menu',
    labelKey: 'exportCommands.csv.label',
    menuLabelKey: 'exportCommands.csv.menuLabel',
    tooltipKey: 'exportCommands.csv.tooltip',
    requires: 'dataStore',
    group: 3,
    emphasis: 'small',
    items: [
      { type: 'entities', labelKey: 'exportCommands.csv.item.entities', separatorBefore: false },
      { type: 'properties', labelKey: 'exportCommands.csv.item.properties', separatorBefore: false },
      { type: 'quantities', labelKey: 'exportCommands.csv.item.quantities', separatorBefore: false },
      { type: 'spatial', labelKey: 'exportCommands.csv.item.spatial', separatorBefore: true },
    ],
  },
  {
    id: 'json',
    kind: 'action',
    action: 'json',
    labelKey: 'exportCommands.json.label',
    menuLabelKey: 'exportCommands.json.menuLabel',
    tooltipKey: 'exportCommands.json.tooltip',
    requires: 'dataStore',
    group: 3,
    emphasis: 'small',
  },
  {
    id: 'screenshot',
    kind: 'action',
    action: 'screenshot',
    labelKey: 'exportCommands.screenshot.label',
    menuLabelKey: 'exportCommands.screenshot.menuLabel',
    tooltipKey: 'exportCommands.screenshot.tooltip',
    requires: 'model',
    group: 3,
    emphasis: 'small',
  },
  {
    // Its own group: group 3 is already at the three-command ceiling the ribbon
    // stack allows, and this is a drawing output rather than a data table.
    id: 'pdf',
    kind: 'dialog',
    Dialog: PdfViewExportDialog,
    labelKey: 'exportCommands.pdf.label',
    menuLabelKey: 'exportCommands.pdf.menuLabel',
    tooltipKey: 'exportCommands.pdf.tooltip',
    requires: 'model',
    group: 4,
    emphasis: 'small',
  },
] as const satisfies readonly ExportCommand[];

/**
 * Derived from the registry, so a new entry immediately widens the union and
 * every exhaustive `Record<ExportCommandId, …>` in the codebase goes red.
 */
export type ExportCommandId = (typeof EXPORT_COMMANDS)[number]['id'];

/**
 * A concrete registry entry (literal types preserved), which is what the
 * toolbar renderers switch on.
 */
export type RegisteredExportCommand = (typeof EXPORT_COMMANDS)[number];

/** Registry ids in registry order. */
export const EXPORT_COMMAND_IDS: readonly ExportCommandId[] = EXPORT_COMMANDS.map((c) => c.id);

/**
 * An icon per export command, supplied by each toolbar style in its own set,
 * plus the one icon every extension-contributed exporter row shares.
 */
export type ExportIconSet = Record<ExportCommandId | 'extension', React.ElementType>;

/** Split a registry-ordered list into its visual groups, preserving order. */
export function groupExportCommands<T>(items: readonly T[], groupOf: (item: T, index: number) => number): T[][] {
  const groups: T[][] = [];
  let current: number | null = null;
  for (const [index, item] of items.entries()) {
    const group = groupOf(item, index);
    if (group !== current) {
      groups.push([]);
      current = group;
    }
    groups[groups.length - 1].push(item);
  }
  return groups;
}
