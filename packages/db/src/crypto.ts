import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function checkKey(masterKey: Uint8Array): void {
  if (!(masterKey instanceof Uint8Array) || masterKey.length !== KEY_BYTES) {
    throw new RangeError(`the master key must be ${KEY_BYTES} bytes`);
  }
}

// The version and the caller's context are authenticated along with the
// ciphertext: an envelope copied into another row does not open there.
const associatedData = (context: string) => Buffer.from(`${VERSION}\n${context}`, 'utf8');

function decodeSegment(text: string, bytes: number | null): Buffer {
  const decoded = Buffer.from(text, 'base64url');
  // Node skips characters it cannot decode; an envelope must be exactly what was written.
  if (decoded.toString('base64url') !== text || (bytes !== null && decoded.length !== bytes)) {
    throw new Error('malformed secret envelope');
  }
  return decoded;
}

/**
 * Seal a secret with AES-256-GCM. The result is `v1.<nonce>.<tag>.<ciphertext>`
 * in base64url, safe to keep in a text column.
 *
 * `context` names where the secret lives (say, the organisation and the kind
 * of key); the same string has to be given to open it again.
 */
export function encryptSecret(plaintext: string, masterKey: Uint8Array, context = ''): string {
  checkKey(masterKey);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, ...[nonce, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url'))].join('.');
}

/** Open an envelope. Throws on a wrong key, a wrong context or any change to the envelope. */
export function decryptSecret(envelope: string, masterKey: Uint8Array, context = ''): string {
  checkKey(masterKey);
  const [version, nonceText, tagText, ciphertextText, ...rest] = envelope.split('.');
  if (version === undefined || nonceText === undefined || tagText === undefined || ciphertextText === undefined || rest.length > 0) {
    throw new Error('malformed secret envelope');
  }
  if (version !== VERSION) throw new Error(`unsupported secret envelope version ${version}`);

  const decipher = createDecipheriv('aes-256-gcm', masterKey, decodeSegment(nonceText, NONCE_BYTES), { authTagLength: TAG_BYTES });
  decipher.setAAD(associatedData(context));
  decipher.setAuthTag(decodeSegment(tagText, TAG_BYTES));
  const ciphertext = decodeSegment(ciphertextText, null);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('the secret could not be decrypted: wrong key or altered envelope');
  }
}

/** Read a master key written as 64 hex characters or as base64. */
export function parseMasterKey(text: string): Uint8Array {
  const trimmed = text.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) throw new RangeError(`the master key must be ${KEY_BYTES} bytes, written as hex or base64`);
  return new Uint8Array(key);
}
