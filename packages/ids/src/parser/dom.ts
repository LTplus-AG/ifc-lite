/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DOM lookup helpers shared by the IDS XML parser and its restriction
 * parser. Split out of `xml-parser.ts` so both can import them without
 * a cycle; behaviour is unchanged.
 */

export function getChildElement(parent: Element, localName: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.localName.toLowerCase() === localName.toLowerCase()) {
      return child;
    }
  }
  return null;
}

export function getChildElements(parent: Element, localName: string): Element[] {
  const elements: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (child.localName.toLowerCase() === localName.toLowerCase()) {
      elements.push(child);
    }
  }
  return elements;
}

export function getChildElementNS(
  parent: Element,
  localName: string,
  namespace: string
): Element | null {
  for (const child of Array.from(parent.children)) {
    if (
      child.localName.toLowerCase() === localName.toLowerCase() &&
      child.namespaceURI === namespace
    ) {
      return child;
    }
  }
  return null;
}

export function getChildElementsNS(
  parent: Element,
  localName: string,
  namespace: string
): Element[] {
  const elements: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (
      child.localName.toLowerCase() === localName.toLowerCase() &&
      child.namespaceURI === namespace
    ) {
      elements.push(child);
    }
  }
  return elements;
}

export function getChildText(parent: Element, localName: string): string | undefined {
  const child = getChildElement(parent, localName);
  return child?.textContent?.trim() || undefined;
}
