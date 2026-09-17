/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Types for the build-time helper, so the test program can import it under
 * `allowJs: false` without an `@ts-ignore`.
 */
export type TargetKind = 'file' | 'directory' | 'missing';
export type TargetVerdict = 'shipped' | 'outside-dist' | 'not-a-file' | 'missing';

export declare const relativeUrlSpecifier: () => RegExp;
export declare const relativeTsUrlSpecifier: () => RegExp;

export declare function classifyTarget(args: {
  distRoot: string;
  fileDir: string;
  specifier: string;
  inspect: (absolutePath: string) => TargetKind;
}): TargetVerdict;

export declare const REASONS: Record<string, string>;
