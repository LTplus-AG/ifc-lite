/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The cross-section a Beam, Member or Column command builds with (charter
 * #6232, D2): the picked section (I, L, T, U, C, circle, hollow) or, for the
 * rectangle, the class's Width x Height (Width x Depth for a column). One
 * reading of the defaults for the typed fields, the ghost and the commit, so
 * the preview is the section that gets written.
 */

import { profileSectionExtent, type ProfileSection } from '@ifc-lite/create';
import { authoringSection, type ProfileOwner } from '@/store/slices/authoringDefaultsSlice';
import { sectionGhostMesh, type SectionFrame } from '@/lib/profile-section/profile-outline';
import { commandGhostId } from '../ghost.js';
import type { CommandContext, CommandField } from '../types.js';
import { dimOf } from './placement-shared.js';

type Reader = Pick<CommandContext, 'get'>;

/** The picked section of `owner`, or null for the rectangle. */
export const sectionOf = (ctx: Reader, owner: ProfileOwner): ProfileSection | null => authoringSection(ctx.get().authoringDefaults, owner);

/**
 * The outer size `[across, up]` of what `owner` builds: a beam's or member's
 * Width x Height, a column's Width x Depth, or the picked section's extent.
 */
export function sectionExtentOf(ctx: Reader, owner: ProfileOwner): [number, number] {
  const section = sectionOf(ctx, owner);
  if (section) return profileSectionExtent(section);
  return [dimOf(ctx, owner, 'Width'), dimOf(ctx, owner, owner === 'column' ? 'Depth' : 'Height')];
}

/** A rectangle's own dimension field goes away once a section is picked: the picker's fields replace it. */
export function rectangleOnly<G>(field: CommandField<G>, owner: (ctx: CommandContext) => ProfileOwner): CommandField<G> {
  return { ...field, hidden: (_g, ctx) => sectionOf(ctx, owner(ctx)) !== null };
}

/** The ghost of `section` on the workplane, swept as the builder writes it. */
export function sectionGhost(ctx: CommandContext, section: ProfileSection, frame: SectionFrame) {
  return ctx.workplane ? sectionGhostMesh(ctx.workplane, section, frame, commandGhostId(ctx.get())) : null;
}
