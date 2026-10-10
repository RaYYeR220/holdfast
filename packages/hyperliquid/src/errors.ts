export type HyperliquidErrorCode =
  | 'INVALID_ARGUMENT'
  | 'TRANSPORT'
  | 'BAD_RESPONSE'
  | 'UNKNOWN_COIN'
  | 'UNSUPPORTED_LOT_SIZE'
  | 'FRACTIONAL_LOT'
  | 'UNSUPPORTED_ACCOUNT_MODE'
  | 'ISOLATED_POSITION';

/** Every error this package throws on purpose; `code` is stable, the message is for people. */
export class HyperliquidError extends Error {
  readonly code: HyperliquidErrorCode;

  constructor(code: HyperliquidErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HyperliquidError';
    this.code = code;
  }
}

/** The request never produced an HTTP 200 from Hyperliquid. */
export class HyperliquidTransportError extends HyperliquidError {
  /** HTTP status when a response was received, null when the request itself failed. */
  readonly httpStatus: number | null;

  constructor(message: string, httpStatus: number | null, options?: ErrorOptions) {
    super('TRANSPORT', message, options);
    this.name = 'HyperliquidTransportError';
    this.httpStatus = httpStatus;
  }
}

/** Hyperliquid answered, but not with the shape the adapter relies on. */
export class HyperliquidResponseError extends HyperliquidError {
  constructor(message: string) {
    super('BAD_RESPONSE', message);
    this.name = 'HyperliquidResponseError';
  }
}

/** A size that is not a whole number of 0.01 lots, so the controller cannot represent it. */
export class FractionalLotError extends HyperliquidError {
  readonly size: string;

  constructor(size: string) {
    super('FRACTIONAL_LOT', `size ${size} is not a whole number of 0.01 lots`);
    this.name = 'FractionalLotError';
    this.size = size;
  }
}

/** Portfolio margin, or a mode introduced after this adapter was written. */
export class UnsupportedAccountModeError extends HyperliquidError {
  readonly abstraction: string;

  constructor(abstraction: string) {
    super(
      'UNSUPPORTED_ACCOUNT_MODE',
      `account abstraction mode "${abstraction}" is not supported; use standard or unified account`,
    );
    this.name = 'UnsupportedAccountModeError';
    this.abstraction = abstraction;
  }
}

/** The hedge position is isolated, so the account equity does not back it. */
export class IsolatedPositionError extends HyperliquidError {
  readonly coin: string;

  constructor(coin: string) {
    super('ISOLATED_POSITION', `${coin} position uses isolated margin; the hedge must be cross margin`);
    this.name = 'IsolatedPositionError';
    this.coin = coin;
  }
}
