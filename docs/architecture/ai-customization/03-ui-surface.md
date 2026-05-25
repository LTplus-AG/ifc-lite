# 03 — UI Extension Surface

This document defines the slot catalogue, the declarative widget DSL, the
host-renders-chrome contract, and accessibility requirements. The
contract is one sentence: **the sandbox describes UI, the host renders
UI.** Everything in this document is downstream of that sentence.

## 1. Why declarative widgets, not JSX

A more permissive design lets extensions ship React components. We
considered it and rejected it. The reasons:

1. **Trust boundary preservation.** Components shipped by extensions run
   in the host realm or require a separate iframe per extension. The
   first violates §02; the second balloons memory and complicates focus
   management.
2. **Host upgrade durability.** A React component is bound to the host's
   React version, design tokens, and Tailwind config. Every host upgrade
   risks breaking every extension. A declarative widget is bound only
   to the DSL version, which we evolve under SemVer with the manifest.
3. **Accessibility.** The host owns ARIA semantics, focus order, keyboard
   shortcuts. A free-form UI surface degrades this; a fixed widget
   catalogue lets us guarantee it.
4. **Multi-target rendering.** The same widget renders in the desktop
   app, the embed SDK, and (Phase 4) a possible mobile target. JSX does
   not survive that crossing; data does.
5. **AI authoring.** A small declarative DSL is *vastly* easier for the
   AI to author correctly than React JSX. The repair loop becomes
   tractable.

The cost is expressivity. We accept the cost; we will add widgets when
real extensions need them.

## 2. Slot catalogue

Slots are named extension points. Each slot has a fixed contract: what
contributions it accepts, what the host renders, how it composes with
other contributions.

| Slot id | Rendered as | Contributions |
|---|---|---|
| `commandPalette` | Searchable list (Cmd+K) | Commands |
| `toolbar.left` | Icon buttons left of canvas | Toolbar items |
| `toolbar.right` | Icon buttons right of canvas | Toolbar items |
| `toolbar.center` | Inline contextual chips | Toolbar items (only visible with `when` matches) |
| `dock.left` | Tabbed left sidebar | Dock panels |
| `dock.right` | Tabbed right sidebar | Dock panels |
| `dock.bottom` | Bottom drawer (logs, results) | Dock panels |
| `contextMenu.entity` | Right-click on a model entity | Menu items |
| `contextMenu.canvas` | Right-click on empty canvas | Menu items |
| `contextMenu.tree` | Right-click in hierarchy panel | Menu items |
| `statusBar.left` `statusBar.right` | Status bar segments | Status text + actions |
| `exportMenu` | "Export" dropdown items | Exporters |
| `lensLibrary` | Available lens presets in lens panel | Lens evaluators |
| `idsRules.custom` | Custom IDS rules in IDS panel | IDS validators |
| `keybindings` | (no UI; affects key dispatch) | Keybinding rules |
| `onboarding.tips` (future) | Tip carousel on empty state | Tip cards (Phase 3) |

The host owns all of these slots. Their look, their compose order, their
collapse behaviour, their accessibility are host code. Extensions
contribute structured *content*.

### 2.1 Composition

When multiple extensions contribute to the same slot:

- **Commands** appear in the palette grouped by `paletteCategory`,
  alphabetised within category.
- **Toolbar items** sort by `order` ascending; ties broken by manifest
  id alphabetically. The user can drag-reorder; reorder overrides are
  saved in the flavor.
- **Dock panels** stack as tabs in the order the user pins them.
- **Context menu items** group by `group` then by `order`. Separators
  are inserted between groups. Maximum 12 items per group; overflow
  goes into a submenu.
- **Status bar items** sort by `order`. Items the host owns sort first
  on the left segment, last on the right segment.
- **Keybindings** with the same `key` resolve by `when`-specificity:
  the most specific `when` clause wins. Conflicts at equal specificity
  warn at load time.

### 2.2 Visibility (`when`)

Each contribution may declare a `when` clause (see [§01.5.1]). Slots
re-evaluate `when` clauses on state change and hide / show
contributions accordingly. Extensions never see the underlying state;
they only know whether their contribution is currently visible if they
subscribe to `ctx.slots.onVisibilityChange(slotId)`.

