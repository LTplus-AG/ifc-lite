/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export class ReportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireCondition(
  value: unknown,
  status: number,
  code: string,
  message: string,
): asserts value {
  if (!value) throw new ReportError(status, code, message);
}
