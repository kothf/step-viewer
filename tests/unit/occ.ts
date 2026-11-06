// Loads the full OpenCASCADE build once for the kernel tests.
// @ts-expect-error no types for the node entry
import init from "opencascade.js/dist/node.js";

let oc: Promise<unknown> | null = null;
export function occ(): Promise<any> { return (oc ??= init()); }
