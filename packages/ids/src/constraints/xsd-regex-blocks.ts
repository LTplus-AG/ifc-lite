/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Unicode blocks an XSD `\p{IsName}` / `\P{IsName}` block escape may
 * name: XML Schema Part 2, Appendix F.1.1 (the Unicode 3.1 `Blocks.txt`
 * list, with its ranges). JS regex has no block escapes, so the translator
 * replaces each with the code-point range(s) below.
 *
 * Packed as `Name start end` triples (hex code points). `PrivateUse` and
 * `Specials` appear more than once in the spec's table; every range listed
 * for a name belongs to that name's block escape.
 */
const PACKED = `
BasicLatin 0 7F|Latin-1Supplement 80 FF|LatinExtended-A 100 17F|LatinExtended-B 180 24F
IPAExtensions 250 2AF|SpacingModifierLetters 2B0 2FF|CombiningDiacriticalMarks 300 36F
Greek 370 3FF|Cyrillic 400 4FF|Armenian 530 58F|Hebrew 590 5FF|Arabic 600 6FF|Syriac 700 74F
Thaana 780 7BF|Devanagari 900 97F|Bengali 980 9FF|Gurmukhi A00 A7F|Gujarati A80 AFF
Oriya B00 B7F|Tamil B80 BFF|Telugu C00 C7F|Kannada C80 CFF|Malayalam D00 D7F|Sinhala D80 DFF
Thai E00 E7F|Lao E80 EFF|Tibetan F00 FFF|Myanmar 1000 109F|Georgian 10A0 10FF
HangulJamo 1100 11FF|Ethiopic 1200 137F|Cherokee 13A0 13FF
UnifiedCanadianAboriginalSyllabics 1400 167F|Ogham 1680 169F|Runic 16A0 16FF|Khmer 1780 17FF
Mongolian 1800 18AF|LatinExtendedAdditional 1E00 1EFF|GreekExtended 1F00 1FFF
GeneralPunctuation 2000 206F|SuperscriptsandSubscripts 2070 209F|CurrencySymbols 20A0 20CF
CombiningMarksforSymbols 20D0 20FF|LetterlikeSymbols 2100 214F|NumberForms 2150 218F
Arrows 2190 21FF|MathematicalOperators 2200 22FF|MiscellaneousTechnical 2300 23FF
ControlPictures 2400 243F|OpticalCharacterRecognition 2440 245F
EnclosedAlphanumerics 2460 24FF|BoxDrawing 2500 257F|BlockElements 2580 259F
GeometricShapes 25A0 25FF|MiscellaneousSymbols 2600 26FF|Dingbats 2700 27BF
BraillePatterns 2800 28FF|CJKRadicalsSupplement 2E80 2EFF|KangxiRadicals 2F00 2FDF
IdeographicDescriptionCharacters 2FF0 2FFF|CJKSymbolsandPunctuation 3000 303F
Hiragana 3040 309F|Katakana 30A0 30FF|Bopomofo 3100 312F|HangulCompatibilityJamo 3130 318F
Kanbun 3190 319F|BopomofoExtended 31A0 31BF|EnclosedCJKLettersandMonths 3200 32FF
CJKCompatibility 3300 33FF|CJKUnifiedIdeographsExtensionA 3400 4DB5
CJKUnifiedIdeographs 4E00 9FFF|YiSyllables A000 A48F|YiRadicals A490 A4CF
HangulSyllables AC00 D7A3|HighSurrogates D800 DB7F|HighPrivateUseSurrogates DB80 DBFF
LowSurrogates DC00 DFFF|PrivateUse E000 F8FF|CJKCompatibilityIdeographs F900 FAFF
AlphabeticPresentationForms FB00 FB4F|ArabicPresentationForms-A FB50 FDFF
CombiningHalfMarks FE20 FE2F|CJKCompatibilityForms FE30 FE4F|SmallFormVariants FE50 FE6F
ArabicPresentationForms-B FE70 FEFE|Specials FEFF FEFF|HalfwidthandFullwidthForms FF00 FFEF
Specials FFF0 FFFD|OldItalic 10300 1032F|Gothic 10330 1034F|Deseret 10400 1044F
ByzantineMusicalSymbols 1D000 1D0FF|MusicalSymbols 1D100 1D1FF
MathematicalAlphanumericSymbols 1D400 1D7FF|CJKUnifiedIdeographsExtensionB 20000 2A6D6
CJKCompatibilityIdeographsSupplement 2F800 2FA1F|Tags E0000 E007F
PrivateUse F0000 FFFFD|PrivateUse 100000 10FFFD`;

/** JS class-escape spelling of one code point, valid under the `u` flag. */
function codePointEscape(cp: number): string {
  const hex = cp.toString(16).toUpperCase();
  return cp <= 0xffff ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
}

let blockMembers: Map<string, string> | undefined;

/**
 * The class members (`\u0000-\u007F`, ready to splice inside `[ … ]`) for
 * an XSD block name without its `Is` prefix, or `undefined` when XSD
 * defines no such block.
 */
export function xsdBlockClassMembers(name: string): string | undefined {
  if (!blockMembers) {
    blockMembers = new Map();
    for (const entry of PACKED.trim().split(/[|\n]/)) {
      const [block, start, end] = entry.split(' ');
      const range = `${codePointEscape(parseInt(start, 16))}-${codePointEscape(parseInt(end, 16))}`;
      blockMembers.set(block, (blockMembers.get(block) ?? '') + range);
    }
  }
  return blockMembers.get(name);
}
