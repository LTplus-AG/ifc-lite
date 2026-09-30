/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The cross-sections a beam, column or member can carry, as the Model
 * workspace offers them (charter #6232, D2): the picker's kinds, the fields
 * each kind needs, a sensible default size per kind, and the pure helpers
 * that turn one kind into another without ever producing a section the
 * builders would refuse (`validateProfileSection`).
 *
 * Sections are `ProfileSection`s of `@ifc-lite/create` (metres, centred on
 * their own origin). The rectangle is the picker's first kind but not a
 * `ProfileSection` here: a rectangle beam is still written through
 * `Width` x `Height` (a column's `Width` x `Depth`), so the defaults the
 * command bars and the inspector already edit stay the one source for it.
 */

import type { ProfileSection, ProfileSectionType } from '@ifc-lite/create';
import { validateProfileSection } from '@ifc-lite/create';
import type { TranslationKey } from '@/i18n';

/** The picker's kinds, in the order it lists them. */
export const PROFILE_KINDS = ['Rectangle', 'I', 'L', 'T', 'U', 'C', 'Circle', 'RectangleHollow', 'CircleHollow'] as const satisfies readonly ProfileSectionType[];

/** A dimension field of a kind: the IFC attribute it writes and its label. */
export interface ProfileField {
  readonly name: string;
  readonly labelKey: TranslationKey;
}

const f = (name: string, labelKey: TranslationKey): ProfileField => ({ name, labelKey });

const WIDTH = f('OverallWidth', 'profileSection.field.overallWidth');
const DEPTH = f('OverallDepth', 'profileSection.field.overallDepth');

/** The dimensions each kind asks for (the mandatory ones; fillet radii stay out of the picker). */
export const PROFILE_FIELDS: Readonly<Record<ProfileSectionType, readonly ProfileField[]>> = {
  Rectangle: [f('XDim', 'profileSection.field.width'), f('YDim', 'profileSection.field.height')],
  I: [WIDTH, DEPTH, f('WebThickness', 'profileSection.field.web'), f('FlangeThickness', 'profileSection.field.flange')],
  L: [f('Width', 'profileSection.field.width'), f('Depth', 'profileSection.field.depth'), f('Thickness', 'profileSection.field.thickness')],
  T: [f('FlangeWidth', 'profileSection.field.flangeWidth'), f('Depth', 'profileSection.field.depth'), f('WebThickness', 'profileSection.field.web'), f('FlangeThickness', 'profileSection.field.flange')],
  U: [f('FlangeWidth', 'profileSection.field.flangeWidth'), f('Depth', 'profileSection.field.depth'), f('WebThickness', 'profileSection.field.web'), f('FlangeThickness', 'profileSection.field.flange')],
  C: [f('Width', 'profileSection.field.width'), f('Depth', 'profileSection.field.depth'), f('WallThickness', 'profileSection.field.wall'), f('Girth', 'profileSection.field.girth')],
  Circle: [f('Radius', 'profileSection.field.radius')],
  RectangleHollow: [f('XDim', 'profileSection.field.width'), f('YDim', 'profileSection.field.height'), f('WallThickness', 'profileSection.field.wall')],
  CircleHollow: [f('Radius', 'profileSection.field.radius'), f('WallThickness', 'profileSection.field.wall')],
};

export const PROFILE_KIND_LABEL: Readonly<Record<ProfileSectionType, TranslationKey>> = {
  Rectangle: 'profileSection.kind.Rectangle',
  I: 'profileSection.kind.I',
  L: 'profileSection.kind.L',
  T: 'profileSection.kind.T',
  U: 'profileSection.kind.U',
  C: 'profileSection.kind.C',
  Circle: 'profileSection.kind.Circle',
  RectangleHollow: 'profileSection.kind.RectangleHollow',
  CircleHollow: 'profileSection.kind.CircleHollow',
};

/** Steel-scale defaults (an IPE 200-ish I, a 100 x 10 angle, a 100 x 100 x 8 tube, ...), metres. */
export const DEFAULT_SECTIONS: Readonly<Record<Exclude<ProfileSectionType, 'Rectangle'>, ProfileSection>> = {
  I: { Type: 'I', OverallWidth: 0.1, OverallDepth: 0.2, WebThickness: 0.0056, FlangeThickness: 0.0085 },
  L: { Type: 'L', Depth: 0.1, Width: 0.1, Thickness: 0.01 },
  T: { Type: 'T', Depth: 0.1, FlangeWidth: 0.1, WebThickness: 0.008, FlangeThickness: 0.01 },
  U: { Type: 'U', Depth: 0.2, FlangeWidth: 0.075, WebThickness: 0.006, FlangeThickness: 0.0115 },
  C: { Type: 'C', Depth: 0.15, Width: 0.065, WallThickness: 0.003, Girth: 0.02 },
  Circle: { Type: 'Circle', Radius: 0.1 },
  RectangleHollow: { Type: 'RectangleHollow', XDim: 0.1, YDim: 0.1, WallThickness: 0.008 },
  CircleHollow: { Type: 'CircleHollow', Radius: 0.06, WallThickness: 0.005 },
};

/** A section's dimension values by IFC attribute name. */
export function sectionDimensions(section: ProfileSection): Record<string, number> {
  const { Type: _type, ...dims } = section;
  return dims as Record<string, number>;
}

/** `type` with the given dimensions over its defaults; extra names are ignored. */
export function sectionOfType(type: Exclude<ProfileSectionType, 'Rectangle'>, dims: Readonly<Record<string, number>> = {}): ProfileSection {
  const base = DEFAULT_SECTIONS[type];
  const merged: Record<string, number | string> = { ...base };
  for (const { name } of PROFILE_FIELDS[type]) {
    const value = dims[name];
    if (typeof value === 'number' && Number.isFinite(value)) merged[name] = value;
  }
  return merged as unknown as ProfileSection;
}

/** The section with one dimension replaced. */
export function withDimension(section: ProfileSection, name: string, value: number): ProfileSection {
  return { ...section, [name]: value } as ProfileSection;
}

/** Why the builders would refuse `section`, or null when they take it. */
export function sectionProblem(section: ProfileSection): string | null {
  try {
    validateProfileSection(section, 'profile');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.replace(/^profile: /, '') : String(error);
  }
}

/**
 * The outer width and depth of `type`, as its dimensions name them: sets the
 * kind's own "width" and "depth" fields to `extent`, and pulls every wall,
 * web or flange in under a quarter of the smaller side so the result is
 * always a valid section.
 */
export function sectionWithExtent(
  type: Exclude<ProfileSectionType, 'Rectangle'>,
  extent: readonly [number, number],
  dims: Readonly<Record<string, number>> = {},
): ProfileSection {
  const [x, y] = extent;
  const small = Math.min(x, y);
  const sized: Record<string, number> = { ...dims };
  switch (type) {
    case 'I': sized.OverallWidth = x; sized.OverallDepth = y; break;
    case 'L': case 'C': sized.Width = x; sized.Depth = y; break;
    case 'T': case 'U': sized.FlangeWidth = x; sized.Depth = y; break;
    case 'RectangleHollow': sized.XDim = x; sized.YDim = y; break;
    case 'Circle': sized.Radius = small / 2; break;
    case 'CircleHollow': sized.Radius = small / 2; break;
  }
  const section = sectionOfType(type, sized);
  const values = sectionDimensions(section);
  const capped: Record<string, number> = { ...values };
  for (const { name } of PROFILE_FIELDS[type]) {
    if (/Thickness$/.test(name)) capped[name] = Math.min(values[name], (type === 'CircleHollow' ? small / 2 : small) * 0.25);
    if (name === 'Girth') capped[name] = Math.min(values[name], small * 0.4);
  }
  // A lip must stay deeper than the wall it is folded from.
  if (type === 'C' && capped.WallThickness >= capped.Girth) capped.WallThickness = capped.Girth / 2;
  return { Type: type, ...capped } as unknown as ProfileSection;
}
