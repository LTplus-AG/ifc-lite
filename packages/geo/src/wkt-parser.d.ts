/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** proj4's WKT/PROJJSON reader; ships without type declarations. */
declare module 'wkt-parser' {
  export default function parseWkt(wkt: string | object): Record<string, unknown>;
}
