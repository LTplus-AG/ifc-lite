/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parsing the `<Components>` block of a BCF viewpoint: the selection and
 * exception lists, the per-element visibility flags, and the colouring map.
 *
 * Split out of `reader.ts`, which was over the module-size budget and which
 * held two copies of the component splitter -- the shape that let a real defect
 * live at one site's fixtures while the other looked identical. There is one
 * splitter now, in `parseComponentElements`.
 */
import type {
  BCFColoring,
  BCFComponent,
  BCFComponents,
  BCFViewSetupHints,
  BCFVisibility,
} from './types.js';
import { extractElement, unescapeXml } from './xml-text.js';

/**
 * Every `<Component>` element in an XML fragment.
 *
 * The two branches are spelled out rather than factored behind a common
 * `<Component[^>]*` prefix as
 * `<Component[^>]*(?:\/>|>[\s\S]*?<\/Component>)`, and that is the whole
 * point: `[^>]*` is greedy and eats the `/` of a self-closing tag, so the
 * `\/>` alternative can never fire. A uniform list still parsed, because the
 * engine backtracks and gives the `/` back when no later `</Component>`
 * exists. A MIXED list did not: `<Component .../><Component ...>...</Component>`
 * matched as ONE element spanning both, and the first component silently
 * inherited the second's `authoringToolId` and `originatingSystem`.
 *
 * That is why every fixture passed. Uniform lists are the only shape the suite
 * had, and they are the one shape the defect cannot reach.
 */
const COMPONENT_ELEMENT = /<Component[^>]*?\/>|<Component[^>]*>[\s\S]*?<\/Component>/g;

/** Parse each `<Component>` in `xml`, dropping any that does not parse. */
function parseComponentElements(xml: string): BCFComponent[] {
  const components: BCFComponent[] = [];
  for (const match of xml.matchAll(COMPONENT_ELEMENT)) {
    const component = parseComponent(match[0]);
    if (component) components.push(component);
  }
  return components;
}

/**
 * Parse components (selection/visibility/coloring)
 */
export function parseComponents(content: string): BCFComponents | undefined {
  const componentsMatch = content.match(/<Components>([\s\S]*?)<\/Components>/);
  if (!componentsMatch) return undefined;

  const componentsContent = componentsMatch[1];

  // Parse selection
  const selection = parseComponentList(componentsContent, 'Selection');

  // Parse visibility
  let visibility = parseVisibility(componentsContent);

  // Parse coloring
  const coloring = parseColoring(componentsContent);

  // Nothing read `ViewSetupHints` back, so every hint was lost on read —
  // including out of our own archives. It was invisible because no writer
  // fixture set the hints, so the round trip compared `undefined` to
  // `undefined`.
  //
  // Searched across the whole `Components` body on purpose, because the two
  // schema versions disagree on placement: 2.1 puts the element on
  // `Components`, 3.0 nests it inside `Visibility`, and `writer.ts` emits
  // whichever the requested version calls for. Anchoring to either one would
  // read half the files we produce.
  const viewSetupHints = parseViewSetupHints(componentsContent);
  if (viewSetupHints) {
    // Visibility is required by the schema, but tolerate a file that omits it:
    // DefaultVisibility's schema default is true.
    visibility = { ...(visibility ?? { defaultVisibility: true }), viewSetupHints };
  }

  if (!selection && !visibility && !coloring) {
    return undefined;
  }

  return {
    selection: selection?.length ? selection : undefined,
    visibility,
    coloring: coloring?.length ? coloring : undefined,
  };
}

/**
 * Parse a list of components
 */
function parseComponentList(content: string, elementName: string): BCFComponent[] | undefined {
  const match = content.match(new RegExp(`<${elementName}>([\\s\\S]*?)<\\/${elementName}>`));
  if (!match) return undefined;

  const components = parseComponentElements(match[1]);
  return components.length > 0 ? components : undefined;
}

/**
 * Parse a single component
 */
