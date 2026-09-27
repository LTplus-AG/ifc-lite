# MCP type-scale visual check (#5821)

These screenshots compare the MCP landing and playground pages before and after
the five-file typography migration in PR #6114. The before build uses the
merged type-scale infrastructure from PR #6113; the after build includes the
MCP replacements. Both were captured in headful Chrome from production Vite
builds on the same machine, at 1440 × 900 (desktop) and 390 × 844 (mobile).

| Page | Before | After |
| --- | --- | --- |
| Landing, desktop | [before](mcp-before-desktop.png) | [after](mcp-after-desktop.png) |
| Landing, mobile | [before](mcp-before-mobile.png) | [after](mcp-after-mobile.png) |
| Playground, desktop | [before](mcp-before-playground.png) | [after](mcp-after-playground.png) |

The first after-mobile build wrapped the two hero actions. The final after
capture above uses `text-sm` below the `sm` breakpoint and keeps both actions
on one row. The mobile document width is 375 CSS pixels within the 390-pixel
viewport, with no horizontal overflow.

This batch changes typography through generated Tailwind CSS. The changed-test
revert oracle cannot observe computed fonts without a browser test (browser
specs are excluded from that oracle). PR #6114 uses the repository's
`revert-oracle-exempt` label; the production build and these same-viewport
browser captures are its behavior evidence.

## Appearance batch

The Appearance batch replaces 33 arbitrary 10px and 11px font utilities in
ten Appearance component files. The [before](appearance-before.png) and
[after](appearance-after.png) screenshots show the built-in
`building-architecture.ifc` demo in the viewer with the Appearance panel open.
Both are headful Chrome production builds at 1440 × 900 with the same model
and viewport. The source hint grows from 10px to the 11px floor; its wording
is shortened to keep the PDF limit on one line (measured height: 17.875 CSS
pixels after). The document width remains 1440 CSS pixels with no horizontal
overflow.

## Extensions, compare, and cost batch

This batch replaces 83 numeric font utilities in the Extensions, Compare, and
Cost panels. The [before](extensions-before-ideas.png) and
[after](extensions-after-ideas.png) screenshots show the built-in IFC demo with
the Extensions Ideas tab open in headful Chrome production builds at the same
1440 × 900 viewport. The getting-started heading grows from 10px to the 11px
`text-2xs` floor. Both builds keep the document width at 1440 CSS pixels, with
no horizontal overflow; the heading remains within its 317 CSS-pixel container.

## Layers, Flow, and measurement batch

This batch replaces 147 numeric font utilities in the Layers, Flow, and
measurement tools. The [before](flow-before-gallery.png) and
[after](flow-after-gallery.png) screenshots show the Flow example gallery over
the built-in IFC demo in headful Chrome production builds at 1440 × 900. The
first example's node and edge count grows from 10px to the 11px `text-2xs`
floor. Its line remains within the 324 CSS-pixel card, and the document width
stays at 1440 CSS pixels in both builds.

## Data and authoring panels batch

This batch replaces 115 numeric font utilities in the Clash, Add Element,
Point Cloud, validation, and related data panels. The
[before](add-element-before.png) and [after](add-element-after.png) screenshots
show the Add Element wall form over the built-in IFC demo in headful Chrome
production builds at 1440 × 900. The Type label grows from 10px to the 11px
`text-2xs` floor. All controls remain visible, and both document widths stay
at 1440 CSS pixels with no horizontal overflow.

## Properties panel batch

This batch replaces 55 numeric font utilities in the Properties panel and
Property Editor with the shared 11px `text-2xs` floor. The [light before](properties-panel/before-light.png)
and [light after](properties-panel/after-light.png) captures, and the [dark before](properties-panel/before-dark.png)
and [dark after](properties-panel/after-dark.png) captures, show the same
`building-architecture.ifc` model with its `IfcSlab` selected at 1440 × 900.
The model has 12 geometric elements. In Chrome, the EPSG label grows from 9px
to 11px in both themes. All four captures have a 1440 CSS-pixel document width
without horizontal overflow; the property set remains visible.

## Welcome, search, and secondary panels batch

This batch replaces 30 numeric font utilities in the welcome card, search
results, document, schedule, chart, drawing, compare, and flow panels. The
[welcome before](search-welcome/before-welcome-light.png) and [welcome after](search-welcome/after-welcome-light.png)
captures show the empty viewer at 1440 × 900. The search captures compare
[light before](search-welcome/before-search-light.png) with [light after](search-welcome/after-search-light.png),
and [dark before](search-welcome/before-search-dark.png) with [dark after](search-welcome/after-search-dark.png).
They use the same authored `building-architecture.ifc` model and a `floor`
query, which returns the `IfcSlab`. The model has 12 geometric elements, the
result remains visible, and the document width stays at 1440 CSS pixels in
both themes and both revisions.
