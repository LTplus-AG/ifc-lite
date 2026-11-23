/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getValue, isComponentNode, WritableBinding, type NodeAction } from '@a2ui/web_core/v1_0';
import { button, element, items, record, text, value, type Props } from './dom.js';

type Child = (node: unknown) => Node;

function tabs(p: Props, child: Child): HTMLElement {
  const container = element('div');
  const controls = element('div', undefined, 'actions');
  const content = element('div');
  const pages = items(p.tabs).map(record);
  const buttons = pages.map((tab, index) => button(text(tab.title), () => show(index)));
  function show(index: number): void {
    content.replaceChildren(child(pages[index].child));
    buttons.forEach((control, i) => control.setAttribute('aria-pressed', String(i === index)));
  }
  if (buttons.length) show(0);
  controls.append(...buttons);
  container.append(controls, content);
  return container;
}

function field(type: string, p: Props): HTMLElement {
  const label = element('label', text(p.label));
  const current = value(p.value);
  const write = (data: string | number | boolean | string[]) => {
    if (p.value instanceof WritableBinding) p.value.set(data);
  };
  if (type === 'ChoicePicker') {
    const select = element('select');
    select.multiple = p.variant === 'multipleSelection';
    const selected = items(current);
    for (const item of items(p.options).map(record)) {
      const option = element('option', text(item.label));
      option.value = text(item.value);
      option.selected = selected.includes(option.value);
      select.append(option);
    }
    select.addEventListener('change', () => write(Array.from(select.selectedOptions, (o) => o.value)));
    label.append(select);
    return label;
  }
  if (type === 'TextField' && p.variant === 'longText') {
    const input = element('textarea');
    input.value = text(current);
    input.placeholder = text(p.placeholder);
    input.addEventListener('change', () => write(input.value));
    label.append(input);
    return label;
  }
  const input = element('input');
  if (type === 'Slider') {
    input.type = 'range';
    input.min = text(p.min) || '0';
    input.max = text(p.max);
    input.step = Number(p.steps) > 0 ? String((Number(input.max) - Number(input.min)) / Number(p.steps)) : 'any';
    input.value = text(current);
    input.addEventListener('change', () => write(input.valueAsNumber));
  } else if (type === 'CheckBox') {
    input.type = 'checkbox';
    input.checked = current === true;
    input.addEventListener('change', () => write(input.checked));
  } else {
    input.type = p.variant === 'obscured' ? 'password' : p.variant === 'number' ? 'number' : 'text';
    input.value = text(current);
    input.placeholder = text(p.placeholder);
    input.addEventListener('change', () => write(input.value));
  }
  label.append(input);
  return label;
}

export function renderBasic(type: string, p: Props, child: Child, report: (message: string) => void): HTMLElement {
  switch (type) {
    case 'Text': {
      const label = text(p.text);
      return label.startsWith('**') && label.endsWith('**') ? element('h1', label.slice(2, -2)) : element('p', label);
    }
    case 'Divider': return element('hr');
    case 'Tabs': return tabs(p, child);
    case 'TextField': case 'CheckBox': case 'ChoicePicker': case 'Slider': return field(type, p);
    case 'Button': {
      const control = button('', () => {
        if (typeof p.action === 'function') {
          void Promise.resolve().then(() => (p.action as NodeAction)()).catch((err: unknown) => {
            report(err instanceof Error ? err.message : String(err));
          });
        }
      });
      control.append(isComponentNode(p.child) && p.child.type === 'Text'
        ? element('span', text(getValue(p.child.props).text))
        : child(p.child));
      return control;
    }
    case 'Card': {
      const card = element('section', undefined, 'card');
      card.append(child(p.child));
      return card;
    }
    default: {
      const container = element('div', undefined, type === 'Row' ? 'row' : 'column');
      container.append(...items(p.children).map(child));
      return container;
    }
  }
}
