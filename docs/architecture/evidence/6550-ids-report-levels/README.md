# Compact IDS report: specification vs requirement (#6550)

Fixture: three specifications (Geschoss 2 requirements, Raum 3, Wand 1), compact layout, A4 portrait.
Numbers are the page layout `composeDocument` returns, which is exactly what the PDF drawing step prints
(positions in pt). They are not a rendered PDF.

Row-to-row y distance, in print order, before and after:

- before: `20,20,20,20,20,20,20,20` (a specification and a requirement are separated by the same pitch)
- after:  `20,20,26,20,20,20,26,20` (6 pt extra before each specification after the first)

Level styling, unchanged and already distinguishing the two levels in the PDF: specification x=40, size 9, bold, black;
requirement x=50, size 8, regular, gray 45.

Preview: the requirement rows now sit in a nested list (`data-ids-report-requirements`) inside their
specification group (`data-ids-report-spec`), indented with a left rule, and the specification row is semibold.
Before, the preview rendered every row in one flat list with no indent (the `nested` flag only changed text size).
