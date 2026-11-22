/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { fetchInfluxReadings } from '@ifc-lite/flow-nodes/influx';
import { influxSelection, type InfluxConfig } from './config';
/** One bounded provider path. Token is ephemeral and never stored in viewer state. */
export async function loadInfluxReadings(config: InfluxConfig, token: string, signal: AbortSignal) {
  return fetchInfluxReadings(influxSelection(config), token, fetch, signal);
}
