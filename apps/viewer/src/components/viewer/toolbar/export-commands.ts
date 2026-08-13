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
 * Out of scope: exports that belong to a panel rather than a toolbar (IDS
 * reports, BCF, clash BCF, list/schedule tables, compare reports, drawing
 * sheets). Those live in exactly one panel each and are opened the same way
 * from both toolbar styles, so they cannot drift.
 */

import type React from 'react';
import { ExportDialog } from '../ExportDialog';
import { GLBExportDialog } from '../GLBExportDialog';
import { KmzExportDialog } from '../KmzExportDialog';
import { EnergyModelExportDialog } from '../EnergyModelExportDialog';
import { UsdExportDialog } from '../UsdExportDialog';

/** The CSV tables the exporter can emit. */
export type CsvExportType = 'entities' | 'properties' | 'quantities' | 'spatial';

/** Every export dialog takes the calling toolbar's own element as its trigger. */
export type ExportDialogComponent = React.ComponentType<{ trigger?: React.ReactNode }>;

interface ExportCommandBase {
  /** Stable id — also the `data-export-command` attribute both styles render. */
  readonly id: string;
  /** Short label: ribbon buttons, where the icon carries most of the meaning. */
  readonly label: string;
  /** Long label: classic dropdown rows, which have only text to go on. */
  readonly menuLabel: string;
  /** Tooltip / accessible name. */
  readonly tooltip: string;
  /**
   * What has to be loaded first. `model` means any loaded model (federated or
   * legacy single-result); `dataStore` means a parsed entity store.
   */
  readonly requires: 'model' | 'dataStore';
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
    readonly label: string;
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
    label: 'IFC',
    menuLabel: 'Export IFC (with changes)',
    tooltip: 'Export IFC (with changes)',
    requires: 'model',
    group: 0,
    emphasis: 'large',
  },
  {
    id: 'glb',
    kind: 'dialog',
    Dialog: GLBExportDialog,
    label: 'GLB',
    menuLabel: 'Export GLB (3D Model)',
    tooltip: 'Export GLB (3D model)',
    requires: 'model',
    group: 1,
    emphasis: 'small',
  },
  {
    id: 'kmz',
    kind: 'dialog',
    Dialog: KmzExportDialog,
    label: 'KMZ',
    menuLabel: 'Export KMZ (Google Earth Pro)',
    tooltip: 'Export KMZ (Google Earth Pro)',
    requires: 'model',
    group: 1,
    emphasis: 'small',
  },
  {
    id: 'usd',
    kind: 'dialog',
    Dialog: UsdExportDialog,
    label: 'USD',
    menuLabel: 'Export USD (OpenUSD)',
    tooltip: 'Export USD (OpenUSD .usda)',
    requires: 'model',
    group: 2,
    emphasis: 'small',
  },
  {
    id: 'energy',
    kind: 'dialog',
    Dialog: EnergyModelExportDialog,
    label: 'Energy',
    menuLabel: 'Energy Model (HBJSON / DFJSON)',
    tooltip: 'Export energy model (HBJSON / DFJSON)',
    requires: 'model',
    group: 2,
    emphasis: 'small',
  },
  {
    id: 'csv',
    kind: 'table-menu',
    label: 'CSV',
    menuLabel: 'Export CSV',
    tooltip: 'Export CSV tables',
    requires: 'dataStore',
    group: 3,
    emphasis: 'small',
    items: [
      { type: 'entities', label: 'Entities', separatorBefore: false },
      { type: 'properties', label: 'Properties', separatorBefore: false },
      { type: 'quantities', label: 'Quantities', separatorBefore: false },
      { type: 'spatial', label: 'Spatial Hierarchy', separatorBefore: true },
    ],
  },
  {
    id: 'json',
    kind: 'action',
    action: 'json',
    label: 'JSON',
    menuLabel: 'Export JSON (All Data)',
    tooltip: 'Export JSON (all data)',
    requires: 'dataStore',
    group: 3,
    emphasis: 'small',
  },
  {
    id: 'screenshot',
    kind: 'action',
    action: 'screenshot',
    label: 'Screenshot',
    menuLabel: 'Screenshot',
    tooltip: 'Save viewport as PNG',
    requires: 'model',
    group: 3,
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

/** An icon per export command, supplied by each toolbar style in its own set. */
export type ExportIconSet = Record<ExportCommandId, React.ElementType>;

/** Split a registry-ordered list into its visual groups, preserving order. */
export function groupExportCommands<T>(items: readonly T[], groupOf: (item: T) => number): T[][] {
  const groups: T[][] = [];
  let current: number | null = null;
  for (const item of items) {
    const group = groupOf(item);
    if (group !== current) {
      groups.push([]);
      current = group;
    }
    groups[groups.length - 1].push(item);
  }
  return groups;
}
