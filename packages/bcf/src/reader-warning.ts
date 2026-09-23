/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type ReportWarning = (message: string, error?: unknown) => void;

export function createWarningReporter(onWarning?: (message: string, kind: 'skipped' | 'version') => void): ReportWarning {
  return (message, error) => {
    if (error === undefined) console.warn(message);
    else console.warn(message, error);
    onWarning?.(message, 'skipped');
  };
}

export function reportVersionWarning(message: string, onWarning?: (message: string, kind: 'skipped' | 'version') => void): void {
  console.warn(message);
  onWarning?.(message, 'version');
}
