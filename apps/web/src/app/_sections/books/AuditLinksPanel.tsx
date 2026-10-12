'use client';

import type { AuditModule } from '@holdfast/books';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { type AuditLink, api } from '@/client/api';
import { useAsyncAction } from '@/client/hooks';
import { Button, Checkbox, CopyButton, Dialog, Input, Notice, Panel, SectionHeading, StateTag, Tag, Timestamp, formatUtc } from '@/ui';
import { FailureNotice } from './FailureNotice';
import { failureCopy } from './failures';
import { type AuditLinkField, type AuditLinkFields, type LinkState, MODULES, MODULE_COVERS, MODULE_NAME, checkAuditLink, linkState, scopeDates } from './model';

export interface AuditLinksPanelProps {
  orgId: string;
  /** Every link of the organisation as the server lists them, newest first. */
  links: readonly AuditLink[];
  /** The server's clock when it listed them. */
  now: number;
}

const EMPTY: AuditLinkFields = { label: '', from: '', to: '', modules: [...MODULES], expires: '' };

const STATE: Record<LinkState, { state: 'locked' | 'unlocked' | 'refused' | 'stale'; word: string }> = {
  live: { state: 'locked', word: 'Works' },
  expired: { state: 'unlocked', word: 'Expired' },
  revoked: { state: 'refused', word: 'Revoked' },
  unreadable: { state: 'stale', word: 'Opens nothing' },
};

function LinkRow({ orgId, link, now }: { orgId: string; link: AuditLink; now: number }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const revoke = useAsyncAction(async () => {
    const answer = await api.revokeAuditLink(orgId, link.id);
    router.refresh();
    return answer;
  });
  const state = linkState(link, now);
  const failed = revoke.status === 'failed' ? failureCopy(revoke.error) : null;
  return (
    <li className="bk-link">
      <div>
        <p className="bk-link__name hf-px">
          <span>{link.label}</span>
          <StateTag state={STATE[state].state} label={STATE[state].word} />
        </p>
        <p className="bk-link__facts">
          {link.scope === null ? (
            <span>What is stored as this link’s scope cannot be read as one, so the link shows nothing to anyone.</span>
          ) : (
            <>
              <span>{scopeDates(link.scope, (ms) => formatUtc(ms))}.</span>
              <span>Covers {link.scope.modules.map((module) => MODULE_NAME[module].toLowerCase()).join(', ')}.</span>
            </>
          )}
          <span>
            Made <Timestamp at={link.createdAt} now={now} />.{' '}
            {link.revokedAt !== null ? (
              <>
                Revoked <Timestamp at={link.revokedAt} now={now} />.
              </>
            ) : link.expiresAt === null ? (
              'No expiry.'
            ) : (
              <>
                {link.expiresAt <= now ? 'Expired' : 'Expires'} <Timestamp at={link.expiresAt} show="absolute" />.
              </>
            )}
          </span>
        </p>
        {failed !== null && <FailureNotice failed={failed} className="sf-act__result" />}
      </div>
      {state === 'live' && (
        <Button variant="destructive" busy={revoke.status === 'pending'} onClick={() => setAsking(true)}>
          {revoke.status === 'pending' ? 'Revoking' : 'Revoke'}
        </Button>
      )}
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title="Revoke this link"
        closeLabel="Cancel"
        actions={
          <>
            <Button variant="quiet" onClick={() => setAsking(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setAsking(false);
                void revoke.run();
              }}
            >
              Revoke the link
            </Button>
          </>
        }
      >
        <p>
          “{link.label}” stops working from this moment for whoever holds it. Its address then answers exactly as an address that never existed does.
        </p>
        <p>This cannot be undone. A new link can be made at any time.</p>
      </Dialog>
    </li>
  );
}

/**
 * Auditor links: the owner makes a link that opens a chosen part of the
 * books to whoever holds it, without an account, and takes it back. The
 * link is shown once, when it is made; only its hash is stored.
 */
