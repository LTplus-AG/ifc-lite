/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IdentityLimits, SampleConfig, SampleResult } from './interleaved-types.js';
export const LIMITS: Readonly<IdentityLimits>;
export const FIXTURES: ReadonlyArray<{ family: string; path: string; timeoutMs: number }>;
export function immutableRef(value: unknown): string;
export function schedule(): Array<Pick<SampleConfig, 'id' | 'family' | 'path' | 'kind' | 'pair' | 'slot' | 'arm' | 'timeoutMs'>>;
export function requireIdentityPair(a: SampleResult, b: SampleResult): void;
export function describeFamily(rows: SampleResult[]): Record<string, { available: boolean; pairedPercent?: number[]; medianPercent?: number; rangePercent?: number[] }>;
