/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { TestContext } from 'node:test';
export interface NativeCpuIdentity { pid: number; created: string }
export interface NativeCpuRoot extends NativeCpuIdentity { profile: string; port: number }
export interface NativeCpuObservation { pid: number; started: string | null; state: 'live' | 'exited' | 'notFound' }
export interface WindowsCpuFixture {
  dir: string; win: string; exe: string; executable: string; commandLine: string; identityPrelude: string;
  roots(): NativeCpuRoot[];
  observeExact(identity: NativeCpuIdentity): NativeCpuObservation;
  terminateExact(identity: NativeCpuIdentity, deadlineMs?: number): NativeCpuObservation;
}
export function literal(value: string): string;
export function windowsPath(path: string): string;
export function powershell(script: string, timeout?: number, receiptPath?: string): string;
export function createWindowsCpuFixture(mode?: 'no-endpoint' | 'endpoint' | 'controller-orphan' | 'profile-orphan', directory?: string, context?: TestContext): WindowsCpuFixture;
export function retainCpuFixture(context: TestContext, dir: string, metadata: Record<string, unknown>): void;
export function windowsCpuUnavailable(): false | string;
