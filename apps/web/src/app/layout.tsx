import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { fontVariables } from '@/ui/fonts';
import { INK_HEX } from '@/ui/onebit/raster';
import '@/ui/global.css';
import '@/ui/components.css';
import '@/ui/shell.css';

const DESCRIPTION = 'Holdfast fixes the dollar value of a ZEC treasury and pays your team in stablecoins, using only keys that cannot take your treasury.';

/** The address the pages are served from, for the absolute links of the metadata. */
function siteUrl(): URL {
  const host = process.env.HOLDFAST_PUBLIC_HOST ?? process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (host !== undefined && host !== '') return new URL(`https://${host}`);
  return new URL('http://localhost:3000');
}

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: 'Holdfast: lock your runway, keep your keys', template: '%s · Holdfast' },
  description: DESCRIPTION,
  applicationName: 'Holdfast',
  openGraph: {
    type: 'website',
    siteName: 'Holdfast',
    title: 'Holdfast: lock your runway, keep your keys',
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Holdfast: lock your runway, keep your keys',
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  themeColor: INK_HEX,
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>
      <body>{children}</body>
    </html>
  );
}
