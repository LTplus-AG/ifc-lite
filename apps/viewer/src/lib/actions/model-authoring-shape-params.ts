/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7215: input bounds/conversion; geometric authorability stays with native builders. */
import { profileSectionIfcClass, validateProfileSection, type ProfileSection, type ProfileSectionType } from '@ifc-lite/create';
import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';
import { PROFILE_FIELDS, PROFILE_KINDS } from '@/lib/profile-section/profile-kinds';
import { parseLength, parsePoint, record } from './model-authoring-fields';
import type { AuthoringUnits, Point3 } from './model-authoring';

export interface PolygonParams { Profile: 'polygon'; OuterCurve: Array<[number, number]>; position: Point3; thickness?: number; height?: number }
export interface ProfileAxisParams { start: Point3; end: Point3; Profile: ProfileSection }
export interface ProfileColumnParams { position: Point3; height: number; Profile: ProfileSection }
export type ShapeParams = PolygonParams | ProfileAxisParams | ProfileColumnParams;
export const AUTHORING_VERTEX_LIMIT = 256;
/** Aggregate bound on polygon pair/triangulation work; nothing is silently omitted. */
export const AUTHORING_OUTLINE_WORK_LIMIT = 262_144;
const coordinate = { min: -10_000, max: 10_000, signed: true };

export function profileInMetres(profile: ProfileSection, units: AuthoringUnits): ProfileSection {
  return Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, key === 'Type' ? value : units === 'mm' ? Number(value) / 1000 : value])) as unknown as ProfileSection;
}

export function parseProfileSectionParams(value: unknown, units: AuthoringUnits, at: string): ProfileSection {
