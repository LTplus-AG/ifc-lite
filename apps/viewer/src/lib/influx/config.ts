/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { containsInfluxToken, type InfluxSelection } from '@ifc-lite/flow-nodes/influx';

export const INFLUX_CONFIG_KEY = 'ifc-lite.influx.experimental.v1';
export const DEFAULT_INFLUX_CONFIG = {
  url: '', org: '', bucket: '', measurement: '', field: '', guidTag: 'ifc_guid', unit: '',
};
export type InfluxConfig = typeof DEFAULT_INFLUX_CONFIG;
export const configFields = Object.keys(DEFAULT_INFLUX_CONFIG) as Array<keyof InfluxConfig>;

/** Whitelist persisted fields; never spread parsed storage into runtime state. */
export function readInfluxConfig(): InfluxConfig {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(INFLUX_CONFIG_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_INFLUX_CONFIG };
    const saved = raw as Record<string, unknown>;
    return Object.fromEntries(configFields.map(key => [key, typeof saved[key] === 'string' ? saved[key] : DEFAULT_INFLUX_CONFIG[key]])) as InfluxConfig;
  } catch (error) {
    console.warn('InfluxDB configuration unavailable', error instanceof Error ? error.name : 'Storage error');
    return { ...DEFAULT_INFLUX_CONFIG };
  }
}

export function saveInfluxConfig(config: InfluxConfig, token: string): void {
  // Refused connection fields must not overwrite the last usable configuration.
  if (configFields.some(key => containsInfluxToken(config[key], token))) return;
  // URL userinfo is a credential too; the query rejects it, so never persist it.
  if (hasUrlCredentials(config.url)) return;
  const safe = Object.fromEntries(configFields.map(key => [key, config[key]]));
  localStorage.setItem(INFLUX_CONFIG_KEY, JSON.stringify(safe));
}

function hasUrlCredentials(value: string): boolean {
  try { const url = new URL(value); return Boolean(url.username || url.password); } catch { return false; }
}

export function influxSelection(config: InfluxConfig): InfluxSelection {
  return { ...config, minutes: 60, maxSamples: 10000 };
}
