import type { Plugin } from "vite";
export type CreditExtra = { dir?: string; entry?: Record<string, string>; files?: string[]; note?: string };
export default function credits(opts?: { extra?: CreditExtra[]; overrides?: Record<string, Record<string, string>> }): Plugin;
