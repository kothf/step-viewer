// Structural and thermal analysis: the inner loops of the block factorisation (src/sim/blockchol.ts) with 128-bit
// SIMD. Built by `npm run build:cholwasm` into src/sim/cholKernel.wasm.ts (clang + wasm-ld, no libraries).
//
// The factor lives in the module's imported memory; `d` is where it starts and every other place is counted in
// doubles from there. Every value is one sum over q made the same way wherever it is computed: two lanes (even and
// odd q) added at the end, then the last q of an odd length. So a block made in pieces by several threads is the
// same as one made whole.
#include <wasm_simd128.h>
typedef double f64;

static inline f64 hsum(v128_t v) { return wasm_f64x2_extract_lane(v, 0) + wasm_f64x2_extract_lane(v, 1); }
static inline f64 dot(const f64 *x, const f64 *y, int n) {
  v128_t v = wasm_f64x2_const(0, 0);
  int q = 0;
  for (; q + 1 < n; q += 2) v = wasm_f64x2_add(v, wasm_f64x2_mul(wasm_v128_load(x + q), wasm_v128_load(y + q)));
  f64 s = hsum(v);
  if (q < n) s += x[q] * y[q];
  return s;
}

// T −= A Bᵀ: rows a0 .. mi of the block at `oi` (mk wide) against the mj rows of the block at `oj`, into the block
// at `to` (mj wide). On a diagonal block (`diag`) only the lower triangle is made.
__attribute__((export_name("update")))
void update(f64 *d, int mk, int mi, int mj, int oi, int oj, int to, int diag, int a0) {
  int a = a0;
  for (; a + 3 < mi; a += 4) {
    const f64 *A0 = d + oi + a * mk, *A1 = A0 + mk, *A2 = A1 + mk, *A3 = A2 + mk;
    f64 *T0 = d + to + a * mj, *T1 = T0 + mj, *T2 = T1 + mj, *T3 = T2 + mj;
    int bEnd = diag ? a : mj, b = 0;
    for (; b + 1 < bEnd; b += 2) {
      const f64 *B0 = d + oj + b * mk, *B1 = B0 + mk;
      v128_t s00 = wasm_f64x2_const(0, 0), s01 = s00, s10 = s00, s11 = s00, s20 = s00, s21 = s00, s30 = s00, s31 = s00;
      int q = 0;
      for (; q + 1 < mk; q += 2) {
        v128_t y0 = wasm_v128_load(B0 + q), y1 = wasm_v128_load(B1 + q);
        v128_t x0 = wasm_v128_load(A0 + q), x1 = wasm_v128_load(A1 + q), x2 = wasm_v128_load(A2 + q), x3 = wasm_v128_load(A3 + q);
        s00 = wasm_f64x2_add(s00, wasm_f64x2_mul(x0, y0)); s01 = wasm_f64x2_add(s01, wasm_f64x2_mul(x0, y1));
        s10 = wasm_f64x2_add(s10, wasm_f64x2_mul(x1, y0)); s11 = wasm_f64x2_add(s11, wasm_f64x2_mul(x1, y1));
        s20 = wasm_f64x2_add(s20, wasm_f64x2_mul(x2, y0)); s21 = wasm_f64x2_add(s21, wasm_f64x2_mul(x2, y1));
        s30 = wasm_f64x2_add(s30, wasm_f64x2_mul(x3, y0)); s31 = wasm_f64x2_add(s31, wasm_f64x2_mul(x3, y1));
      }
      f64 r00 = hsum(s00), r01 = hsum(s01), r10 = hsum(s10), r11 = hsum(s11), r20 = hsum(s20), r21 = hsum(s21), r30 = hsum(s30), r31 = hsum(s31);
      if (q < mk) {
        f64 y0 = B0[q], y1 = B1[q], x0 = A0[q], x1 = A1[q], x2 = A2[q], x3 = A3[q];
        r00 += x0 * y0; r01 += x0 * y1; r10 += x1 * y0; r11 += x1 * y1; r20 += x2 * y0; r21 += x2 * y1; r30 += x3 * y0; r31 += x3 * y1;
      }
      T0[b] -= r00; T0[b + 1] -= r01; T1[b] -= r10; T1[b + 1] -= r11; T2[b] -= r20; T2[b + 1] -= r21; T3[b] -= r30; T3[b + 1] -= r31;
    }
    for (; b < bEnd; b++) {
      const f64 *B0 = d + oj + b * mk;
      T0[b] -= dot(A0, B0, mk); T1[b] -= dot(A1, B0, mk); T2[b] -= dot(A2, B0, mk); T3[b] -= dot(A3, B0, mk);
    }
    if (diag) for (int r = 0; r < 4; r++) {
      const f64 *Ar = A0 + r * mk;
      f64 *Tr = T0 + r * mj;
      for (int c = a; c <= a + r; c++) Tr[c] -= dot(Ar, d + oj + c * mk, mk);
    }
  }
  for (; a < mi; a++) {
    const f64 *A0 = d + oi + a * mk;
    f64 *T0 = d + to + a * mj;
    int bEnd = diag ? a + 1 : mj;
    for (int b = 0; b < bEnd; b++) T0[b] -= dot(A0, d + oj + b * mk, mk);
  }
}

// The mi rows of the block at `o` ← block · L⁻ᵀ, L the factored diagonal block at `dg` (both mk wide).
__attribute__((export_name("solve")))
void solve(f64 *d, int mk, int mi, int dg, int o) {
  for (int a = 0; a < mi; a++) {
    f64 *R = d + o + a * mk;
    for (int c = 0; c < mk; c++) {
      const f64 *C = d + dg + c * mk;
      R[c] = (R[c] - dot(R, C, c)) / C[c];
    }
  }
}

// Cholesky of the m × m block at `o` in place (lower triangle). Returns 0, or 1 + the row whose pivot is not positive.
__attribute__((export_name("diag")))
int diag(f64 *d, int m, int o) {
  for (int r = 0; r < m; r++) {
    f64 *R = d + o + r * m;
    for (int c = 0; c < r; c++) {
      const f64 *C = d + o + c * m;
      R[c] = (R[c] - dot(R, C, c)) / C[c];
    }
    f64 s = R[r] - dot(R, R, r);
    if (!(s > 0)) return r + 1;
    R[r] = __builtin_sqrt(s);
  }
  return 0;
}
