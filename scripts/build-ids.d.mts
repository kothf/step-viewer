/** `{ all, <kind>: id }`: hashes of the code that builds each kind of disk cache entry (`all` = every source). */
export function buildIds(): Record<string, string>;
/** Every file reachable by import from `entries`, sorted. */
export function moduleGraph(entries: string[]): string[];
/** Entry files per cache kind. */
export const KINDS: Record<string, string[]>;
