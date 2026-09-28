---
"@ifc-lite/viewer": patch
---

Editing geometry re-renders far less of the viewer (#6232). Resizing a wall now reaches the screen in under 50 ms at the median in a production build, down from about 72 ms. The layout shell, the hierarchy tree and its rows, the file and export commands, the ribbon and the Add Element panel no longer re-render when an element's mesh is rebuilt. A multi-slot geometry edit is one store update, and selection and storey offsets are no longer written back unchanged after every geometry update.
