'use client';

import { useAsyncAction, useSession } from '@/client/hooks';
import { Button } from '@/ui';
import { FailureNotice } from '../books/FailureNotice';
import { failureCopy } from '../books/failures';

/**
 * Signing out: the browser drops the session cookie and the application is
 * loaded again from its first page, so that nothing rendered for the session
 * stays on screen. The wallet stays connected; it is the session that is
 * given up.
 */
export function SignOut() {
  const session = useSession();
  const leave = useAsyncAction(async () => {
    await session.signOut();
    window.location.assign('/app');
    return true;
  });
  const failed = leave.status === 'failed' ? failureCopy(leave.error) : null;
  return (
    <div className="st-out">
      <Button variant="secondary" busy={leave.status === 'pending'} onClick={() => void leave.run()}>
        {leave.status === 'pending' ? 'Signing out' : 'Sign out'}
      </Button>
      <span role="status" aria-live="polite">
        {leave.status === 'pending' && 'Asking the server to end the session.'}
        {leave.status === 'done' && 'Signed out. Going to the first page.'}
      </span>
      {failed !== null && (
        <FailureNotice failed={failed}>
          <p>You are still signed in.</p>
        </FailureNotice>
      )}
    </div>
  );
}
