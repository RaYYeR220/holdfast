'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { type FundingQuote, type Swap, api } from '@/client/api';
import { type ClientError, toClientError } from '@/client/errors';
import { useAsyncAction } from '@/client/hooks';
import { type ZcashPaymentRequest, zcashPaymentRequest } from '@/client/zcash';
import { Button, CopyButton, ExternalTxLink, Input, KeyValue, Notice, Panel, QrFrame, Select, StateTag, Timestamp, Unavailable, formatBps, formatUsd, shorten } from '@/ui';
import { FailureNotice } from '../../_sections/entry/FailureNotice';
import { deliveredText, purposeWords, swapWords, zecText } from '../../_sections/treasury/figures';
import { DEFAULT_SLIPPAGE_BPS, type FundingBody, type FundingErrors, type FundingPurpose, SLIPPAGE_CHOICES, quoteCostUsd, readFunding } from '../../_sections/treasury/funding';

export interface FundingPanelProps {
  orgId: string;
  /** Whether the organisation names a Solana wallet a payout float can be delivered to. */
  hasSolanaWallet: boolean;
  /** Whether Zcash transactions can be linked to the mainnet explorer. */
  mainnet: boolean;
}

/** How often the swap service is asked where a swap stands while the page is open, ms. */
const ASK_EVERY_MS = 12_000;

const STEPS = ['Deposit seen', 'Swap under way', 'Dollars delivered'] as const;

function QuoteFacts({ quote, dry }: { quote: FundingQuote; dry: boolean }) {
  const purpose = purposeWords(quote.purpose);
  return (
    <KeyValue
      items={[
        {
          label: 'You pay',
          value: (
            <>
              <span className="hf-num">{zecText(quote.amountIn)} ZEC</span>, valued at {formatUsd(quote.amountInUsd)}
            </>
          ),
        },
        {
          label: 'You receive',
          value: (
            <>
              <span className="hf-num">{deliveredText(quote.amountOut, purpose)}</span>, valued at {formatUsd(quote.amountOutUsd)}, and at least <span className="hf-num">{deliveredText(quote.minAmountOut, purpose)}</span> after slippage
            </>
          ),
        },
        {
          label: 'The swap takes',
          value: (
            <>
              <span className="hf-num">{formatUsd(quoteCostUsd(quote))}</span>, {formatBps(quote.costBps, 2)} of what is paid in: everything lost between the two legs, the swap service&rsquo;s fee included
            </>
          ),
        },
        {
          label: 'Delivered to',
          value: (
            <>
              {purpose.delivers}, <span className="hf-num tr-break">{quote.recipient}</span>. It is always an account of your own: the request has no field for a recipient.
            </>
          ),
        },
        ...(quote.depositAddress === null
          ? []
          : [
              {
                label: 'Deposit address',
                value: (
                  <CopyButton value={quote.depositAddress} what="deposit address">
                    {quote.depositAddress}
                  </CopyButton>
                ),
              },
            ]),
        {
          label: 'Lapses',
          value: (
            <>
              <Timestamp at={quote.deadline} show="absolute" />, as the swap service states it{dry ? ' for this price; a quote to pay states its own' : ''}. A deposit that arrives later is sent back, not swapped.
            </>
          ),
        },
        { label: 'Takes about', value: `${Math.max(1, Math.round(quote.etaSeconds / 60))} min once the deposit is seen, by the swap service’s estimate` },
      ]}
    />
  );
}

