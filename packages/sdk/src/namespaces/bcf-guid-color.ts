/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GUID and color utility methods for `bim.bcf`.
 *
 * Moved out of `bcf.ts` to keep it under the module-size ratchet
 * (`scripts/check-module-size.mjs`): these eight methods are thin,
 * self-contained passthroughs with no dependency on the rest of the
 * namespace. `BCFNamespace` extends this base class, so the public surface
 * of `bim.bcf` is unchanged (no declaration merging or prototype patching —
 * `typescript/no-unsafe-declaration-merging`).
 */

import { loadBCF, type AnyFn } from './bcf-load.js';

export class BCFGuidColorBase {
  async generateIfcGuid(): Promise<string> {
    const mod = await loadBCF();
    return (mod.generateIfcGuid as () => string)();
  }

  async generateUuid(): Promise<string> {
    const mod = await loadBCF();
    return (mod.generateUuid as () => string)();
  }

  async uuidToIfcGuid(uuid: string): Promise<string> {
    const mod = await loadBCF();
    return (mod.uuidToIfcGuid as (u: string) => string)(uuid);
  }

  async ifcGuidToUuid(guid: string): Promise<string> {
    const mod = await loadBCF();
    return (mod.ifcGuidToUuid as (g: string) => string)(guid);
  }

  async isValidIfcGuid(guid: string): Promise<boolean> {
    const mod = await loadBCF();
    return (mod.isValidIfcGuid as (g: string) => boolean)(guid);
  }

  async isValidUuid(uuid: string): Promise<boolean> {
    const mod = await loadBCF();
    return (mod.isValidUuid as (u: string) => boolean)(uuid);
  }

  async parseARGBColor(argb: string): Promise<{ r: number; g: number; b: number; a: number }> {
    const mod = await loadBCF();
    return (mod.parseARGBColor as AnyFn)(argb) as { r: number; g: number; b: number; a: number };
  }

  async toARGBColor(r: number, g: number, b: number, a?: number): Promise<string> {
    const mod = await loadBCF();
    return (mod.toARGBColor as AnyFn)(r, g, b, a) as string;
  }
}
