// Work shared out to helper workers. The solver itself runs in one worker (`sim.worker.ts`) and is
// synchronous; what can be done ahead and apart goes through a `ParPool`: today the cells of the grid
// (each cut against the body on its own). The same messages are answered by `parHandle` in a browser
// worker (`par.worker.ts`) and in a node worker thread (benches), so a pool is only a way to carry them.

import { MeshBody, insideOf } from "./body";
import { cellFine, gridFrame, type CellPrep, type Prepared } from "./grid";
import { Points, type Inside } from "./quad";

export type ParMsg =
  | { type: "bodies"; tris: Float64Array[] }
  | { type: "cells"; dom: number; lo0: number[]; h: number; n: number[]; depth: number; leafQ: number; a: number; b: number };
export interface CellsReply { dom: number; a: number; st: Int8Array; cnt: Int32Array; pts: Float64Array }

/** Carries messages to helper workers: `all` to every one (kept data), `map` shares jobs out and gives the replies in order. */
export interface ParPool {
  size: number;
  all(msg: ParMsg): Promise<void>;
  map(jobs: ParMsg[]): Promise<unknown[]>;
}

/** A helper's kept data. */
export interface ParState { insides: Inside[] }
export const parState = (): ParState => ({ insides: [] });

/** Answers one message in a helper: the reply and the buffers to hand over. */
export function parHandle(S: ParState, m: ParMsg): { reply: unknown; transfer: ArrayBuffer[] } {
  if (m.type === "bodies") { S.insides = m.tris.map(t => insideOf(new MeshBody(t))); return { reply: null, transfer: [] }; }
  const { n, lo0, h } = m, inside = S.insides[m.dom], N = m.b - m.a;
  const st = new Int8Array(N), cnt = new Int32Array(N), all = new Points();
  for (let at = m.a; at < m.b; at++) {
    const i = at % n[0], j = Math.floor(at / n[0]) % n[1], k = Math.floor(at / (n[0] * n[1]));
    const clo = [lo0[0] + i * h, lo0[1] + j * h, lo0[2] + k * h], chi = [clo[0] + h, clo[1] + h, clo[2] + h];
    const cf = cellFine(clo, chi, inside, m.depth, m.leafQ);
    if (!cf) continue;
    st[at - m.a] = cf.st;
    if (cf.fine) { cnt[at - m.a] = cf.fine.n; const A = cf.fine.a; for (let q = 0; q < cf.fine.n; q++) all.push(A[4 * q], A[4 * q + 1], A[4 * q + 2], A[4 * q + 3]); }
  }
  const pts = all.a.slice(0, 4 * all.n), reply: CellsReply = { dom: m.dom, a: m.a, st, cnt, pts };
  return { reply, transfer: [st.buffer, cnt.buffer, pts.buffer] };
}

/** The cells of the grid over `lo`..`hi` for each body of `tris`, cut by the pool's helpers. */
export async function prepareCells(pool: ParPool, tris: Float64Array[], lo: number[], hi: number[], h: number, depth = 3, leafQ = 3): Promise<Prepared> {
  const { n, lo0 } = gridFrame(lo, hi, h), total = n[0] * n[1] * n[2];
  await pool.all({ type: "bodies", tris });
  // small jobs, so a helper that got the cut cells does not hold the others up
  const step = Math.max(1, Math.ceil(total / (pool.size * 12))), jobs: ParMsg[] = [];
  for (let dom = 0; dom < tris.length; dom++) for (let a = 0; a < total; a += step) jobs.push({ type: "cells", dom, lo0, h, n, depth, leafQ, a, b: Math.min(total, a + step) });
  const cells: (CellPrep | null | undefined)[][] = tris.map(() => new Array(total).fill(null));
  for (const r of (await pool.map(jobs)) as CellsReply[]) {
    let o = 0;
    for (let i = 0; i < r.st.length; i++) {
      if (!r.st[i]) continue;
      let fine: Points | null = null;
      if (r.st[i] !== 1) { fine = new Points(); fine.a = r.pts.slice(o, o + 4 * r.cnt[i]); fine.n = r.cnt[i]; o += 4 * r.cnt[i]; if (!fine.a.length) fine.a = new Float64Array(4); }
      cells[r.dom][r.a + i] = { st: r.st[i], fine };
    }
  }
  return { lo0, h, n, depth, leafQ, cells };
}
