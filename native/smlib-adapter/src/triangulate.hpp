// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <SmPoly.h>

// Retains SDK topology, source-face attribution and vertex coordinates.
SmStatus triangulate_polygon(SmPolyFace* polygon, SmTArray<SmPolyFace*>& added);
