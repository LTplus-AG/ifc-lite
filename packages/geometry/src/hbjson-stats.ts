/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage stats for an HBJSON export, mirroring the Rust
 * `ifc_lite_export::HbjsonStats` (`#[serde(rename_all = "camelCase")]`) that crosses
 * the wasm boundary via `exportHbjsonWithStats`. Lets a caller tell whether a
 * "successful" export silently dropped `IfcSpace` volumes instead of reporting them.
 *
 * Split into its own module (rather than `types.ts`) purely to keep `types.ts` under
 * the module-size ratchet — this type has no other relationship to that file.
 */
export interface HbjsonStats {
  /** `IfcSpace` profiles seen in the model. */
  spaces: number;
  /** Rooms emitted (watertight prisms). */
  rooms: number;
  /** Spaces skipped as degenerate (malformed footprint / holes / non-extrusion). */
  skipped: number;
  /** Windows placed as Apertures on exterior wall faces. */
  apertures: number;
  /** Doors placed on exterior wall faces. */
  doors: number;
  /** Railing / context shade meshes emitted. */
  shades: number;
  /** Opaque constructions derived from the IFC material layer sets. */
  constructions: number;
  /** Interior faces paired as `Surface` adjacencies (2 per shared wall). */
  interiorAdjacencies: number;
}
