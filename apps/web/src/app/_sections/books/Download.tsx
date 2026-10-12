'use client';

import { api } from '@/client/api';
import { useAsyncAction } from '@/client/hooks';
import { Button, formatNumber } from '@/ui';
import { FailureNotice } from './FailureNotice';
import { type Failed, failureCopy } from './failures';

/** Which file is fetched: the published statement or the whole ledger of an organisation, or the ledger an auditor link opens. */
export type DownloadSource = { kind: 'statement'; orgId: string } | { kind: 'ledger'; orgId: string } | { kind: 'audit'; token: string };

export interface DownloadProps {
  source: DownloadSource;
  /** The name the file is saved under, which is the name the server gives it. */
  filename: string;
  /** The file's media type. */
  type: 'application/json' | 'text/csv';
  /** What the button says. */
  label: string;
  /** What the server does while the reader waits, as a sentence. */
  working: string;
  variant?: 'primary' | 'secondary';
}

function fetchText(source: DownloadSource): Promise<string> {
  if (source.kind === 'statement') return api.exportStatement(source.orgId);
  if (source.kind === 'ledger') return api.exportLedgerCsv(source.orgId);
  return api.auditCsv(source.token);
}

/** Hand a text to the browser as a file to save. */
function save(text: string, filename: string, type: string): number {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has taken the file by the time the click returns; the address is given back a little later to be safe.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return blob.size;
}

function sizeOf(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${formatNumber(bytes / 1024, bytes < 10_240 ? 1 : 0)} kB`;
}

/**
 * A file the server builds on request, fetched and then saved, so that a
 * failure is said here in the server's words and never lands the reader on a
 * page of JSON. The file is built again on every press: it is the books as
 * they stand at that moment.
 */
export function Download({ source, filename, type, label, working, variant = 'secondary' }: DownloadProps) {
  const action = useAsyncAction(async () => ({ bytes: save(await fetchText(source), filename, type), at: Date.now() }));
  const failed: Failed | null = action.status === 'failed' ? failureCopy(action.error, source.kind === 'audit' ? 'audit' : 'owner') : null;
  return (
    <div className="bk-export__state">
      <Button variant={variant} busy={action.status === 'pending'} onClick={() => void action.run()}>
        {label}
      </Button>
      <div role="status" aria-live="polite">
        {action.status === 'pending' && <p className="sf-act__said">{working}</p>}
        {action.status === 'done' && (
          <p className="sf-act__said">
            Saved as <span className="hf-num">{filename}</span>, {sizeOf(action.result.bytes)}. It holds the books as they stood when you pressed the button.
          </p>
        )}
      </div>
      {failed !== null && <FailureNotice failed={failed} className="sf-act__result" />}
    </div>
  );
}
