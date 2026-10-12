import { SectionHeading, Skeleton } from '@/ui';
import './parts.css';

export interface SectionLoadingProps {
  /** The page's heading, so that the frame of the page stands while it is read. */
  title: string;
  /** What is being read and from where, as a sentence. */
  doing: string;
  /** What each block that is coming will hold, for a reader who cannot see the placeholders. */
  parts: readonly string[];
}

/**
 * What a section's page shows while the server reads for it: the heading,
 * the sentence that says what is being read, and a placeholder where each
 * part will stand. Never a bare spinner.
 */
export function SectionLoading({ title, doing, parts }: SectionLoadingProps) {
  return (
    <div className="hf-stack" aria-busy="true">
      <SectionHeading level={1} size="page" title={title} lead={doing} />
      <div className="sx-reading">
        {parts.map((part, index) => (
          <Skeleton key={part} label={part} height={index === 0 ? 168 : 96} />
        ))}
      </div>
    </div>
  );
}