function Progress({ swap, failure, mainnet }: { swap: Swap | null; failure: ClientError | null; mainnet: boolean }) {
  const words = swap === null ? null : swapWords(swap.state);
  const purpose = swap === null ? null : purposeWords(swap.purpose);
  return (
    <div className="tr-quote" role="status">
      <p className="hf-px tr-sub">Where the swap stands</p>
      {swap === null && failure === null && <p className="hf-small">Asking the swap service where the swap stands.</p>}
      {failure !== null && <Unavailable reason={`${failure.message}; the swap service is asked again in a few seconds`} source="the swap service" />}
      {swap !== null && words !== null && purpose !== null && (
        <>
          <p>
            <StateTag state={words.state} label={words.label} boxed /> <span className="hf-small">{words.text}</span>
          </p>
          {words.step !== null && (
            <ol className="tr-steps">
              {STEPS.map((name, index) => {
                const done = index === 0 ? words.step !== null && (words.step >= 1 || swap.originTxs.length > 0) : words.step !== null && words.step >= index;
                return (
                  <li key={name} data-done={done}>
                    <span className="hf-px">{name}</span>
                    {done ? 'yes' : 'not yet'}
                  </li>
                );
              })}
            </ol>
          )}
          <KeyValue
            items={[
              {
                label: 'Deposit',
                value:
                  swap.originTxs.length === 0 ? (
                    'The swap service has named no deposit transaction yet.'
                  ) : (
                    <span className="tr-txs">
                      {swap.originTxs.map((tx) => (mainnet ? <ExternalTxLink key={tx} chain="zcash" id={tx} /> : <CopyButton key={tx} value={tx} what="transaction id">{shorten(tx)}</CopyButton>))}
                    </span>
                  ),
              },
              {
                label: 'Receiving',
                value:
                  swap.destinationTxs.length === 0 ? (
                    'No receiving transaction yet.'
                  ) : (
                    <span className="tr-txs">
                      {swap.destinationTxs.map((tx) => (purpose.chain === null ? <CopyButton key={tx} value={tx} what="transaction id">{shorten(tx)}</CopyButton> : <ExternalTxLink key={tx} chain={purpose.chain} id={tx} />))}
                    </span>
                  ),
              },
              ...(swap.amountOut === null ? [] : [{ label: 'Delivered', value: <span className="hf-num">{deliveredText(swap.amountOut, purpose)}</span> }]),
            ]}
          />
          <p className="hf-small tr-asof">
            The swap service was last heard <Timestamp at={swap.updatedAt} />.{swap.final ? ' The swap can no longer change.' : ' It is asked again every few seconds while this page is open, and by the controller’s tick when it is not.'}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Funding from the treasury: a quote that turns ZEC into dollars on an
 * account of the team's own, the payment request for the treasurer's own
 * wallet, and the swap's progress until it settles. The service sends
 * nothing: the quote is a question to the swap service, and the payment is
 * the treasurer's.
 */
export function FundingPanel({ orgId, hasSolanaWallet, mainnet }: FundingPanelProps) {
  const router = useRouter();
  const [purpose, setPurpose] = useState<FundingPurpose>('margin');
  const [amount, setAmount] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [slippageBps, setSlippageBps] = useState(String(DEFAULT_SLIPPAGE_BPS));
  const [errors, setErrors] = useState<FundingErrors>({});

  const pricing = useAsyncAction((body: FundingBody) => api.quoteFunding(orgId, { ...body, dry: true }));
  const quoting = useAsyncAction((body: FundingBody) => api.quoteFunding(orgId, body));
  const quote = quoting.status === 'done' ? quoting.result : null;

  const read = () => {
    const reading = readFunding({ purpose, amount, refundTo, slippageBps }, { payoutFloat: hasSolanaWallet });
    setErrors(reading.ok ? {} : reading.errors);
    return reading.ok ? reading.body : null;
  };

  const price = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = read();
    if (body === null) return;
    quoting.reset();
    void pricing.run(body);
  };

  const ask = () => {
    const body = read();
    if (body === null) return;
    pricing.reset();
    void quoting.run(body).then((made) => {
      // The swap is on record now: the list below is read again from the server.
      if (made !== undefined) router.refresh();
    });
  };

  // The payment request is taken as the server wrote it only if it is the request for this deposit and this amount.
  const payment = useMemo((): { ok: true; request: ZcashPaymentRequest } | { ok: false; error: ClientError } | null => {
    if (quote === null || quote.paymentUri === null || quote.depositAddress === null) return null;
    try {
      return { ok: true, request: zcashPaymentRequest(quote.paymentUri, { address: quote.depositAddress, amountZat: BigInt(quote.amountIn) }) };
    } catch (error) {
      return { ok: false, error: toClientError(error, 'unexpected_request') };
    }
  }, [quote]);

  const swapId = quote?.swapId ?? null;
  const [swap, setSwap] = useState<Swap | null>(null);
  const [swapFailure, setSwapFailure] = useState<ClientError | null>(null);
  const settled = useRef(false);
  useEffect(() => {
    if (swapId === null) return;
    setSwap(null);
    setSwapFailure(null);
    settled.current = false;
    let wanted = true;
    let timer: number | undefined;
    const askOnce = async () => {
      try {
        const now = await api.getSwap(orgId, swapId);
        if (!wanted) return;
        setSwap(now);
        setSwapFailure(null);
        if (now.final) {
          if (!settled.current) {
            settled.current = true;
            router.refresh();
          }
          return;
        }
      } catch (error) {
        if (!wanted) return;
        setSwapFailure(toClientError(error, 'network'));
      }
      timer = window.setTimeout(() => void askOnce(), ASK_EVERY_MS);
    };
    void askOnce();
    return () => {
      wanted = false;
      window.clearTimeout(timer);
    };
  }, [orgId, swapId, router]);

  const busy = pricing.status === 'pending' || quoting.status === 'pending';
  return (
    <Panel title="Fund from the treasury" level={2}>
      <div className="tr-fund">
        <form className="tr-fund__form" onSubmit={price} noValidate>
          <p className="hf-small">
            Turn ZEC into dollars on an account of your own. The service asks the swap service for a quote and writes the payment request; the payment is made from your own Zcash wallet, and the service holds nothing at any point.
          </p>
          <Select
            label="Deliver"
            name="purpose"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value as FundingPurpose)}
            options={[
              { value: 'margin', label: 'USDC margin on your Hyperliquid account' },
              { value: 'payout_float', label: 'USDC on your Solana wallet, for payouts' },
            ]}
            hint={purpose === 'margin' ? 'Margin for the short. It arrives on the account that owns this organisation.' : 'A float the Solana delegate pays contractors from, up to its allowance.'}
            {...(errors.purpose === undefined ? {} : { error: errors.purpose })}
          />
          <Input
            label="Amount of ZEC"
            name="amount"
            inputMode="decimal"
            numeric
            hint="A plain number of ZEC, with up to eight decimals."
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            {...(errors.amount === undefined ? {} : { error: errors.amount })}
          />
          <Input
            label="Refund address"
            name="refundTo"
            numeric
            autoComplete="off"
            spellCheck={false}
            hint="A transparent address of your own. If the swap cannot complete, the swap service returns the ZEC there; it returns to transparent addresses only."
            value={refundTo}
            onChange={(event) => setRefundTo(event.target.value)}
            {...(errors.refundTo === undefined ? {} : { error: errors.refundTo })}
          />
          <Select
            label="Slippage allowed"
            name="slippage"
            value={slippageBps}
            onChange={(event) => setSlippageBps(event.target.value)}
            options={SLIPPAGE_CHOICES.map((bps) => ({ value: String(bps), label: formatBps(bps, 1) }))}
            hint="How far the delivered amount may fall short of the quote before the swap is not made."
          />
          <div className="tr-fund__actions">
            <Button type="submit" variant="secondary" busy={pricing.status === 'pending'} disabled={quoting.status === 'pending'}>
              Price it
            </Button>
            <Button busy={quoting.status === 'pending'} disabled={pricing.status === 'pending'} onClick={ask}>
              Get a quote to pay
            </Button>
          </div>
          <p className="hf-small">
            Pricing records nothing. A quote to pay makes a one-time deposit address and records the swap so that it can be followed; nothing moves until you pay it, and an unpaid quote lapses by itself.
          </p>
        </form>

        <div className="tr-fund__side" aria-live="polite">
          {pricing.status === 'idle' && quoting.status === 'idle' && <p className="hf-small tr-who">A quote shows here in full before anything is paid: what you pay, what arrives, what the swap takes, where to pay and until when.</p>}
          {busy && (
            <p className="hf-small" role="status">
              Asking the swap service for a quote.
            </p>
          )}
          {pricing.status === 'failed' && <FailureNotice error={pricing.error} doing={{ title: 'The quote', nothing: 'Nothing was recorded.' }} />}
          {quoting.status === 'failed' && <FailureNotice error={quoting.error} doing={{ title: 'The quote', nothing: 'No swap was recorded and there is nothing to pay.' }} />}

          {pricing.status === 'done' && (
            <div className="tr-quote">
              <p className="hf-px tr-sub">A price, not yet a quote to pay</p>
              <QuoteFacts quote={pricing.result} dry />
              <p className="hf-small">No deposit address was made and nothing was recorded. The figures of a quote to pay are asked for again and may differ.</p>
            </div>
          )}

          {quote !== null && (
            <div className="tr-quote">
              <p className="hf-px tr-sub">The quote</p>
              <QuoteFacts quote={quote} dry={false} />

              {payment === null && <Unavailable reason="the server gave no payment request with this quote, so there is nothing to pay" source="the server" />}
              {payment !== null && !payment.ok && <FailureNotice error={payment.error} doing={{ title: 'The payment request', nothing: 'It is not shown, so that nothing is paid to it.' }} />}
              {payment !== null && payment.ok && (
                <div className="tr-pay">
                  <QrFrame matrix={payment.request.qr.modules} label={`Payment request for ${zecText(quote.amountIn)} ZEC to the deposit address of the swap`} caption="ZIP-321 payment request" />
                  <div className="tr-pay__text">
                    <p className="hf-px tr-sub">Pay it from your own wallet</p>
                    <p>
                      Scan the code with your Zcash wallet, or copy the request into it. The wallet shows the amount and the address before you approve. The service cannot make this payment.
                    </p>
                    <p className="tr-uri">{payment.request.uri}</p>
                    <p className="tr-fund__actions">
                      <CopyButton value={payment.request.uri} what="payment request" />
                      <a className="hf-link" href={payment.request.href}>
                        Open in a wallet on this device
                      </a>
                    </p>
                    <Notice kind="warning" word="Public" title="This payment is not shielded" announce={false}>
                      <p>The swap service takes transparent ZEC only. The deposit address, the amount and the time of this payment are public on the Zcash chain.</p>
                    </Notice>
                  </div>
                </div>
              )}

              {swapId !== null && <Progress swap={swap} failure={swapFailure} mainnet={mainnet} />}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
