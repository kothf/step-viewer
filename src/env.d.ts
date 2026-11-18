/// <reference types="vite/client" />
declare const __APP_VERSION__: string;
/** A hash of the sources and locked packages (vite.config.ts): keys the disk cache of built geometry. */
declare const __BUILD_ID__: string;
declare module "three/examples/jsm/libs/opentype.module.js" {
  interface PathCommand { type: "M" | "L" | "Q" | "C" | "Z"; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }
  interface Font { unitsPerEm: number; tables: { os2?: { sCapHeight?: number } }; getPath(text: string, x: number, y: number, size: number, opts?: { kerning?: boolean }): { commands: PathCommand[] } }
  export function parse(buf: ArrayBuffer): Font;
}
