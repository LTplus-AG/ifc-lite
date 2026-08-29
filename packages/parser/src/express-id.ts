/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The express-id representation contract (#3395).
 *
 * ISO 10303-21 writes an instance name as `"#" digit {digit}` with no upper
 * bound, so a file MAY legally declare `#4294967297`. Nothing in this toolkit
 * can hold one: every store that keys on an express id narrows it to 32 bits —
 * `CompactEntityIndex` (this package), `EntityTableBuilder.expressId`,
 * `PropertyTable.entityId`, `QuantityTable.entityId` and the relationship graph
 * (`@ifc-lite/data`), the data-store transport columns, the wasm boundary
 * (`express_ids: Uint32Array`), and the Rust side (`ColumnarIndex { ids:
 * Vec<u32> }`, `MeshData::express_id: u32`).
 *
 * Admitting an id the storage cannot represent does not defer the failure, it
 * disguises it: a `Uint32Array` store truncates mod 2^32, so `#4294967297`
 * lands on key `1` and serves entity `#1`'s byte range and type. Refusing the
 * record at the parse boundary is the only outcome the layers below can keep,
 * and the refusal is counted and reported (see `StepTokenizer.oversizedIdCount`
 * and `EntityScanResult.oversizedIdCount`) rather than silently dropped.
 *
 * The bound is inclusive: `#4294967295` is `u32::MAX` and loads normally.
 */
export const MAX_EXPRESS_ID = 0xffff_ffff;

/**
 * Whether `id` can be stored in this toolkit's 32-bit express-id columns.
 *
 * `Number.isSafeInteger` still matters below the bound: a digit run is
 * accumulated as a double, so an id past 2^53 is not merely large, it is
 * *wrong* — two distinct ids accumulate to the same value. The `<=` bound then
 * refuses everything the u32 stores would truncate. Negative values are
 * refused for the same reason: `new Uint32Array(1)[0] = -1` reads back as
 * 4294967295.
 */
export function isIndexableExpressId(id: number): boolean {
  return Number.isSafeInteger(id) && id >= 0 && id <= MAX_EXPRESS_ID;
}

/**
 * `id` itself when the 32-bit columns can hold it, otherwise a `RangeError`
 * naming it (#3395).
 *
 * It returns the id rather than asserting so the check sits *inside* the
 * narrowing expression — `expressIds[i] = checkedExpressId(ref.expressId)`
 * cannot drift away from the store it guards the way a preceding statement
 * can. ifc-lite's own scans already refuse these ids at the parse boundary, so
 * this only fires for a caller that assembled refs some other way, and it
 * fires where that mistake is instead of at a lookup three layers away that
 * silently reads a different entity.
 */
export function checkedExpressId(id: number): number {
  if (!isIndexableExpressId(id)) {
    throw new RangeError(
      `express id ${id} cannot be stored: ids must be integers in [0, ${MAX_EXPRESS_ID}] (#3395)`,
    );
  }
  return id;
}
