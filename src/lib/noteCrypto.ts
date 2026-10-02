/** Local AES-GCM note encryption (passphrase never persisted). */

const te = new TextEncoder();
const td = new TextDecoder();

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const CHUNK_SIZE = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    chunks.push(
      String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, i + CHUNK_SIZE)),
      ),
    );
  }
  return btoa(chunks.join(""));
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", te.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 210_000,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export const ENC_MAGIC = "MARKELLE_ENC_V1";

export interface EncryptedBlob {
  v: 1;
  magic: typeof ENC_MAGIC;
  salt: string;
  iv: string;
  ct: string;
}

export function isEncryptedNote(source: string): boolean {
  const t = source.trim();
  if (!t.startsWith("{")) return false;
  try {
    const j = JSON.parse(t) as EncryptedBlob;
    return j?.magic === ENC_MAGIC && j.v === 1;
  } catch {
    return false;
  }
}

export async function encryptNote(plaintext: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    te.encode(plaintext),
  );
  const blob: EncryptedBlob = {
    v: 1,
    magic: ENC_MAGIC,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(ct),
  };
  return `${JSON.stringify(blob, null, 2)}\n`;
}

export async function decryptNote(source: string, passphrase: string): Promise<string> {
  const j = JSON.parse(source.trim()) as EncryptedBlob;
  if (j.magic !== ENC_MAGIC || j.v !== 1) throw new Error("不是 Markelle 加密笔记");
  const salt = fromB64(j.salt);
  const iv = fromB64(j.iv);
  const key = await deriveKey(passphrase, salt);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    fromB64(j.ct) as BufferSource,
  );
  return td.decode(pt);
}
