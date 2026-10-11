import { redactViewingKeys } from '@holdfast/zcash';

/** Turns text that may quote a secret into text that is safe to show or log. */
export type Redactor = (text: string) => string;

const PLACEHOLDER = '[redacted]';
/** Shorter than this and a "secret" is more likely an ordinary word than something worth hiding. */
const MIN_SECRET_LENGTH = 8;

/**
 * Removes viewing keys, by their shape, and every configured secret, by its
 * value. An error from an adapter may quote the URL it called or the input it
 * was given; this is what stands between such a message and a response or a
 * log line.
 */
export function createRedactor(secrets: () => readonly string[]): Redactor {
  return (text) => {
    let safe = redactViewingKeys(text);
    // Longest first, so that a secret containing another is replaced whole.
    const known = [...new Set(secrets())].filter((secret) => secret.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
    for (const secret of known) safe = safe.split(secret).join(PLACEHOLDER);
    return safe;
  };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
