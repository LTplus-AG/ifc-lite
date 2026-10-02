# Compact IDS report, specifications only (#6560)

Same report, A4 portrait, compact layout, before (full) and after (Specifications only). Numbers are the
page layout `composeDocument` returns, which is what the PDF drawing step prints; they are not a rendered PDF.
"rows" counts printed specification and requirement name rows.

| report                         | full compact        | specifications only |
| ------------------------------ | ------------------- | ------------------- |
| 10 specs x 20 requirements     | 7 pages, 210 rows   | 1 page, 10 rows     |
| 2 specs x 63 requirements      | 4 pages, 128 rows   | 1 page, 2 rows      |
| 20 specs x 40 requirements     | 24 pages, 820 rows  | 1 page, 20 rows     |

Each specification row keeps its own bar and `passed/checked · n%`. The preview renders only the specification rows.
