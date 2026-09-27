/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The 2D drafting fill palette (#5496), split out of `Drawing2DCanvas.tsx` so
 * the dark-paper analogue can sit next to the light one without growing that
 * module further (it is already at its `check-module-size.mjs` budget).
 *
 * `IFC_TYPE_FILL_COLORS` is the sanctioned drafting-convention exception to
 * the single colour pipeline (see `default_color_for_type` in
 * `ifc_lite_processing::style`, and AGENTS.md's "Colour and coordinate
 * resolution" note) and stays exactly as it was: every export
 * (`useDrawingExport.ts`) and the always-white sheet-mode paper both read it
 * unchanged via `getFillColorForType(ifcType)` with `dark` omitted, so
 * exported bytes cannot move.
 *
 * `IFC_TYPE_FILL_COLORS_DARK` is a new, second reading of the same
 * convention for the on-screen, non-sheet preview when the active theme's
 * paper is dark (`overlay-theme.ts`'s `dark.paper`, `#16161e`). The light
 * palette's near-white entries (windows, doors, space) would blow out
 * against that near-black paper, so this table keeps every element's
 * RELATIVE lightness (windows/doors lighter than structure, space lightest
 * of all) but compresses the whole range into the dark half, the same way a
 * CAD dark-mode drafting theme does. It is presentation-only: nothing here
 * reaches an export.
 */

export const IFC_TYPE_FILL_COLORS: Record<string, string> = {
  // Structural elements - solid gray
  IfcWall: '#b0b0b0',
  IfcWallStandardCase: '#b0b0b0',
  IfcColumn: '#909090',
  IfcBeam: '#909090',
  IfcSlab: '#c8c8c8',
  IfcRoof: '#d0d0d0',
  IfcFooting: '#808080',
  IfcPile: '#707070',

  // Windows/Doors - lighter
  IfcWindow: '#e8f4fc',
  IfcDoor: '#f5e6d3',

  // Stairs/Railings
  IfcStair: '#d8d8d8',
  IfcStairFlight: '#d8d8d8',
  IfcRailing: '#c0c0c0',

  // MEP - distinct colors
  IfcPipeSegment: '#a0d0ff',
  IfcDuctSegment: '#c0ffc0',

  // Furniture
  IfcFurnishingElement: '#ffe0c0',

  // Spaces (usually not shown in section)
  IfcSpace: '#f0f0f0',

  // Default
  default: '#d0d0d0',
};

/** Dark-paper analogue of {@link IFC_TYPE_FILL_COLORS} (#5496). Same keys, same
 *  relative lightness ordering, values compressed into the range that reads
 *  clearly against the dark theme's `#16161e` paper. */
export const IFC_TYPE_FILL_COLORS_DARK: Record<string, string> = {
  IfcWall: '#4b4f63',
  IfcWallStandardCase: '#4b4f63',
  IfcColumn: '#3f4356',
  IfcBeam: '#3f4356',
  IfcSlab: '#565a70',
  IfcRoof: '#5f6379',
  IfcFooting: '#33364a',
  IfcPile: '#282b3c',

  IfcWindow: '#2c3b52',
  IfcDoor: '#3a3226',

  IfcStair: '#50546a',
  IfcStairFlight: '#50546a',
  IfcRailing: '#454962',

  IfcPipeSegment: '#1f3c56',
  IfcDuctSegment: '#1f4a30',

  IfcFurnishingElement: '#4a3826',

  IfcSpace: '#26283a',

  default: '#3a3d52',
};

/**
 * `dark` selects {@link IFC_TYPE_FILL_COLORS_DARK} for the on-screen preview
 * against a dark paper; omitted (or `false`) is the original, export-facing
 * light palette. Every existing call site (both exports, and the sheet-mode
 * canvas path, which is always on white paper) calls this with one argument
 * and is therefore unaffected by the second one existing.
 */
export function getFillColorForType(ifcType: string, dark = false): string {
  const table = dark ? IFC_TYPE_FILL_COLORS_DARK : IFC_TYPE_FILL_COLORS;
  return table[ifcType] || table.default;
}
