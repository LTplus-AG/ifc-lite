// SPDX-License-Identifier: MPL-2.0
// The root node-test CI sweep invokes the generator drift gate.
import test from 'node:test';
import { check } from './retained-native-contract/generate.mjs';
test('#7955 native diagnostic projection matches its authoritative extension', check);
