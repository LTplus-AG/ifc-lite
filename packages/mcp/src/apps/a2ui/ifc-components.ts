/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SURFACE_ACTIONS, type SurfaceAction } from './constants.js';
import { block, button, element, items, record, refs, text, value, viewerNote, type Props, type RendererAction } from './dom.js';
import { foldGroups, resolveMaxGroups, safeHexColor } from '@ifc-lite/a2ui';

const actionLabels: Record<SurfaceAction, string> = {
  select: 'Select', isolate: 'Isolate', colorize: 'Colorize', flyTo: 'Fly to', resetView: 'Reset view',
};

function table(p: Props, act: RendererAction): HTMLElement {
  if (value(p.rows) === undefined && p.query) return block(p.title, viewerNote());
  const columns = items(p.columns).map(record);
  const rows = items(p.rows).map(record);
  if (!rows.length) return block(p.title, element('p', 'No rows.'));
  const wrap = element('div', undefined, 'table-scroll');
  const table = element('table');
  const headers = table.createTHead().insertRow();
  for (const column of columns) {
    const heading = element('th', text(column.label) || text(column.path));
    heading.scope = 'col';
    headers.append(heading);
  }
  const body = table.createTBody();
  const configuredSize = Number(value(p.maxRows));
  const pageSize = Number.isFinite(configuredSize) ? Math.max(1, Math.min(200, Math.floor(configuredSize))) : 50;
  const pagination = element('nav', undefined, 'actions');
  pagination.setAttribute('aria-label', 'Table pagination');
  let page = 0;
  const previous = button('Previous', () => { page--; display(); });
  const next = button('Next', () => { page++; display(); });
  const pageLabel = element('span');
  pageLabel.setAttribute('aria-live', 'polite');
  pagination.append(previous, pageLabel, next);
  function display(): void {
    body.replaceChildren();
    const start = page * pageSize;
    for (const row of rows.slice(start, start + pageSize)) {
      const tr = body.insertRow();
      const targets = refs(row.refs ?? [row.ref]);
      columns.forEach((column, index) => {
        const path = text(column.path);
        const label = Object.hasOwn(row, path) ? text(row[path]) : '';
        const cell = tr.insertCell();
        if (index === 0 && targets.length) cell.append(button(label || targets.join(', '), () => act('select', targets)));
        else cell.textContent = label || '–';
      });
    }
    pageLabel.textContent = `${start + 1}–${Math.min(start + pageSize, rows.length)} of ${rows.length}`;
    previous.disabled = page === 0;
    next.disabled = start + pageSize >= rows.length;
  }
  display();
  wrap.append(table);
  const section = block(p.title, wrap);
  if (rows.length > pageSize) section.append(pagination);
  return section;
}

function list(p: Props, act: RendererAction): HTMLElement {
  if (value(p.refs) === undefined && p.query) return block(p.title, viewerNote());
  const list = element('ul');
  const targets = refs(p.refs);
  for (const ref of targets) {
    const item = element('li');
    item.append(button(ref, () => act('select', [ref])));
    list.append(item);
  }
  return block(p.title, targets.length ? list : element('p', 'No entities.'));
}

function stats(p: Props): HTMLElement {
  const list = element('dl', undefined, 'stats');
  for (const stat of items(p.items).map(record)) {
    const tile = element('div', undefined, 'tile');
    tile.append(element('dt', text(stat.label)), element('dd', value(stat.value) === undefined && stat.query
      ? 'Computed in the viewer' : [text(stat.value) || '–', text(stat.unit)].filter(Boolean).join(' ')));
    list.append(tile);
  }
  return list;
}

function chart(p: Props, act: RendererAction): HTMLElement {
  if (value(p.data) === undefined && p.query) return block(p.title, viewerNote());
  const data = items(p.data).map(record).filter((d) => typeof d.value === 'number' && Number.isFinite(d.value));
  if (!data.length) return block(p.title, element('p', 'No groups.'));
  const shown = foldGroups(data.map((d): Props & { value: number } => ({ ...d, value: Number(d.value) })), resolveMaxGroups(value(p.maxGroups)),
    (other) => ({ label: 'Other', value: other.reduce((sum, datum) => sum + datum.value, 0), refs: other.flatMap(datum => refs(datum.refs)) }));
  const maximum = Math.max(1, ...shown.map(datum => Math.abs(Number(datum.value))));
  const chart = element('ul', undefined, 'chart');
  for (const datum of shown) {
    const li = element('li');
    const label = `${text(datum.label)} (${text(datum.value)})`;
    const targets = refs(datum.refs);
    li.append(targets.length ? button(label, () => act('select', targets)) : element('span', label));
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    bar.setAttribute('viewBox', '0 0 100 8');
    bar.setAttribute('preserveAspectRatio', 'none');
    bar.setAttribute('aria-hidden', 'true');
    const rect = document.createElementNS(bar.namespaceURI, 'rect');
    rect.setAttribute('width', String((Math.abs(Number(datum.value)) / maximum) * 100));
    rect.setAttribute('height', '8');
    bar.append(rect);
    li.append(bar);
    chart.append(li);
  }
  return block(p.title, chart);
}

function legend(p: Props, act: RendererAction): HTMLElement {
  if (value(p.data) === undefined) return block(p.title, viewerNote());
  const list = element('ul', undefined, 'legend');
  for (const entry of items(p.data).map(record)) {
    const item = element('li');
    const swatch = element('span', undefined, 'swatch');
    swatch.setAttribute('aria-hidden', 'true');
    const color = safeHexColor(entry.color, '');
    if (color) swatch.style.backgroundColor = color;
    const targets = refs(entry.refs);
    item.append(swatch, targets.length
      ? button(text(entry.label), () => act('colorize', targets, color))
      : element('span', text(entry.label)));
    list.append(item);
  }
  return block(p.title, list);
}

export const ifcComponents: Record<string, (props: Props, act: RendererAction) => HTMLElement> = {
  EntityTable: table,
  EntityList: list,
  StatGroup: stats,
  GroupChart: chart,
  ColorLegend: legend,
  Callout: (p) => block(p.title, element('p', text(p.text)), 'callout'),
  EntityCard(p, act) {
    const targets = refs([text(p.entity)]);
    return targets.length
      ? block(p.entity, button('Open in viewer', () => act('select', targets)))
      : viewerNote();
  },
  ActionBar(p, act) {
    const targets = refs(p.refs);
    if (p.query && value(p.refs) === undefined) return viewerNote();
    const bar = element('div', undefined, 'actions');
    for (const action of SURFACE_ACTIONS.filter((action) => items(p.actions).includes(action))) {
      const control = button(actionLabels[action], () => act(action, targets, text(p.color) || undefined));
      control.disabled = action !== 'resetView' && targets.length === 0;
      bar.append(control);
    }
    return bar;
  },
};
