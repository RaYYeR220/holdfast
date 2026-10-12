import { Link, StateTag } from '@/ui';

/**
 * What an auditor link shows when it opens nothing. A link that was revoked,
 * one that has expired and one that was never issued all end here, and the
 * page does not say which: telling them apart would tell a stranger which
 * links exist.
 */
export function AuditGone() {
  return (
    <div className="au-gone">
      <p>
        <StateTag state="unlocked" label="Nothing to show" boxed />
      </p>
      <h1>This link opens nothing</h1>
      <p>An auditor link stops working when the organisation revokes it or when it expires, and an address that was mistyped never worked. This page does not say which of these it is.</p>
      <p>If you were given this link to read an organisation’s books, ask whoever sent it for a new one. Nothing about the organisation is shown without a working link.</p>
      <p>
        <Link href="/" variant="emphasis">
          What Holdfast is
        </Link>
      </p>
    </div>
  );
}