function parseComponent(content: string): BCFComponent | undefined {
  const ifcGuidMatch = content.match(/IfcGuid="([^"]+)"/);

  /** An attribute value, decoded the same way `extractElement` decodes an
   *  element's text, so `AuthoringToolId="A &amp; B"` and the element spelling
   *  of the same field yield the same string. Deliberately not
   *  `reader.ts::extractAttr`, which is contracted to take an already-captured
   *  attribute string and does not decode entities. Without this the two spellings of the SAME field
   *  disagreed: `AuthoringToolId="A &amp; B"` came back as the literal
   *  `A &amp; B` while `<AuthoringToolId>A &amp; B</AuthoringToolId>` came back
   *  as `A & B`. Which one a file uses is not supposed to change its value. */
  // Only the OPENING TAG. `content` is the whole element, so an unscoped
  // search reads a CHILD's attribute as the component's own:
  // `<Component IfcGuid="G"><Child OriginatingSystem="x"/></Component>` used to
  // report `x`. `\b` for the same reason `reader.ts::extractAttr` has it, or
  // `XAuthoringToolId="sneaky"` satisfies a search for `AuthoringToolId`.
  const openingTag = content.slice(0, content.indexOf('>') + 1);
  const attribute = (name: string): string | undefined => {
    const raw = openingTag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    return raw ? unescapeXml(raw) : undefined;
  };

  // Per BCF 2.1 §"Component" (unchanged in 3.0) only `IfcGuid` is an
  // attribute; `OriginatingSystem` and `AuthoringToolId` are child
  // ELEMENTS — which is exactly what writeComponent() emits. Reading them
  // as attributes matched nothing, so both fields were dropped from every
  // archive, ifc-lite's own included. The attribute spellings are still
  // accepted as a fallback so files from tools that emit the non-spec form
  // keep working; the element form wins when both are present.
  // `|| undefined`, not `??`: an EMPTY element (`<AuthoringToolId></...>`) has
  // to read the same as an empty attribute and as an absent one. Without it
  // the element form returned `''`, which survived the identity guard below
  // with no identity at all, and `writeComponent` then wrote it back as a bare
  // `<Component/>` that the reader discards. Three spellings of "nothing"
  // disagreeing is the same defect this file exists to fix.
  const authoringToolId =
    (extractElement(content, 'AuthoringToolId') || undefined) ?? attribute('AuthoringToolId');
  const originatingSystem =
    (extractElement(content, 'OriginatingSystem') || undefined) ?? attribute('OriginatingSystem');

  // A component needs some identity to be meaningful. `IfcGuid` is optional
  // in the schema, so `AuthoringToolId` alone is a valid identification —
  // and used to be discarded here because it was never found.
  if (!ifcGuidMatch && authoringToolId === undefined) {
    return undefined;
  }

  return {
    ifcGuid: ifcGuidMatch?.[1] === undefined ? undefined : unescapeXml(ifcGuidMatch[1]),
    authoringToolId,
    originatingSystem,
  };
}

/**
 * Parse visibility settings
 */
function parseVisibility(content: string): BCFVisibility | undefined {
  // Both branches, for the same reason as `COMPONENT_ELEMENT`: `<Exceptions>`
  // and `<ViewSetupHints>` are optional, so `<Visibility DefaultVisibility=
  // "false"/>` is schema-legal. Matching only the paired form made the whole
  // `<Components>` block return undefined for such a file, dropping the
  // selection and colouring with it. ifc-lite's own writer always emits the
  // paired form, which is why no fixture reached this.
  const visibilityMatch = content.match(
    /<Visibility[^>]*?\/>|<Visibility[^>]*>[\s\S]*?<\/Visibility>/,
  );
  if (!visibilityMatch) return undefined;

  // Read from the `<Visibility>` element, NOT from the enclosing `<Components>`
  // string: a `DefaultVisibility` attribute on any earlier element (a
  // `<Selection>` component, say) won the match and inverted the answer, so a
  // file saying show-all hid everything.
  const defaultVisMatch = visibilityMatch[0].match(/DefaultVisibility="([^"]+)"/);
  const defaultVisibility = defaultVisMatch?.[1] !== 'false';

  const exceptions = parseComponentList(visibilityMatch[0], 'Exceptions');

  return {
    defaultVisibility,
    exceptions,
  };
}

/**
 * Parse coloring settings
 */
function parseColoring(content: string): BCFColoring[] | undefined {
  const coloringMatch = content.match(/<Coloring>([\s\S]*?)<\/Coloring>/);
  if (!coloringMatch) return undefined;

  const colorings: BCFColoring[] = [];
  const colorMatches = coloringMatch[1].matchAll(/<Color\s+Color="([^"]+)"[^>]*>([\s\S]*?)<\/Color>/g);

  for (const match of colorMatches) {
    const color = match[1];
    const components = parseComponentElements(match[2]);
    if (components.length > 0) {
      colorings.push({ color, components });
    }
  }

  return colorings.length > 0 ? colorings : undefined;
}

/**
 * Parse the `<ViewSetupHints>` element that sits directly under `<Components>`.
 *
 * All three attributes are optional xs:boolean; an absent one stays `undefined`
 * rather than collapsing to `false`, because "the author did not say" and "the
 * author said no" mean different things to a viewer applying the hints.
 */
function parseViewSetupHints(content: string): BCFViewSetupHints | undefined {
  const match = content.match(/<ViewSetupHints\b([^>]*)>/);
  if (!match) return undefined;

  const attrs = match[1];
  const flag = (name: string): boolean | undefined => {
    const raw = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    if (raw === undefined) return undefined;
    return raw === 'true' || raw === '1';
  };

  const spacesVisible = flag('SpacesVisible');
  const spaceBoundariesVisible = flag('SpaceBoundariesVisible');
  const openingsVisible = flag('OpeningsVisible');

  if (
    spacesVisible === undefined
    && spaceBoundariesVisible === undefined
    && openingsVisible === undefined
  ) {
    return undefined;
  }

  return { spacesVisible, spaceBoundariesVisible, openingsVisible };
}
