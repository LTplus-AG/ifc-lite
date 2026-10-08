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

function section(value: unknown, units: AuthoringUnits, at: string): ProfileSection {
  if (!record(value) || !PROFILE_KINDS.includes(value.Type as ProfileSectionType)) throw new Error(`${at}: Profile must state an existing native Type (${PROFILE_KINDS.join(', ')})`);
  const type = value.Type as ProfileSectionType;
  const required = PROFILE_FIELDS[type].map((field) => field.name);
  const express = getAttributeNamesAcrossSchemas(profileSectionIfcClass({ Type: type } as ProfileSection));
  const result: Record<string, string | number> = { Type: type };
  for (const [key, dimension] of Object.entries(value)) {
    if (key === 'Type') continue;
    if (!required.includes(key) && !(express.includes(key) && key.endsWith('FilletRadius'))) throw new Error(`${at}: unsupported native Profile dimension ${key}`);
    result[key] = parseLength(dimension, units, { min: required.includes(key) ? .000001 : 0, max: 10 }, `${at} Profile.${key}`);
  }
  const profile = result as unknown as ProfileSection;
  validateProfileSection(profileInMetres(profile, units), at);
  return profile;
}

/** Null means the existing rectangular contract applies. No polygon validation fork. */
export function parseShapeParams(p: Record<string, unknown>, ifcClass: string, units: AuthoringUnits, at: string): ShapeParams | null {
  if (p.Profile === undefined && p.OuterCurve === undefined) return null;
  if (p.Profile === 'polygon') {
    if (!['IfcSlab', 'IfcRoof', 'IfcPlate', 'IfcSpace'].includes(ifcClass)) throw new Error(`${at}: ${ifcClass} has no native polygon footprint`);
    if (p.width !== undefined || p.depth !== undefined) throw new Error(`${at}: polygon footprints cannot also specify rectangular width/depth`);
    if (!Array.isArray(p.OuterCurve) || p.OuterCurve.length < 3 || p.OuterCurve.length > AUTHORING_VERTEX_LIMIT) throw new Error(`${at}: OuterCurve needs 3–${AUTHORING_VERTEX_LIMIT} vertices; no vertices are silently discarded`);
    const OuterCurve = p.OuterCurve.map((point, i): [number, number] => {
      if (!Array.isArray(point) || point.length !== 2) throw new Error(`${at}: OuterCurve[${i}] must be [x,y] in ${units}`);
      return point.map((v, j) => parseLength(v, units, coordinate, `${at} OuterCurve[${i}][${j}]`)) as [number, number];
    });
    const position = p.position === undefined ? [0, 0, 0] as Point3 : parsePoint(p.position, units, coordinate, `${at} position`);
    return ifcClass === 'IfcSpace'
      ? { Profile: 'polygon', OuterCurve, position, height: parseLength(p.height, units, { min: .1, max: 200 }, `${at} height`) }
      : { Profile: 'polygon', OuterCurve, position, thickness: parseLength(p.thickness, units, { min: .01, max: 5 }, `${at} thickness`) };
  }
  if (!['IfcBeam', 'IfcColumn', 'IfcMember'].includes(ifcClass)) throw new Error(`${at}: ${ifcClass} has no native parameterised section`);
  if (p.width !== undefined || p.depth !== undefined || (ifcClass !== 'IfcColumn' && p.height !== undefined)) throw new Error(`${at}: Profile cannot also specify rectangular section dimensions`);
  const Profile = section(p.Profile, units, at);
  if (ifcClass === 'IfcColumn') return { Profile, position: parsePoint(p.position, units, coordinate, `${at} position`), height: parseLength(p.height, units, { min: .1, max: 200 }, `${at} height`) };
  const start = parsePoint(p.start, units, coordinate, `${at} start`), end = parsePoint(p.end, units, coordinate, `${at} end`);
  const factor = units === 'mm' ? .001 : 1;
  if (Math.hypot(...end.map((v, i) => v - start[i])) * factor < .05) throw new Error(`${at}: native axis must be at least 0.05 m long`);
  return { start, end, Profile };
}
