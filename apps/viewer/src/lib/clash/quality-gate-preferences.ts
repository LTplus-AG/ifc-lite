/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { create } from 'zustand';
import { optionalLocalStorage, preserveUnreadableEntry } from '../storage/unreadable-entry';
import { defaultQualityGateConfig, isQualityGateConfig, type QualityGateConfig } from './quality-gate';

const KEY = 'ifc-lite-clash-quality-gates';
let writable = true;
export function loadQualityGateConfig(): QualityGateConfig {
  const storage = optionalLocalStorage();
  try {
    const raw = storage?.getItem(KEY);
    if (raw === null || raw === undefined) {
      writable = true;
      return defaultQualityGateConfig();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isQualityGateConfig(parsed)) throw new Error('Invalid quality gate thresholds');
    writable = true;
    return parsed;
  } catch (error) {
    writable = preserveUnreadableEntry(storage, KEY, error);
    return defaultQualityGateConfig();
  }
}
export const useQualityGatePreferences = create<{
  config: QualityGateConfig;
  save: (config: QualityGateConfig) => boolean;
}>((set) => ({
  config: loadQualityGateConfig(),
  save: (config) => {
    if (!writable || !isQualityGateConfig(config)) return false;
    try {
      const storage = optionalLocalStorage();
      if (!storage) return false;
      storage.setItem(KEY, JSON.stringify(config));
      set({ config: structuredClone(config) });
      return true;
    } catch (error) {
      console.warn('[clash] Quality gate preferences could not be saved', error);
      return false;
    }
  },
}));
