/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Base class of every error this package throws on purpose. */
export class FloodCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Why a model cannot be read for the check (more codes follow with the check itself). Never guessed around. */
export type RefusalCode =
  | 'not-georeferenced'
  | 'geographic-crs'
  | 'crs-unrecognised'
  | 'crs-mismatch'
  | 'georeference-implausible'
  | 'ambiguous-map-scale'
  | 'ambiguous-building'
  | 'world-coordinate-system';

/** The model and the data sources do not fit together; the check refuses instead of guessing. */
export class FloodCheckRefusal extends FloodCheckError {
  constructor(readonly code: RefusalCode, message: string) {
    super(message);
  }
}
