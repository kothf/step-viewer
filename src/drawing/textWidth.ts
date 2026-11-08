/** Advance widths of DejaVu Sans (the font every export embeds), in hundredths of the text height h (cap height, font size h / 0.72). */
const REG = [44,56,64,116,88,132,108,38,54,54,69,116,44,50,44,47,88,88,88,88,88,88,88,88,88,88,47,47,116,116,116,74,139,95,95,97,107,88,80,108,104,41,41,91,77,120,104,109,84,109,97,88,85,102,95,137,95,85,95,54,47,54,116,69,69,85,88,76,88,85,49,88,88,39,39,80,39,135,88,85,88,88,57,72,54,88,82,114,82,82,73,88,47,88,116];
const BOLD = [48,63,72,116,97,139,121,43,63,63,73,116,53,58,53,51,97,97,97,97,97,97,97,97,97,97,56,56,116,116,116,81,139,107,106,102,115,95,95,114,116,52,52,108,89,138,116,118,102,118,107,100,95,113,107,153,107,101,101,63,51,63,116,69,69,94,99,82,99,94,60,99,99,48,48,92,48,145,99,95,99,99,68,83,66,99,91,128,90,91,81,99,51,99,116];
const MORE: Record<string, [number, number]> = { "Ø": [109, 118], "°": [69, 69], "±": [116, 116], "×": [116, 116], "⌀": [84, 84], "◠": [116, 116] };

/** Width in mm of text `s` drawn `h` mm high (h = capital height, as text prims use it). Cyrillic and other letters not listed count as a wide average. */
export function textWidth(s: string, h: number, bold = false): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c < 127) w += (bold ? BOLD : REG)[c - 32];
    else if (MORE[ch]) w += MORE[ch][bold ? 1 : 0];
    else w += ch === ch.toLowerCase() ? (bold ? 95 : 86) : (bold ? 125 : 112);
  }
  return w * h / 100;
}
