// Vault user accounts (FR-PDM-037): names, roles and salted PBKDF2-SHA-256 password hashes kept in the vault's
// own vault.json, so a folder vault on a shared or synced drive needs no server. It is a check inside the app,
// not encryption: whoever can read the vault folder can read its files.
import type { Role } from "./workflow";

export interface Account {
  name: string;
  /** Base64 salt and PBKDF2-SHA-256 hash of the password. */
  salt: string; hash: string; iter: number;
  roles: Role[];
  disabled?: boolean;
  /** Set by an Admin's reset: the user picks a new password at the next log in. */
  reset?: boolean;
  created: string;
}

export const PASSWORD_MIN = 6;
const ITERATIONS = 150_000;

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function derive(pw: string, salt: Uint8Array, iter: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw) as BufferSource, "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iter }, key, 256));
}

/** A salted hash of the password (a fresh salt each time). */
export async function hashPassword(pw: string): Promise<Pick<Account, "salt" | "hash" | "iter">> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), hash: b64(await derive(pw, salt, ITERATIONS)), iter: ITERATIONS };
}

/** Whether the password matches the account (constant-time compare of the hashes). */
export async function checkPassword(a: Pick<Account, "salt" | "hash" | "iter">, pw: string): Promise<boolean> {
  const got = await derive(pw, unb64(a.salt), a.iter), want = unb64(a.hash);
  if (got.length !== want.length) return false;
  let d = 0;
  for (let i = 0; i < got.length; i++) d |= got[i] ^ want[i];
  return d === 0;
}

/** Account names compare without case and outer spaces. */
export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
