import type { Policy } from '@holdfast/core';
import type { ReactNode } from 'react';
import { Panel, Tag } from '@/ui';
import { POLICY_GROUPS, policyInWords, shown } from './policy';

export interface PolicyViewProps {
  policy: Policy;
  /** Whether it is the default policy, which is the one the backtest grades. */
  isDefault: boolean;
  /** The owner's editor; without it the panel says who can change the policy. */
  editor?: ReactNode;
}

/** The policy in words and in numbers: every figure the controller decides by, with what it does. */
export function PolicyView({ policy, isDefault, editor }: PolicyViewProps) {
  return (
    <Panel title="Policy" level={2} aside={<Tag variant="boxed">{isDefault ? 'Default policy' : 'Own policy'}</Tag>}>
      <div className="lk-policy">
        <p className="lk-policy__words">{policyInWords(policy)}</p>
        <div className="lk-policy__groups">
          {POLICY_GROUPS.map((group) => (
            <section key={group.id} className="lk-policy__group">
              <h3 className="hf-px lk-sub">{group.title}</h3>
              <p className="hf-small lk-policy__lead">{group.lead}</p>
              <dl className="lk-policy__list">
                {group.fields.map((entry) => (
                  <div key={entry.key}>
                    <dt className="hf-px">{entry.label}</dt>
                    <dd className="lk-policy__figure hf-num">{shown(entry.key, policy[entry.key])}</dd>
                    <dd className="lk-policy__meaning">{entry.meaning}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        {editor ?? <p className="hf-small lk-who">Only the owner of the treasury can change the policy. The server takes a policy whole and refuses one that does not pass its checks.</p>}
      </div>
    </Panel>
  );
}
