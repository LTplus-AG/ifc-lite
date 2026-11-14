/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Thrown when Dalux's bookmark pagination looks broken in a way that can't
 * be reconciled with "the listing is simply done": a `nextPage` link with no
 * bookmark, or a bookmark that repeats while the page carrying it still has
 * items on it (see {@link fetchPage}). Callers must not treat this as "no
 * more data": it means the listing is truncated and the caller should say
 * so, not report a clean success with fewer rows than actually exist
 * upstream. */
export class DaluxPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaluxPaginationError';
  }
}

/** Thrown for a non-2xx Dalux API response. Carries the actual HTTP status
 * so callers that need to branch on it (auth-failure detection in
 * `testConnection`, for one) match on `status` rather than on substrings of
 * the interpolated error message — a truncated upstream body can contain
 * digits that happen to look like a status code without being one. */
export class DaluxHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DaluxHttpError';
  }
}
