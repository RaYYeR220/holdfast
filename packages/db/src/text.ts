/**
 * What a JS string can carry and Postgres cannot store: U+0000, and half of
 * a surrogate pair on its own.
 */
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const EVERY_UNSTORABLE = new RegExp(UNSTORABLE.source, 'g');
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

export const isStorableText = (text: string): boolean => !UNSTORABLE.test(text);

/** The same text with U+FFFD wherever it held something Postgres cannot store. */
export const toStorableText = (text: string): string => text.replace(EVERY_UNSTORABLE, REPLACEMENT_CHARACTER);
