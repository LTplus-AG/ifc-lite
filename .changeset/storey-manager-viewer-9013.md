---
"@ifc-lite/viewer": minor
---

The Model workspace can author storeys (#9013). The storey chip and the plan's storey picker gain **Add storey above**, which adds a storey with the neighbours' naming and spacing and makes it the one you draw on, and **Manage storeys…**. The manager lists storeys highest first, with name, elevation, floor-to-floor height and element count. Each value is edited in place: Enter applies and Escape cancels. Elevation and floor-to-floor edits preview in 3D and the plan with an impact summary, and apply as one undo step. Deleting a storey that holds elements asks whether to move them or delete them. The Wall tool and inspector gain **Top: To storey above / Fixed height**; attached walls follow the storey above when storeys are re-levelled. New storeys appear in the hierarchy straight away, and level display reads live storey elevations.
