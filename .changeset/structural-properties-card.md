---
"@ifc-lite/viewer": minor
---

The Structural Analysis card in Properties now shows every structural record, not only members (#9668): connections, actions and reactions, load groups and cases, result groups and the analysis model. Each attribute the read model carries is listed under its IFC EXPRESS name, with the unit the model declares for its measure. The records a selection holds follow as their own sections: an action's applied load and each value of a load configuration, a connection's boundary condition, and a member's ends with their applied and additional conditions, supported length and eccentricity.
