import { Fragment } from 'react';
import { ExternalTxLink, OutArrow, hyperliquidAccountUrl, shorten } from '@/ui';
import type { Refusal } from './facts';

/** An answer such as `SpendingLimitExceeded` may break between its words on a narrow screen. */
function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[a-z])(?=[A-Z])/);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

export interface RefusalLedgerProps {
  refusal: Refusal;
  /** Ids for the attempt and the answer, when a dialog names itself by them. */
  triedId?: string;
  answerId?: string;
}

/**
 * One refusal written out as a ledger entry: who tried what, on which
 * network, what came back, why, and where anyone can check it.
 */
export function RefusalLedger({ refusal, triedId, answerId }: RefusalLedgerProps) {
  return (
    <>
      <p className="lp-led__no hf-px">
        <span>
          {refusal.chainName} {refusal.network}, {refusal.who}
        </span>
        <span>
          <i className="hf-swatch hf-pat-refused" aria-hidden="true" /> Refused
        </span>
      </p>
      <p className="lp-led__tried" id={triedId}>
        Tried to {refusal.tried}.
      </p>
      <p className="lp-led__ans hf-px" id={answerId}>
        {refusal.quoted ? (
          <>
            “<Breakable text={refusal.answer} />”
          </>
        ) : (
          `${refusal.answer}.`
        )}
      </p>
      <p className="lp-led__why">{refusal.why}</p>
      {refusal.proof !== null && (
        <p className="lp-led__proof">
          {refusal.proof.kind === 'tx' ? (
            <ExternalTxLink chain={refusal.chain} id={refusal.proof.id} showChain={false}>
              Transaction {shorten(refusal.proof.id)}
            </ExternalTxLink>
          ) : (
            <a className="hf-txlink" href={hyperliquidAccountUrl(refusal.proof.address)} target="_blank" rel="noopener noreferrer" title={refusal.proof.address}>
              <span className="hf-txlink__id">Team account {shorten(refusal.proof.address, 6, 4)}</span>
              <OutArrow />
              <span className="hf-sr"> on the Hyperliquid explorer (opens in a new tab)</span>
            </a>
          )}
        </p>
      )}
    </>
  );
}
