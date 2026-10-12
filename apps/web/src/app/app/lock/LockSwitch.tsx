'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/client/api';
import { useAsyncAction } from '@/client/hooks';
import { Button, Dialog, Notice, Toggle } from '@/ui';
import { FailureNotice } from '../../_sections/entry/FailureNotice';
import { type SwitchInput, switchWords } from '../../_sections/lock/words';

export interface LockSwitchProps {
  orgId: string;
  /** Whether the lock is on, as the server has it. */
  enabled: boolean;
  /** What the confirmation is written from: the policy and what the venue and the treasury showed as the page was made. */
  facts: Omit<SwitchInput, 'enable'>;
}

/**
 * The lever that switches the lock. Moving it changes nothing by itself: it
 * opens a confirmation that states what the controller will do at its next
 * tick, and only confirming that records the wish with the server.
 */
export function LockSwitch({ orgId, enabled, facts }: LockSwitchProps) {
  const router = useRouter();
  /** The state being asked for while the confirmation is open. */
  const [asking, setAsking] = useState<boolean | null>(null);
  const switching = useAsyncAction((enable: boolean) => api.setLock(orgId, enable));
  const words = asking === null ? null : switchWords({ ...facts, enable: asking });

  // The dialog also reports its own closing after a switch that went through; only a failed attempt is forgotten here.
  const close = () => {
    if (switching.status === 'pending') return;
    setAsking(null);
    if (switching.status === 'failed') switching.reset();
  };

  const confirm = async () => {
    if (asking === null) return;
    const answer = await switching.run(asking);
    if (answer === undefined) return;
    setAsking(null);
    // What the lock is now is the server's to say.
    router.refresh();
  };

  return (
    <div className="lk-action">
      <Toggle
        label="Runway lock"
        checked={enabled}
        onChange={(next) => {
          switching.reset();
          setAsking(next);
        }}
      />
      <p className="hf-small lk-action__text">
        {enabled
          ? 'The lock is on: the controller keeps the short sized to the treasury. Switching it off has the short bought back.'
          : 'The lock is off: the controller opens no short. Switching it on has it sell towards the short the treasury calls for, once the agent is approved and margin is on the account.'}
      </p>
      {switching.status === 'done' && asking === null && (
        <Notice kind="info" word="Recorded" title={switching.result.lockEnabled ? 'The lock is switched on' : 'The lock is switched off'} announce>
          <p>The controller acts on it at its next tick. The journal below shows what it decided.</p>
        </Notice>
      )}

      <Dialog
        open={asking !== null}
        onClose={close}
        title={words?.title ?? 'Switch the lock'}
        closeLabel="Close"
        actions={
          <>
            <Button variant="quiet" onClick={close} disabled={switching.status === 'pending'}>
              Leave it as it is
            </Button>
            <Button variant={asking === false ? 'destructive' : 'primary'} busy={switching.status === 'pending'} onClick={() => void confirm()}>
              {words?.confirm ?? 'Switch'}
            </Button>
          </>
        }
      >
        {words !== null && (
          <>
            <ul className="lk-lines">
              {words.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {switching.status === 'failed' && <FailureNotice error={switching.error} doing={{ title: 'The switch', nothing: 'The lock is as it was.' }} />}
          </>
        )}
      </Dialog>
    </div>
  );
}
