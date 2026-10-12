import { ClientError } from './errors';
import { type QrCode, encodeQr } from './qr';

/**
 * Zcash has no wallet connection: the service never sees a spending key and
 * no page can ask a wallet to sign. Every movement of ZEC is a ZIP-321
 * payment request the server writes and the treasurer pays from a wallet of
 * their own, by copying it, by following it as a link, or by scanning it.
 */

export interface ZcashPaymentRequest {
  /** The ZIP-321 URI as the server wrote it, to show and to copy. */
  uri: string;
  /** The same URI for a link, which opens a wallet registered for `zcash:` on this device. */
  href: string;
  /** The URI as a QR code, for a wallet on another device. */
  qr: QrCode;
}

/** What a payment request is expected to ask for: one payment, of this many zatoshi, to this address. */
export interface ZcashPayment {
  address: string;
  amountZat: bigint;
}

const SCHEME = 'zcash:';
/** A URI is printable ASCII without spaces; anything else in it is percent-encoded. */
const URI_CHARACTERS = /^[\x21-\x7e]+$/;
const ZAT_PER_ZEC = 100_000_000n;

/** An amount as ZIP-321 writes it: ZEC in decimal, with no more digits than it needs. */
function zec(zat: bigint): string {
  const fraction = (zat % ZAT_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction === '' ? (zat / ZAT_PER_ZEC).toString() : `${zat / ZAT_PER_ZEC}.${fraction}`;
}

/**
 * What a page needs to hand a payment request to the treasurer's wallet.
 * The request is taken as the server wrote it, once it is known to be a
 * `zcash:` URI and nothing else, because it becomes the target of a link.
 * With `expected`, it also has to be the request for exactly that payment:
 * the amount the treasurer asked to send, to the address the page shows.
 */
export function zcashPaymentRequest(uri: string, expected?: ZcashPayment): ZcashPaymentRequest {
  if (!uri.startsWith(SCHEME) || uri.length === SCHEME.length || !URI_CHARACTERS.test(uri)) {
    throw new ClientError('invalid_argument', 'this is not a zcash: payment request');
  }
  if (expected !== undefined && (expected.amountZat <= 0n || uri !== `${SCHEME}${expected.address}?amount=${zec(expected.amountZat)}`)) {
    throw new ClientError('unexpected_request', 'the payment request the server wrote is not for the amount and the address it was asked for');
  }
  let qr: QrCode;
  try {
    qr = encodeQr(uri);
  } catch (error) {
    throw new ClientError('invalid_argument', 'the payment request is too long for a QR code', { cause: error });
  }
  return { uri, href: uri, qr };
}

export { type QrCode, encodeQr } from './qr';
