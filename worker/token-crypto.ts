// Encrypting stored refresh tokens (Gmail in google_tokens, Outlook in microsoft_tokens) with AES-GCM.
// The key is derived (HKDF) from TOKEN_KEY when set, otherwise from the provider's own client secret, so there's nothing
// extra to set up. Changing that material just makes the stored tokens unreadable: admins connect again.

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

/** `info` keeps each provider's key separate even when they share TOKEN_KEY. */
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
