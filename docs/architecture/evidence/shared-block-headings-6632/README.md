# Shared block headings (#6632)

`headings.pdf` / `headings-page-1.png` (rasterised with `pdftoppm -r 80`) is the document composer's real output, drawn with jsPDF through the same `generateDocumentPdf` the viewer calls. Only the table body is replaced by plain text rows, because autotable is not what is being shown. The preview was not screenshotted from a running viewer; it is covered by mounted-DOM tests (`DocumentPanel.blockHeading.test.tsx`) that read the computed size, ink and background of each kind's heading.

What the page shows, top to bottom, all with the same three fields (`titleFontSize`, `titleTextColor`, `titleBackgroundColor`):

| Block | Fields set | Printed heading |
| --- | --- | --- |
| Text | none | default 11 pt bold, no strip |
| Text | 16 pt, dark blue background | white ink, chosen by contrast because no ink was authored |
| IDS report | 20 pt, own dark-brown ink, warm background | strip 29.09 pt tall |
| Manual validation report | 16 pt, dark blue background | white ink, strip 23.27 pt |
| Table | 20 pt, own ink, warm background | strip 29.09 pt |
| IDS report at block size 150 % | 20 pt, own ink, warm background | heading and strip 1.5 times larger; truncated to the block's width |

Strip height is `16 + (size - 11) * 16 / 11` points (the default heading strip plus the extra a larger heading adds); the block below moves down by exactly that extra.
