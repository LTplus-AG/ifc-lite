# Cutting Planes

The viewer's **Section** tool cuts the model with up to eight planes at once. What stays on screen is what *every* cutting plane keeps, so two planes carve a wedge, three a corner, and so on. Every plane is named (A, B, C, or a name you give it), and each can be moved, flipped, shown or hidden on its own.

## The bar

Open **Section** from the ribbon. The bar has two rows:

- **Row 1 says which planes exist.** One chip per plane (the filled one is active; a filled dot means the plane is cutting, a hollow one that it is only a preview), a **⋯** menu for the selected plane (Rename, Cut, Show plane, Duplicate, Remove, Clear all), **Add plane**, **Views** and Close. With no plane yet the bar offers the four ways to start: Down, Front, Side or a picked Face.
- **Row 2 edits the active plane** and never needs to say which plane it means.

Remove and Clear all offer **Undo** for a few seconds: it gives back the planes that were removed and keeps whatever you did since. Planes are listed in the order you made them. Add is disabled at eight planes, with the reason in its tooltip.

## Placing a plane

- **Offset** is the distance of the plane, in the project's own length unit, to the millimetre. A face-picked plane reads from its face (a fresh pick is `0.000`; negative goes into the solid), a level plane reads its elevation. Type a value, drag it, use `−` / `+`, the arrow keys, or the **mouse wheel** over the field: one notch is one step.
- **Step** (the `10 cm ▾` control) is how far one notch, key or click moves the plane: 1 cm to 1 m, or a value in millimetres. It is remembered between sessions.
- **Direction** (in the plane's `⋯` menu) changes what the selected plane is, keeping its name and place: Down, Front, Side, or **Face…** to pick a face again.
- **Flip** keeps the other side. The arrow on the plane in the scene points to the side that stays.
- **Set view** looks straight onto the plane from the kept side and remembers where you were, so pressing it again takes you back.
- **Show** draws or hides the plane's marker in the scene without changing the cut; a plane that is not cutting still previews.

Planes tell themselves apart by state, never by colour: the active plane's tag is filled, the others are plain, a plane that is not cutting is hollow.

## Cut surface

**Fill** switches the hatch on the cut surface on and off (turning it on again brings back the last hatch). **Cap** sets the colour and pattern; the look is one preference shared by every plane, and each plane that is cutting draws its own cap, so the cut surface is closed wherever a plane meets the model.

## Zoom

**Zoom** frames the selection, the **cut area** (the model as the planes leave it) or the whole model, with a margin you state: a percentage of the target's largest extent on each side, or a length in metres. With a 10 % margin the target fills exactly 1 / 1.2 of the limiting dimension of the frame in an orthographic view (a perspective view is within a few percent, because nearer corners project larger). The last choice is remembered.

## Views

**Views** keeps the cutting planes (with names and which one is active), the zoom and the exact camera under a name. Applying a view **replaces every plane**, shows the cut and puts the camera back. The Drawing panel's header menu lists the same views.

## Elsewhere

- **2D section** opens the Drawing for the *active* plane. Its cap is drawn from that drawing; the other planes' caps are cut separately from the same visible elements, so hidden elements and isolation behave the same for every plane.
- **PDF export of the view** is cut by every cutting plane, and each plane's heavy cut line stops where another plane removes the model.
- **Basket views** remember every cutting plane; a basket view with no cut turns all of them off.
- **BCF**: a viewpoint exports one clipping plane per cutting plane and applying one replaces the whole set. BCF has no slot for names, so planes come back as A, B, C. A viewpoint with more than eight planes shows the first eight and says so. A **section box** has no plane to export and is left out.
- **SDK**: `bim.viewer.getSections()`, `setSections()`, `addSection()` and `removeSection(id)`. `getSection()` reports the active plane, and `setSection()` / `clearSection()` stay what they were: a cut handed over from outside is *the* cut, so they replace or clear every plane. A backend that clips with one plane keeps working through the same methods. See [BCF Collaboration](bcf.md) and [Rendering](rendering.md#several-cutting-planes) for the data side.

## Limits

- Eight planes (the renderer clips against the primary plane plus seven more). A box cut uses the one box slot, and a switched-off box does not hold it against one that is cutting.
- Inactive planes place their percentage against the renderer's own model bounds and the active plane against the Section range; for an ordinary model they are the same range.
- There are no keyboard shortcuts for stepping between planes yet; the chips are tabs (arrow keys move, F2 renames, Delete removes).
- Caps are cut from the model's meshes on the CPU, one plane at a time; with many planes on a very large model the caps of the planes you are not editing arrive a moment after the clip itself.
