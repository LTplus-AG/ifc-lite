/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readInfluxConfig } from '@/lib/influx/config';
import { loadInfluxReadings } from '@/lib/influx/load-readings';
import { influxTargets } from '@/lib/influx/targets';
import { matchInfluxSeries } from '@ifc-lite/flow-nodes/influx';
import { useViewerStore } from '@/store';
import { emptySchema } from './contract';
import { coordination, textSchema } from './coordination-common';
export const coordinationInfluxOperations = [
  coordination('influx.read', 'Read saved connection selection and native IFC sensor targets. Authentication token is never returned.', ['read'], emptySchema, () => ({ configuration: readInfluxConfig(), targets: influxTargets(useViewerStore.getState()) })),
  coordination('influx.query', 'Query the saved InfluxDB selection with a supplied ephemeral token. Native provider enforces a 60 minute and 10000 sample bound; returns terminal readings and model matches. Token is not persisted.', ['read', 'network'], textSchema, async (i, c) => {
    const state = useViewerStore.getState(), models = state.models, version = state.mutationVersion;
    c.checkpoint?.(); const readings = await loadInfluxReadings(readInfluxConfig(), i.value, c.signal ?? new AbortController().signal); c.checkpoint?.();
    const live = useViewerStore.getState();
    if (live.models !== models || live.mutationVersion !== version) throw new Error('Sensor target models changed during retrieval.');
    return { readings, joined: matchInfluxSeries(readings.latest, influxTargets(live)) };
  }),
];
