import type { ReactNode } from 'react';

export interface SectionHeadingProps {
  /** The heading. It says what the section shows. */
  title: ReactNode;
  /** Heading level. Two when omitted. */
  level?: 1 | 2 | 3;
  /** `page` for the one heading of a page, `section` for its parts, `minor` inside a panel. */
  size?: 'page' | 'section' | 'minor';
  /** A pixel label above the title: the area or the chain. */
  kicker?: ReactNode;
  /** One or two sentences beside the title, in the serif. */
  lead?: ReactNode;
  /** Replaces the lead with anything else: actions, a stat. */
  aside?: ReactNode;
  /** A heavy rule under the heading. */
  rule?: boolean;
  id?: string;
  className?: string;
}

/** A heading in the pixel face with, beside it, the sentence that explains it. */
export function SectionHeading({ title, level = 2, size = 'section', kicker, lead, aside, rule = false, id, className }: SectionHeadingProps) {
  const Heading = `h${level}` as 'h1' | 'h2' | 'h3';
  const side = aside ?? (lead === undefined ? undefined : <p className="hf-heading__lead">{lead}</p>);
  const name = ['hf-heading', size === 'section' ? '' : `hf-heading--${size}`, side === undefined ? 'hf-heading--solo' : '', rule ? 'hf-heading--rule' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={name}>
      <div>
        {kicker !== undefined && <span className="hf-heading__kicker">{kicker}</span>}
        <Heading className="hf-heading__title" id={id}>
          {title}
        </Heading>
      </div>
      {side}
    </div>
  );
}
