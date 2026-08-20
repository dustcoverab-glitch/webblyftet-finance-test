function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function importKey(base64: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(base64);
  if (bytes.byteLength !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes.");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptString(value: string, keyBase64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(keyBase64);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value)
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptString(value: string, keyBase64: string): Promise<string> {
  const [iv64, payload64] = value.split(".");
  if (!iv64 || !payload64) throw new Error("Invalid encrypted token format.");
  const key = await importKey(keyBase64);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv64) },
    key,
    base64ToBytes(payload64)
  );
  return new TextDecoder().decode(decrypted);
}
