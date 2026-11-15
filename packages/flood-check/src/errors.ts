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

/** The hazard service answered, but not with an image this package can read exactly. */
export class HazardResponseError extends FloodCheckError {}

/** The hazard service could not be reached, timed out, or answered with an HTTP error. */
export class HazardRequestError extends FloodCheckError {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** One opaque colour that matched no legend entry and is not an antialiasing blend of two entries. */
export interface UnexplainedColour {
  rgb: [number, number, number];
  pixels: number;
}

/**
 * The response contains opaque colours that match no legend entry in
 * significant numbers. The published style has changed, so no decoded class
 * can be trusted until the legend in this package is updated.
 */
export class HazardStyleChangedError extends FloodCheckError {
  constructor(
    message: string,
    readonly unexplainedPixels: number,
    readonly totalPixels: number,
    readonly colours: readonly UnexplainedColour[],
  ) {
    super(message);
  }
}

/** Why a model cannot be checked against a provider. Never guessed around. */
export type RefusalCode =
  | 'not-georeferenced'
  | 'geographic-crs'
  | 'crs-unrecognised'
  | 'crs-mismatch'
  | 'vertical-datum-mismatch'
  | 'vertical-datum-unrecognised'
  | 'georeference-implausible'
  | 'request-too-large'
  | 'ambiguous-map-scale'
  | 'outside-provider-extent'
  | 'no-candidates'
  | 'ambiguous-building'
  | 'world-coordinate-system';

/** The model and the data sources do not fit together; the check refuses instead of guessing. */
export class FloodCheckRefusal extends FloodCheckError {
  constructor(readonly code: RefusalCode, message: string) {
    super(message);
  }
}
