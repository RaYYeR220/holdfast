'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { api } from '@/client/api';
import { useAsyncAction } from '@/client/hooks';
import { Button, Input } from '@/ui';
import { FailureNotice } from '../books/FailureNotice';
import { failureCopy } from '../books/failures';
import { NAME_MAX, type ProfileField, burnText, checkProfile, profileChanges } from './model';

export interface ProfileFormProps {
  orgId: string;
  /** What the server holds now. */
  name: string;
  monthlyBurnUsd: number | null;
}

/**
 * The two things an owner changes here: what the organisation is called and
 * its monthly burn, which the Books use for runway. Only what differs from
 * what the server holds is sent, and the page is read again afterwards.
 */
export function ProfileForm({ orgId, name, monthlyBurnUsd }: ProfileFormProps) {
  const router = useRouter();
  const [fields, setFields] = useState({ name, burn: burnText(monthlyBurnUsd) });
  const [errors, setErrors] = useState<Partial<Record<ProfileField, string>>>({});
  const [unchanged, setUnchanged] = useState(false);
  const save = useAsyncAction(async (patch: { name?: string; monthlyBurnUsd?: number | null }) => {
    const saved = await api.updateOrg(orgId, patch);
    setFields({ name: saved.name, burn: burnText(saved.monthlyBurnUsd) });
    router.refresh();
    return saved;
  });

  const set = (field: ProfileField, value: string) => {
    setFields((before) => ({ ...before, [field]: value }));
    setErrors((before) => ({ ...before, [field]: undefined }));
    setUnchanged(false);
    if (save.status !== 'pending') save.reset();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const checked = checkProfile(fields);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const patch = profileChanges(checked.profile, { name, monthlyBurnUsd });
    if (patch === null) {
      setUnchanged(true);
      return;
    }
    void save.run(patch);
  };

  const failed = save.status === 'failed' ? failureCopy(save.error) : null;
  return (
    <form className="st-form" onSubmit={submit} noValidate>
      <Input label="Name" hint={`What the organisation is called on these pages and on an auditor’s view. Up to ${NAME_MAX} characters.`} value={fields.name} autoComplete="organization" onChange={(event) => set('name', event.target.value)} {...(errors.name === undefined ? {} : { error: errors.name })} />
      <Input
        label="Monthly burn, in dollars"
        hint="What the team spends in a month. The Books divide what is held by it to state a runway. Leave it empty to set none."
        numeric
        inputMode="decimal"
        value={fields.burn}
        onChange={(event) => set('burn', event.target.value)}
        {...(errors.burn === undefined ? {} : { error: errors.burn })}
      />
      <div className="st-form__actions">
        <Button type="submit" variant="primary" busy={save.status === 'pending'}>
          {save.status === 'pending' ? 'Saving' : 'Save'}
        </Button>
        <span role="status" aria-live="polite">
          {save.status === 'pending' && 'The server is writing the change.'}
          {save.status === 'done' && 'Saved. This page now shows what the server holds.'}
          {unchanged && 'Nothing differs from what the server holds, so nothing was sent.'}
        </span>
      </div>
      {failed !== null && (
        <FailureNotice failed={failed}>
          <p>Nothing was changed.</p>
        </FailureNotice>
      )}
    </form>
  );
}
