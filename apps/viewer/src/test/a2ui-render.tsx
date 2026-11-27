/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mount an A2UI reply the way the chat does (session, real catalog, real
 * `A2uiSurface`), with a recording chart renderer instead of a canvas and a
 * host whose view calls are recorded on their way to the real backend.
 */

import type { ChartItem, EChartsOptionObject } from '@ifc-lite/charts';
import type { WireEntityRef } from '@ifc-lite/a2ui';
import type { ChartRenderer, ChartRendererEvents } from '@/components/viewer/charts/useEChart';
import { SegmentsView } from '@/components/a2ui/SegmentsView';
import type { A2uiViewerHost, ColorBatch } from '@/lib/a2ui/host';
import { A2uiMessageSession } from '@/lib/a2ui/session';
import { render, settle } from '@/test/render.js';
import { A2uiChartRendererContext } from '@/components/a2ui/runtime';

export interface RecordedChart {
  options: EChartsOptionObject[];
  events: ChartRendererEvents;
}

export function recordingChartRenderer(): { renderer: ChartRenderer; charts: RecordedChart[] } {
  const charts: RecordedChart[] = [];
  const renderer: ChartRenderer = async () => (_el, events) => {
    const chart: RecordedChart = { options: [], events };
    charts.push(chart);
    return {
      setOption: (option) => { chart.options.push(option); },
      select: (_full: readonly ChartItem[], _partial: readonly ChartItem[]) => {},
      resize: () => {},
      dispose: () => {},
    };
  };
  return { renderer, charts };
}

export interface ViewCalls {
  colorize: ColorBatch[][];
  isolate: WireEntityRef[][];
  hide: WireEntityRef[][];
  show: WireEntityRef[][];
  flyTo: WireEntityRef[][];
}

/** The real host, with view calls recorded before they reach the backend. */
export function recordingHost(host: A2uiViewerHost): { host: A2uiViewerHost; calls: ViewCalls } {
  const calls: ViewCalls = { colorize: [], isolate: [], hide: [], show: [], flyTo: [] };
  return {
    calls,
    host: {
      ...host,
      colorize: (b) => { calls.colorize.push(b); host.colorize(b); },
      isolate: (r) => { calls.isolate.push(r); host.isolate(r); },
      hide: (r) => { calls.hide.push(r); host.hide(r); },
      show: (r) => { calls.show.push(r); host.show(r); },
      flyTo: (r) => { calls.flyTo.push(r); host.flyTo(r); },
    },
  };
}

export interface MountedReply {
  container: HTMLElement;
  session: A2uiMessageSession;
  charts: RecordedChart[];
  followUps: Array<{ text: string; context: Record<string, unknown> }>;
}

const plainText = (text: string, _start: number, key: string) => ({ node: <p key={key}>{text}</p>, codeCount: 0 });

/** Feed `reply` through a session and mount it. */
export async function mountReply(host: A2uiViewerHost, reply: string): Promise<MountedReply> {
  const session = new A2uiMessageSession(host);
  session.feed(reply);
  session.close();
  const { renderer, charts } = recordingChartRenderer();
  const followUps: MountedReply['followUps'] = [];
  const onFollowUp = (text: string, context: Record<string, unknown>) => { followUps.push({ text, context }); };
  const container = render(
    <A2uiChartRendererContext.Provider value={renderer}>
      <SegmentsView session={session} host={host} onFollowUp={onFollowUp} renderText={plainText} />
    </A2uiChartRendererContext.Provider>,
  );
  await settle();
  return { container, session, charts, followUps };
}

/** Wrap Express source in a block, as a model writes it. */
export function block(source: string): string {
  return `<a2ui>\n${source}\n</a2ui>`;
}
