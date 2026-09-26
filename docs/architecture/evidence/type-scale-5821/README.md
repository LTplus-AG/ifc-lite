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
