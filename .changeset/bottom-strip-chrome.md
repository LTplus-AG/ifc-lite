---
"@ifc-lite/viewer": patch
---

The bottom strip (Script, Schedule, Lists, Charts, Document, Flow, Drawing) now has its own header instead of each panel drawing its own title and close row (#5498). A tab row shows every bottom panel opened this session — the active tab still follows the existing mutually-exclusive dock flag — alongside the detach grip, a maximize control that fills the viewport region (restore returns to the resizable dock), and a single Close. Script's script selector and AI-chat toggle, Schedule's playback toolbar, Lists' Settings, Charts' and Document's toolbars, Flow's run/save/publish row, and Drawing's Regenerate/Export stay in each panel's own slim action row; only the redundant title/close chrome moved out. The strip's resize height and its opened tabs persist across a reload.
