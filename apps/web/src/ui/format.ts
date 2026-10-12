/**
 * How figures, moments and identifiers are written out. Plain functions with
 * no locale or time zone of their own, so the server and every browser
 * produce the same text.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** A moment as `2026-10-12 14:03 UTC`. */
export function formatUtc(ms: number, seconds = false): string {
  const d = new Date(ms);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ''}`;
  return `${day} ${time} UTC`;
}

/** How long ago a moment was, in the largest unit that fits: "12 s ago", "3 min ago", "5 h ago", "2 d ago". */
export function formatAgo(ms: number, now: number): string {
  const seconds = Math.round((now - ms) / 1000);
  if (seconds < -5) return 'in the future';
  if (seconds < 5) return 'just now';
  if (seconds < 90) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function grouped(value: number, digits: number): string {
  const [whole = '0', fraction] = Math.abs(value).toFixed(digits).split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? withCommas : `${withCommas}.${fraction}`;
}

/** A number with thousands separators and a fixed count of decimals. Negative values take a true minus sign. */
export function formatNumber(value: number, digits = 0): string {
  return `${value < 0 ? '−' : ''}${grouped(value, digits)}`;
}

/** Dollars: `$1,226.40`. */
export function formatUsd(value: number, digits = 2): string {
  return `${value < 0 ? '−' : ''}$${grouped(value, digits)}`;
}

/** A percentage with one decimal and a true minus sign: `−47.4%`. */
export function formatPct(value: number, digits = 1): string {
  return `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}%`;
}

/** Basis points as a percentage: 9000 is `90.0%`. */
export function formatBps(bps: number, digits = 1): string {
  return formatPct(bps / 100, digits);
}

/** The ends of a long identifier with the middle left out: `0x2246d8…b9bce9`. */
export function shorten(id: string, head = 8, tail = 6): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}
