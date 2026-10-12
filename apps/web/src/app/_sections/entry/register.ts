/**
 * Registering an organisation, as far as the page decides anything: whether
 * what was pasted into the viewing key field has the shape of a secret, and
 * the form's text read into what the server takes. Whether a key is a valid
 * viewing key is the server's to say; this only stops a spending key or a
 * seed phrase before it leaves the browser.
 */

export type KeyShape =
  /** Nothing was pasted. */
  | 'empty'
  /** A spending key or a seed phrase, by its shape: it is not sent anywhere. */
  | 'secret'
  /** Not a secret by its shape. The server checks that it is a viewing key of the right network. */
  | 'plausible';

/** The prefixes of Zcash spending keys, and of the old extended viewing keys that carry more than a viewing key should. */
const SECRET_PREFIX = /^(secret-extended-key|uskprivate|zxviews?secret)/i;

/**
 * The shape of what was pasted where a viewing key belongs. A viewing key is
 * one unbroken word; anything with a gap in it is a phrase.
 */
export function keyShape(pasted: string): KeyShape {
  const key = pasted.trim();
  if (key === '') return 'empty';
  return SECRET_PREFIX.test(key) || /\s/.test(key) ? 'secret' : 'plausible';
}

export interface RegistrationText {
  name: string;
  birthday: string;
  /** Dollars a month; empty for none. */
  monthlyBurn: string;
}

export interface Registration {
  name: string;
  ufvk: string;
  birthday: number;
  monthlyBurnUsd: number | null;
}

export type RegistrationErrors = Partial<Record<'name' | 'ufvk' | 'birthday' | 'monthlyBurn', string>>;

export type RegistrationReading =
  | { ok: true; body: Registration }
  /** `secret` is set when the key field held a spending key or a seed phrase: the page then clears the field. */
  | { ok: false; errors: RegistrationErrors; secret: boolean };

const MAX_NAME = 120;
const MAX_BIRTHDAY = 100_000_000;
const MAX_BURN = 1e12;

export const SECRET_REFUSAL = 'That has the shape of a spending key or a seed phrase, not of a viewing key. It was not sent anywhere and the field has been cleared. Holdfast never asks for either.';

/** The form as the body of the request, or what is wrong with it, field by field. */
export function readRegistration(text: RegistrationText, pastedKey: string): RegistrationReading {
  const errors: RegistrationErrors = {};

  const name = text.name.trim();
  if (name === '') errors.name = 'A name is needed: it is how the organisation is shown to you and on receipts.';
  else if (name.length > MAX_NAME) errors.name = `At most ${MAX_NAME} characters.`;

  const shape = keyShape(pastedKey);
  if (shape === 'empty') errors.ufvk = 'Paste the unified full viewing key of the treasury.';
  else if (shape === 'secret') errors.ufvk = SECRET_REFUSAL;

  const birthdayText = text.birthday.trim().replace(/[,\s]/g, '');
  let birthday = 0;
  if (birthdayText === '') errors.birthday = 'The birthday height is needed: the scan has to start somewhere.';
  else if (!/^\d+$/.test(birthdayText)) errors.birthday = 'A block height is a whole number, such as 3512987.';
  else {
    birthday = Number(birthdayText);
    if (birthday < 1 || birthday > MAX_BIRTHDAY) errors.birthday = 'That is not a block height.';
  }

  const burnText = text.monthlyBurn.trim().replace(/[,$\s]/g, '');
  let monthlyBurnUsd: number | null = null;
  if (burnText !== '') {
    if (!/^\d+(\.\d{1,2})?$/.test(burnText)) errors.monthlyBurn = 'Dollars a month as a plain number, such as 42500.';
    else {
      monthlyBurnUsd = Number(burnText);
      if (monthlyBurnUsd > MAX_BURN) errors.monthlyBurn = 'That is more than this field takes.';
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, secret: shape === 'secret' };
  return { ok: true, body: { name, ufvk: pastedKey.trim(), birthday, monthlyBurnUsd } };
}

/** Blocks left between a suggested birthday and the chain's height: about two hours of blocks. */
export const BIRTHDAY_MARGIN = 100;

/** A birthday for a wallet that has received nothing yet: the chain's height now, less a margin. */
export function suggestedBirthday(tipHeight: number): number {
  return Math.max(1, tipHeight - BIRTHDAY_MARGIN);
}

/** Whether the server refused the form because of the viewing key. Its message then says why, and names no key. */
export function isKeyRefusal(error: { code: string; message: string }): boolean {
  return error.code === 'invalid_input' && error.message.startsWith('the viewing key was not accepted');
}

/** Whether the server refused the form because of the birthday. */
export function isBirthdayRefusal(error: { code: string; message: string }): boolean {
  return error.code === 'invalid_input' && error.message.startsWith('the birthday height');
}
