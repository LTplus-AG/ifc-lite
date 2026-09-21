/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Resolve proj4's native projected unit to metres. */
export function projectedUnitToMetres(definition: string): number | null {
  const explicit = /(?:^|\s)\+to_meter=([^\s]+)/i.exec(definition)?.[1];
  if (explicit) {
    const ratio = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(explicit);
    const value = ratio ? Number(ratio[1]) / Number(ratio[2]) : Number(explicit);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const unit = /(?:^|\s)\+units=([^\s]+)/i.exec(definition)?.[1]?.toLowerCase();
  switch (unit) {
    case undefined:
    case 'm': return 1;
    case 'ft': return 0.3048;
    case 'us-ft': return 1200 / 3937;
    case 'km': return 1000;
    default: return null;
  }
}
