/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GUID and color utility methods for `bim.bcf`, mixed into `BCFNamespace`.
 *
 * Moved out of `bcf.ts` to keep it under the module-size ratchet
 * (`scripts/check-module-size.mjs`): these eight methods are thin,
 * self-contained passthroughs with no dependency on the rest of the
 * namespace, so lifting them into their own file plus a
 * declaration-merged `Object.assign` mixin (applied in `bcf.ts`) needed no
 * behavior change — see #4294, which needed one more required parameter on
 * `cameraToOrthogonal` and pushed the file over budget.
 */

import { loadBCF, type AnyFn } from './bcf-load.js';

export interface BCFGuidColorMixin {
  /** Generate a new IFC GUID (22-char base64). */
  generateIfcGuid(): Promise<string>;
  /** Generate a new UUID (36-char). */
  generateUuid(): Promise<string>;
  /** Convert UUID to IFC GUID. */
  uuidToIfcGuid(uuid: string): Promise<string>;
  /** Convert IFC GUID to UUID. */
  ifcGuidToUuid(guid: string): Promise<string>;
  /** Validate whether a string is a valid IFC GUID. */
  isValidIfcGuid(guid: string): Promise<boolean>;
  /** Validate whether a string is a valid UUID. */
  isValidUuid(uuid: string): Promise<boolean>;
  /** Parse ARGB hex color string (BCF format) to RGBA values. */
  parseARGBColor(argb: string): Promise<{ r: number; g: number; b: number; a: number }>;
  /** Create ARGB hex color string (BCF format) from RGBA values. */
  toARGBColor(r: number, g: number, b: number, a?: number): Promise<string>;
}

export const bcfGuidColorMethods: BCFGuidColorMixin = {
  async generateIfcGuid(): Promise<string> {
    const mod = await loadBCF();
    return (mod.generateIfcGuid as () => string)();
  },

  async generateUuid(): Promise<string> {
    const mod = await loadBCF();
    return (mod.generateUuid as () => string)();
  },

  async uuidToIfcGuid(uuid: string): Promise<string> {
    const mod = await loadBCF();
    return (mod.uuidToIfcGuid as (u: string) => string)(uuid);
  },

  async ifcGuidToUuid(guid: string): Promise<string> {
    const mod = await loadBCF();
    return (mod.ifcGuidToUuid as (g: string) => string)(guid);
  },

  async isValidIfcGuid(guid: string): Promise<boolean> {
    const mod = await loadBCF();
    return (mod.isValidIfcGuid as (g: string) => boolean)(guid);
  },

  async isValidUuid(uuid: string): Promise<boolean> {
    const mod = await loadBCF();
    return (mod.isValidUuid as (u: string) => boolean)(uuid);
  },

  async parseARGBColor(argb: string): Promise<{ r: number; g: number; b: number; a: number }> {
    const mod = await loadBCF();
    return (mod.parseARGBColor as AnyFn)(argb) as { r: number; g: number; b: number; a: number };
  },

  async toARGBColor(r: number, g: number, b: number, a?: number): Promise<string> {
    const mod = await loadBCF();
    return (mod.toARGBColor as AnyFn)(r, g, b, a) as string;
  },
};