## 3. The widget DSL

A widget is a JSON document describing UI. The root of any widget is a
typed node; child nodes nest. The DSL is intentionally small.

### 3.1 Node taxonomy (v1)

| Node | Purpose |
|---|---|
| `Stack` | Vertical or horizontal layout. |
| `Group` | Bordered group with optional title. |
| `Text` | Static text with style variant (`heading`, `body`, `caption`). |
| `Field` | Labeled form input. Variants: `text`, `number`, `boolean`, `select`, `multiSelect`, `entityPicker`, `colorPicker`, `file`. |
| `Button` | Primary action; binds to a command id with optional arg literal. |
| `Table` | Tabular data with sortable columns. |
| `Chart` | Bar / line / pie with declarative data binding. |
| `Markdown` | Rendered Markdown; HTML stripped; links open with explicit user gesture. |
| `Tabs` | Tabbed container of sub-widgets. |
| `Separator` | Horizontal rule. |
| `EmptyState` | Header + body + optional CTA. |
| `Spinner` | Loading indicator with optional label. |
| `ErrorBanner` | Inline error with retry action. |
| `EntityList` | Bound to selection or query results; renders previews + click navigation. |
| `Tree` | Hierarchical list (e.g. for spatial structures). |
| `KeyValueGrid` | Two-column property display. |

That is the entire surface for v1. Notably absent: free-form HTML,
canvas, video, `iframe`, raw images from extension data URIs, custom
elements. Adding nodes is a SemVer-minor change to the manifest.

### 3.2 Data binding

Widgets bind to data the extension produces. The extension's handler
returns a *widget state object*; the widget's node tree references
fields of that object via JSONPath-like accessors:

```json
{
  "type": "Stack",
  "direction": "vertical",
  "children": [
    {
      "type": "Text",
      "variant": "heading",
      "text": "Fire Rating Report"
    },
    {
      "type": "Table",
      "data": "$.rows",
      "columns": [
        { "title": "Storey", "field": "storey" },
        { "title": "Walls", "field": "wallCount", "align": "right" },
        { "type": "FireRating", "field": "rating" }
      ]
    },
    {
      "type": "Button",
      "label": "Export CSV",
      "command": "ext.com.example.fire.export",
      "args": { "groupBy": "storey" }
    }
  ]
}
```

The data is JSON-serialisable. The bridge enforces this; non-JSON
values (functions, DOM nodes, host objects) cannot cross.

### 3.3 Event handling

Widgets emit events to commands, not to closures. A `Button`'s `command`
field names a command id; clicking it invokes the command via the
host's command dispatcher. The host enforces the user's keybindings,
focus order, and accessibility along the way.

Why this matters: a closure-based event handler invites the extension
to capture state, build implicit dependencies, and circumvent the
manifest. Command dispatch keeps the call graph visible in the
manifest.

### 3.4 Reactive updates

The handler can return an updated widget state; the host diffs and
re-renders. The handler is also allowed to push partial updates via
`ctx.widget(<id>).update(partial)` — the host merges and re-renders.

State is owned by the host. The extension's view of state is whatever
the handler last returned. There is no shared mutable object across
the boundary.

### 3.5 Theming and styling

Extensions cannot ship CSS. They specify *intent*:

- `variant`: `'primary' | 'secondary' | 'destructive' | 'ghost'`
- `tone`: `'info' | 'warn' | 'error' | 'success'`
- `density`: `'comfortable' | 'compact'`
- `align`, `justify`, `gap`, `padding`: enumerated tokens, not raw CSS.

The host maps these to the Tailwind token system already used in the
viewer. Dark mode, high-contrast mode, mobile density all become host
responsibilities.

## 4. Accessibility

Accessibility is the host's job. Every widget the DSL renders meets:

- Keyboard navigation across all interactive elements (`tab`, `shift+tab`).
- Screen reader semantics with appropriate ARIA roles.
- Focus visible on every focusable element.
- Colour contrast meets WCAG AA against the active theme.
- Hit targets ≥ 24×24 px on desktop, ≥ 44×44 px on touch.

