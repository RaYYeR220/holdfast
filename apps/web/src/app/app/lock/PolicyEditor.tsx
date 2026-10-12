'use client';

import type { Policy } from '@holdfast/core';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { api } from '@/client/api';
import { useAsyncAction } from '@/client/hooks';
import { Button, Input, Notice } from '@/ui';
import { FailureNotice } from '../../_sections/entry/FailureNotice';
import { POLICY_GROUPS, type PolicyErrors, type PolicyText, policyChanges, policyProblems, policyToText, readPolicy } from '../../_sections/lock/policy';

export interface PolicyEditorProps {
  orgId: string;
  /** The policy as the server stores it. */
  policy: Policy;
}

/**
 * The policy's editor. Every figure is written in the unit the page shows it
 * in, checked as it is saved with the function the server itself runs, and
 * sent as the whole policy; the server checks it again and stores it or
 * refuses it with its reasons.
 */
export function PolicyEditor({ orgId, policy }: PolicyEditorProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<PolicyText>(() => policyToText(policy));
  const [errors, setErrors] = useState<PolicyErrors>({});
  const [general, setGeneral] = useState<string[]>([]);
  const saving = useAsyncAction((next: Policy) => api.putPolicy(orgId, next));

  const start = () => {
    setText(policyToText(policy));
    setErrors({});
    setGeneral([]);
    saving.reset();
    setOpen(true);
  };

  const read = readPolicy(text);
  const changes = read.ok ? policyChanges(policy, read.policy) : [];

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!read.ok) {
      setErrors(read.errors);
      setGeneral(read.general);
      return;
    }
    setErrors({});
    setGeneral([]);
    const answer = await saving.run(read.policy);
    if (answer === undefined) return;
    setOpen(false);
    // The policy shown above is read again from the server.
    router.refresh();
  };

  // The server's own reasons for refusing a policy are put beside the fields they are about.
  const refusal = saving.status === 'failed' ? saving.error : null;
  const problems = refusal !== null && Array.isArray(refusal.details.problems) ? policyProblems(refusal.details.problems.filter((problem): problem is string => typeof problem === 'string')) : null;
  const shownErrors: PolicyErrors = { ...(problems?.errors ?? {}), ...errors };
  const shownGeneral = [...general, ...(problems?.general ?? [])];

  if (!open) {
    return (
      <div className="lk-editor lk-action">
        <Button variant="secondary" onClick={start}>
          Edit the policy
        </Button>
        <p className="hf-small lk-action__text">
          A change is stored whole and takes effect at the controller&rsquo;s next tick. It sends no order by itself.
          {saving.status === 'done' ? ' The policy was saved.' : ''}
        </p>
      </div>
    );
  }

  return (
    <form className="lk-editor" onSubmit={(event) => void save(event)} noValidate>
      <h3 className="hf-px lk-sub">Edit the policy</h3>
      <p className="hf-small">Write each figure in the unit shown beside it. Nothing is stored until you save, and the server takes the policy only if every check passes.</p>
      {POLICY_GROUPS.map((group) => (
        <fieldset key={group.id} className="lk-editor__group">
          <legend className="hf-px lk-sub">{group.title}</legend>
          <div className="lk-editor__grid">
            {group.fields.map((entry) => (
              <Input
                key={entry.key}
                label={`${entry.label}, ${entry.unit === 'dollars' ? 'in dollars' : entry.unit === 'multiple' ? 'as a multiple' : entry.unit === 'lots' ? 'in lots' : entry.unit === 'seconds' ? 'in seconds' : entry.suffix === '%' ? 'in percent' : 'in percent a year'}`}
                hint={entry.meaning}
                name={entry.key}
                inputMode="decimal"
                numeric
                value={text[entry.key]}
                onChange={(event) => setText({ ...text, [entry.key]: event.target.value })}
                {...(shownErrors[entry.key] === undefined ? {} : { error: shownErrors[entry.key] })}
              />
            ))}
          </div>
        </fieldset>
      ))}

      {shownGeneral.length > 0 && (
        <Notice kind="refusal" title="The policy does not pass" announce={false}>
          <ul>
            {shownGeneral.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      )}
      {refusal !== null && problems === null && <FailureNotice error={refusal} doing={{ title: 'The policy', nothing: 'The stored policy is unchanged.' }} />}
      {refusal !== null && problems !== null && (
        <Notice kind="refusal" title="The server refused the policy" announce>
          <p>Its reasons are beside the fields they are about. The stored policy is unchanged.</p>
        </Notice>
      )}

      <div className="lk-terms" aria-live="polite">
        <p className="hf-px lk-sub">What saving changes</p>
        {!read.ok ? (
          <p className="hf-small">Some figures cannot be read yet, so there is nothing to save.</p>
        ) : changes.length === 0 ? (
          <p className="hf-small">Nothing: every figure is what is stored.</p>
        ) : (
          <ul className="lk-lines">
            {changes.map((change) => (
              <li key={change.key}>
                {change.label}: <span className="hf-num">{change.from}</span> becomes <span className="hf-num">{change.to}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="lk-editor__foot">
        <Button type="submit" busy={saving.status === 'pending'} disabled={read.ok && changes.length === 0}>
          Save the policy
        </Button>
        <Button variant="quiet" onClick={() => setOpen(false)} disabled={saving.status === 'pending'}>
          Leave it as it is
        </Button>
        {saving.status === 'pending' && (
          <p className="hf-small" role="status">
            The server is checking the policy.
          </p>
        )}
      </div>
    </form>
  );
}
