// node:crypto, synchronous like Node's: hashes from @noble/hashes, AES (encrypt, CBC/ECB, as the
// PDF and ZIP protection code needs), randomBytes from the Web Crypto RNG.
import { Buffer } from 'buffer';
import { sha256, sha384, sha512, sha224 } from '@noble/hashes/sha2.js';
import { md5, sha1 } from '@noble/hashes/legacy.js';

const HASHES: Record<string, { create(): { update(b: Uint8Array): unknown; digest(): Uint8Array } }> = {
  sha256, sha384, sha512, sha224, md5, sha1,
};

export function createHash(alg: string) {
  const h = HASHES[alg.toLowerCase().replace('-', '')];
  if (!h) throw new Error(`Unsupported hash ${alg}`);
  const st = h.create();
  const api = {
    update(d: Uint8Array | string, enc?: BufferEncoding) {
      st.update(typeof d === 'string' ? Buffer.from(d, enc ?? 'utf8') : d);
      return api;
    },
    digest(enc?: BufferEncoding): any {
      const b = Buffer.from(st.digest());
      return enc ? b.toString(enc) : b;
    },
  };
  return api;
}

export function randomBytes(n: number) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
  return b;
}
export const randomUUID = () => crypto.randomUUID();
export const randomInt = (a: number, b?: number) => {
  const [lo, hi] = b === undefined ? [0, a] : [a, b];
  return lo + Math.floor(Math.random() * (hi - lo));
};

// ------------------------------------------------------------------ AES (FIPS-197), encrypt only

const SBOX = new Uint8Array(256);
(() => {
  // Build the S-box from the multiplicative inverse in GF(2^8).
  let p = 1;
  let q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
})();
const xt = (a: number) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;

function expandKey(key: Uint8Array): Uint8Array[] {
  const nk = key.length / 4;
  const nr = nk + 6;
  const w = new Uint8Array(16 * (nr + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = w.slice((i - 1) * 4, i * 4);
    if (i % nk === 0) {
      t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]);
      rcon = xt(rcon);
    } else if (nk > 6 && i % nk === 4) t = t.map((b) => SBOX[b]);
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j];
  }
  return Array.from({ length: nr + 1 }, (_, r) => w.subarray(r * 16, r * 16 + 16));
}

function encryptBlock(rk: Uint8Array[], inp: Uint8Array): Uint8Array {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = inp[i] ^ rk[0][i];
  const nr = rk.length - 1;
  for (let r = 1; r <= nr; r++) {
    // SubBytes + ShiftRows
    const t = new Uint8Array(16);
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) t[c * 4 + row] = SBOX[s[((c + row) % 4) * 4 + row]];
    // MixColumns (not in the last round)
    if (r < nr) {
      for (let c = 0; c < 4; c++) {
        const [a0, a1, a2, a3] = [t[c * 4], t[c * 4 + 1], t[c * 4 + 2], t[c * 4 + 3]];
        const all = a0 ^ a1 ^ a2 ^ a3;
        t[c * 4] = a0 ^ all ^ xt(a0 ^ a1);
        t[c * 4 + 1] = a1 ^ all ^ xt(a1 ^ a2);
        t[c * 4 + 2] = a2 ^ all ^ xt(a2 ^ a3);
        t[c * 4 + 3] = a3 ^ all ^ xt(a3 ^ a0);
      }
    }
    for (let i = 0; i < 16; i++) s[i] = t[i] ^ rk[r][i];
  }
  return s;
}

export function createCipheriv(alg: string, key: Uint8Array, iv: Uint8Array | null) {
  const m = /^aes-(128|192|256)-(cbc|ecb)$/i.exec(alg);
  if (!m) throw new Error(`Unsupported cipher ${alg}`);
  const rk = expandKey(new Uint8Array(key));
  const cbc = m[2].toLowerCase() === 'cbc';
  let prev: Uint8Array = cbc ? new Uint8Array(iv!) : new Uint8Array(16);
  let pad = true;
  let rest = new Uint8Array(0);
  const run = (data: Uint8Array) => {
    const n = data.length - (data.length % 16);
    const out = new Uint8Array(n);
    for (let o = 0; o < n; o += 16) {
      const blk = data.slice(o, o + 16);
      if (cbc) for (let i = 0; i < 16; i++) blk[i] ^= prev[i];
      const e = encryptBlock(rk, blk);
      out.set(e, o);
      prev = e;
    }
    rest = data.slice(n);
    return Buffer.from(out);
  };
  return {
    setAutoPadding(on: boolean) {
      pad = on;
      return this;
    },
    update(d: Uint8Array) {
      const all = new Uint8Array(rest.length + d.length);
      all.set(rest);
      all.set(d, rest.length);
      return run(all);
    },
    final() {
      if (!pad) {
        if (rest.length) throw new Error('wrong final block length');
        return Buffer.alloc(0);
      }
      const k = 16 - rest.length;
      const last = new Uint8Array(16);
      last.set(rest);
      last.fill(k, rest.length);
      return run(last);
    },
  };
}

export default { createHash, randomBytes, randomUUID, randomInt, createCipheriv };