Because extensions cannot ship CSS or custom DOM, these guarantees hold
regardless of which extension is contributing. This is one of the
biggest wins of the declarative DSL over JSX.

## 5. Localisation

Strings in the manifest (`name`, `description`, command titles, widget
text) flow through `ctx.t(key)`. The manifest's `l10n` block provides
translations:

```json
"l10n": {
  "en": { "report.title": "Fire Rating Report", "export.csv": "Export CSV" },
  "de": { "report.title": "Brandwiderstand-Bericht", "export.csv": "CSV exportieren" }
}
```

Falls back to `en` if a key is missing in the active locale. Untranslated
strings render with the key wrapped in `[[ ]]` brackets in dev mode for
visibility.

## 6. The host loader contract

When an extension activates, the host:

1. Validates each declarative widget against the DSL schema.
2. Registers slot contributions in the `SlotRegistry`.
3. Subscribes the slot's React component to the contribution set.
4. Re-renders the slot.

Steps 3-4 are host concerns. The extension never imports React, never
touches JSX, never sees a ref. The bridge does not expose any DOM API.

## 7. The "embedded view" escape hatch (Phase 3, not v1)

We anticipate at most one case where the DSL is not enough: a fully
custom 2D / 3D visualisation. We do *not* ship that in v1. If we do
later, the design is:

- A new node `Embedded` with `mode: 'iframe'`.
- A separate origin (e.g. `https://ext.ifclite.com/sandbox/<id>`) so
  the iframe is sandboxed by the browser.
- A `postMessage` bridge with a typed contract.
- A capability `ui.embedded` required to use it, flagged as red on the
  review screen.

We will revisit if and when an extension we want to ship cannot be
built with the DSL.

## 8. Worked example

A simple "selected wall fire rating" panel:

**Manifest excerpt:**

```json
{
  "contributes": {
    "dock": [
      {
        "id": "fire-panel",
        "slot": "dock.right",
        "title": "Fire Rating",
        "icon": "Flame",
        "widget": "widgets/fire-panel.json",
        "when": "selection.count > 0 && selection.type == 'IfcWall'"
      }
    ],
    "commands": [
      { "id": "ext.fire.refresh", "title": "Refresh Fire Rating" }
    ]
  },
  "entry": {
    "commands": {
      "ext.fire.refresh": "src/commands/refresh.js"
    },
    "triggers": {
      "onSelectionChange": "src/triggers/on-select.js"
    }
  }
}
```

**Widget:**

```json
{
  "type": "Stack",
  "direction": "vertical",
  "children": [
    { "type": "Text", "variant": "heading", "text": "$.wallName" },
    {
      "type": "KeyValueGrid",
      "rows": [
        { "label": "Fire Rating", "value": "$.fireRating" },
        { "label": "Storey", "value": "$.storey" },
        { "label": "Area (m²)", "value": "$.area" }
      ]
    },
    { "type": "Button", "label": "Refresh", "command": "ext.fire.refresh" }
  ]
}
```

**Handler (`src/triggers/on-select.js`):**

```js
export default async function onSelect(ctx) {
  const sel = await ctx.bim.viewer.getSelection();
  if (!sel.length) return null;
  const entity = await ctx.bim.query.get(sel[0]);
  const psets = await ctx.bim.query.propertySets(sel[0]);
  return {
    wallName: entity.name,
    fireRating: psets['Pset_WallCommon']?.FireRating ?? 'unknown',
    storey: entity.containedIn?.name ?? '—',
    area: psets['Qto_WallBaseQuantities']?.NetSideArea ?? '—',
  };
}
```

Capabilities required: `model.read`, `viewer.read`. No mutation, no
network. The review screen marks this green.

## 9. Migration path

We will not migrate any existing UI (HierarchyPanel, PropertiesPanel,
SearchModal, etc.) to the extension surface in v1. Those stay as host
code. The surface is for *new* user-contributed UI. Later, we may
re-implement some built-in features on top of the surface to validate
the API; if we do, the built-ins ship with the host, with an
inalienable capability set.

This is the same pattern VS Code follows — many built-in features are
"extensions" loaded by the editor at startup. It is a good
forcing-function for keeping the surface complete.
