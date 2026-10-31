// Message encryption for the phone remote; must match src-tauri/src/remote.rs:
//   frame     = nonce (24 bytes) | XChaCha20-Poly1305 ciphertext
//   plaintext = direction (1 byte) | counter (u64 big-endian) | JSON
// WebCrypto isn't available on plain-HTTP LAN pages, hence @noble/ciphers.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

export const TO_PHONE = 0x53; // 'S'
export const FROM_PHONE = 0x50; // 'P'
const NONCE_LEN = 24;
const HEADER_LEN = 9;

export function parseKey(b64url: string): Uint8Array | null {
  try {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const key = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function seal(key: Uint8Array, direction: number, counter: bigint, msg: Uint8Array): Uint8Array<ArrayBuffer> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const plain = new Uint8Array(HEADER_LEN + msg.length);
  plain[0] = direction;
  new DataView(plain.buffer).setBigUint64(1, counter, false);
  plain.set(msg, HEADER_LEN);
  const sealed = xchacha20poly1305(key, nonce).encrypt(plain);
  const frame = new Uint8Array(NONCE_LEN + sealed.length);
  frame.set(nonce);
  frame.set(sealed, NONCE_LEN);
  return frame;
}

// null = wrong key, tampered, or not meant for this direction.
export function open(key: Uint8Array, direction: number, frame: Uint8Array): { counter: bigint; msg: Uint8Array } | null {
  if (frame.length < NONCE_LEN + HEADER_LEN + 16) return null;
  try {
    const plain = xchacha20poly1305(key, frame.subarray(0, NONCE_LEN)).decrypt(frame.subarray(NONCE_LEN));
    if (plain[0] !== direction) return null;
    const counter = new DataView(plain.buffer, plain.byteOffset).getBigUint64(1, false);
    return { counter, msg: plain.subarray(HEADER_LEN) };
  } catch {
    return null;
  }
}
