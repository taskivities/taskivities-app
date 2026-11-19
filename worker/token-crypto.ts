// AES-GCM with a key derived (HKDF) from some key material plus an `info` label that keeps each use's key apart.
// Used for the data key, wrapped with TOKEN_KEY, and everything sealed with the data key (worker/secrets.ts). Invite
// mailbox tokens saved before the data key existed were sealed straight from TOKEN_KEY or the provider's client secret;
// worker/mailbox.ts still reads those. (Gmail's derivation is the one the old Gmail-only code used, unchanged.)

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function deriveKey(material: string | undefined, info: string) {
  if (!material) return null;
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(material), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('taskivities'), info: new TextEncoder().encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealToken(material: string | undefined, info: string, plain: string) {
  const k = await deriveKey(material, info);
  if (!k) throw new Error('No encryption key');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(plain)));
  return `v1.${toB64(iv)}.${toB64(ct)}`;
}

/** The plain token, or null when it can't be read (no key, another key, or damaged). */
export async function openToken(material: string | undefined, info: string, stored: string): Promise<string | null> {
  try {
    const [v, iv, ct] = stored.split('.');
    const k = await deriveKey(material, info);
    if (v !== 'v1' || !k) return null;
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, k, fromB64(ct)));
  } catch {
    return null;
  }
}
