/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { runInfluxSpike } from './influx-flow.mjs';

export type InfluxReport = Awaited<ReturnType<typeof runInfluxSpike>> & {
  source: 'synthetic-demo' | 'live-influxdb-2';
  model: string;
  guidTag: string;
  entityNames: Record<string, string>;
};

/** An offline result inspector. No credentials, dependencies, or network I/O. */
export function influxReport(report: InfluxReport): string {
  const data = JSON.stringify(report).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IFC monitoring spike · #8090</title>
<style>
body{font:15px system-ui,sans-serif;margin:24px auto;max-width:980px;padding:0 16px;color:#e5ecf3;background:#101820}
h1{font-size:26px}small,p{color:#a9bac8}button{font:inherit;color:inherit;background:#233342;border:1px solid #496477;border-radius:6px;padding:10px;cursor:pointer;text-align:left}
button[aria-pressed=true]{border-color:#64dbbd;background:#1b423c}.layout{display:grid;grid-template-columns:240px 1fr;gap:24px}.targets{display:flex;flex-direction:column;gap:8px}
svg{width:100%;height:240px;border:1px solid #405565;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#192733;padding:16px;border-radius:8px;font-size:12px}
#value{font-size:32px;color:#64dbbd;margin:10px 0}summary{cursor:pointer;padding:12px 0}#empty{padding:24px;border:1px solid #405565}
@media(max-width:600px){.layout{grid-template-columns:1fr}.targets{flex-direction:row;flex-wrap:wrap}}
</style><h1>IFC monitoring spike</h1><p id="source"></p><p id="counts"></p>
<div class="layout"><nav class="targets" aria-label="Mapped IFC entities" id="targets"></nav>
<section aria-label="Selected entity history"><h2 id="entity">Choose a mapped entity</h2><div id="value"></div><p id="timestamp"></p>
<svg id="chart" viewBox="0 0 600 240" role="img" aria-label="Reading history"></svg><p id="range"></p><p id="empty" hidden>No uniquely mapped readings in this interval.</p></section></div>
<details><summary>Unmatched readings</summary><pre id="unmatched"></pre></details>
<details><summary>Ambiguous readings — no automatic assignment</summary><pre id="ambiguous"></pre></details>
<details><summary>Flow execution</summary><pre id="nodes"></pre></details>
<script type="application/json" id="data">${data}</script><script>
const report=JSON.parse(document.getElementById('data').textContent);
const text=(id,value)=>{document.getElementById(id).textContent=value};
text('source',report.source==='synthetic-demo'?'Synthetic telemetry · parsed IFC sample · no live database connection':'Live InfluxDB 2 response · '+report.model);
text('counts',report.matched.rows.length+' mapped · '+report.unmatched.rows.length+' unmatched · '+report.ambiguous.rows.length+' ambiguous series');
for(const key of ['unmatched','ambiguous','nodes'])text(key,JSON.stringify(report[key].rows??report[key],null,2));
const buttons=[];
function select(row,button){
  for(const item of buttons)item.setAttribute('aria-pressed',String(item===button));
  text('entity',report.entityNames[row.GlobalId]??row.GlobalId);
  text('value',row._value+' '+report.unit);
  text('timestamp','Latest sample: '+row._time+' · '+row.GlobalId);
  const reserved=new Set(['','result','table','_start','_stop','_time','_value']);
  const tags=report.history.columns.map(c=>c.name).filter(k=>!reserved.has(k));
  const stamp=p=>p._time.slice(0,19)+p._time.slice(19,-1).replace('.','').padEnd(9,'0');
  const points=report.history.rows.filter(p=>tags.every(k=>p[k]===row[k])).sort((a,b)=>stamp(a).localeCompare(stamp(b)));
  const times=points.map(p=>Date.parse(p._time)),values=points.map(p=>Number(p._value));
  const lo=Math.min(...values),hi=Math.max(...values),start=Math.min(...times),stop=Math.max(...times);
  const coords=values.map((v,i)=>[40+520*(times[i]-start)/(stop-start||1),200-160*(v-lo)/(hi-lo||1)]);
  const svg=document.getElementById('chart');svg.replaceChildren();
  const line=document.createElementNS('http://www.w3.org/2000/svg','polyline');
  line.setAttribute('points',coords.map(p=>p.join(',')).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','#64dbbd');line.setAttribute('stroke-width','3');svg.append(line);
  for(const [x,y] of coords){const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('cx',x);dot.setAttribute('cy',y);dot.setAttribute('r','4');dot.setAttribute('fill','#64dbbd');svg.append(dot)}
  text('range',points.length+' samples · '+lo+'–'+hi+' '+report.unit+' · '+points[0]._time+' → '+points.at(-1)._time+' (display axis uses milliseconds)');
}
for(const row of report.matched.rows){
  const button=document.createElement('button');button.type='button';button.setAttribute('aria-pressed','false');
  button.textContent=report.entityNames[row.GlobalId]??row.GlobalId;button.onclick=()=>select(row,button);
  document.getElementById('targets').append(button);buttons.push(button);
}
if(buttons.length)buttons[0].click();else document.getElementById('empty').hidden=false;
</script></html>`;
}
