---
"@ifc-lite/viewer": patch
---

Icon-only buttons now have accessible names and keyboard-visible tooltips (#5811). A new `IconButton` primitive requires a label, sets it as the button's `aria-label`, and shows it as a tooltip on hover and on keyboard focus. 148 icon buttons across the Properties, Property editor, AI chat, Script, IDS, Lists, BCF, Zones, Schedule, Clash, Extensions and other panels now use it. Among them are buttons a screen reader previously announced only as "button": close AI chat, scroll to latest message, copy GlobalId, save attribute, remove mapping, close location zones, and remove title-block field or revision. Buttons that were named only by `title=` now show their tooltip on focus as well.