export function AuditLinksPanel({ orgId, links, now }: AuditLinksPanelProps) {
  const router = useRouter();
  const [fields, setFields] = useState<AuditLinkFields>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<AuditLinkField, string>>>({});
  const create = useAsyncAction(async (input: Parameters<typeof api.createAuditLink>[1]) => {
    const made = await api.createAuditLink(orgId, input);
    router.refresh();
    return made;
  });

  const set = <K extends keyof AuditLinkFields>(name: K, value: AuditLinkFields[K]) => {
    setFields((before) => ({ ...before, [name]: value }));
    setErrors((before) => ({ ...before, [name]: undefined }));
  };
  const toggle = (module: AuditModule, on: boolean) => set('modules', on ? [...fields.modules, module] : fields.modules.filter((held) => held !== module));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const checked = checkAuditLink(fields, Date.now());
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const made = await create.run(checked.input);
    if (made !== undefined) setFields(EMPTY);
  };

  const failed = create.status === 'failed' ? failureCopy(create.error) : null;
  const made = create.status === 'done' ? create.result : null;
  const address = made === null || typeof window === 'undefined' ? null : `${window.location.origin}/audit/${made.token}`;

  return (
    <section aria-labelledby="bk-audit" className="bk-own">
      <SectionHeading
        id="bk-audit"
        title="Auditor links"
        lead="A link opens a chosen part of the books to whoever holds it, read only and without an account. You can take it back at any time."
      />

      <Panel title="A new link" level={3}>
        <form className="bk-form" onSubmit={(event) => void submit(event)} noValidate>
          <Input
            className="bk-form__wide"
            label="Name"
            hint="For your own list: whom the link is for. The holder of the link sees it too."
            value={fields.label}
            onChange={(event) => set('label', event.target.value)}
            {...(errors.label === undefined ? {} : { error: errors.label })}
          />
          <Input
            label="From"
            type="date"
            numeric
            hint="First UTC day covered. Leave empty to start at the first entry."
            value={fields.from}
            onChange={(event) => set('from', event.target.value)}
            {...(errors.from === undefined ? {} : { error: errors.from })}
          />
          <Input
            label="To"
            type="date"
            numeric
            hint="Last UTC day covered. Leave empty to include everything still to come."
            value={fields.to}
            onChange={(event) => set('to', event.target.value)}
            {...(errors.to === undefined ? {} : { error: errors.to })}
          />
          <fieldset className="bk-form__wide" {...(errors.modules === undefined ? {} : { 'aria-describedby': 'bk-modules-error' })}>
            <legend>Modules the link may see</legend>
            <div className="bk-modules">
              {MODULES.map((module) => (
                <Checkbox key={module} label={MODULE_NAME[module]} hint={`${MODULE_COVERS[module]}.`} checked={fields.modules.includes(module)} onChange={(event) => toggle(module, event.target.checked)} />
              ))}
            </div>
            {errors.modules !== undefined && (
              <p className="hf-field__error" id="bk-modules-error" role="alert">
                <i className="hf-swatch" aria-hidden="true" />
                <span>{errors.modules}</span>
              </p>
            )}
          </fieldset>
          <Input
            label="Expires"
            type="date"
            numeric
            hint="The last UTC day the link works. Leave empty for no expiry."
            value={fields.expires}
            onChange={(event) => set('expires', event.target.value)}
            {...(errors.expires === undefined ? {} : { error: errors.expires })}
          />
          <div className="bk-form__wide">
            <p className="hf-small">
              A balance, a position and the runway are sums of everything before them. A link that starts later than the first entry, ends before today or leaves a module out shows the entries and the totals of its scope, and not those.
            </p>
          </div>
          <div className="bk-form__wide bk-form__actions">
            <Button type="submit" variant="primary" busy={create.status === 'pending'}>
              {create.status === 'pending' ? 'Making the link' : 'Make the link'}
            </Button>
            {create.status === 'pending' && <span role="status">The server is storing the link’s hash.</span>}
          </div>
        </form>
        {failed !== null && (
          <FailureNotice failed={failed} className="sf-act__result">
            <p>No link was made.</p>
          </FailureNotice>
        )}
        {made !== null && address !== null && (
          <Notice kind="info" title={`The link for “${made.link.label}”`} word="Made" announce className="sf-act__result">
            <div className="bk-token">
              <p>This is the only time the link is shown. The server keeps its hash and cannot show it again: if it is lost, revoke it and make another.</p>
              <p className="bk-token__url">{address}</p>
              <p>
                <CopyButton value={address} what="link" />
              </p>
              <p>Send it to the auditor yourself. Anyone who has it can read what it covers until it is revoked or expires.</p>
            </div>
          </Notice>
        )}
      </Panel>

      <Panel title="Links made" level={3} flush aside={<Tag>{`${links.length} in all`}</Tag>}>
        {links.length === 0 ? (
          <p className="bk-link__empty">No link has been made. Nobody but the signed-in owner can read these books.</p>
        ) : (
          <ul className="bk-links">
            {links.map((link) => (
              <LinkRow key={link.id} orgId={orgId} link={link} now={now} />
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}
