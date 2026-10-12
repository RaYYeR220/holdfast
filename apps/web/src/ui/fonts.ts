import { Bitcount_Prop_Single, IBM_Plex_Mono, IM_Fell_DW_Pica } from 'next/font/google';

/**
 * The three faces, served from this application. All three are published
 * under the SIL Open Font License 1.1.
 *
 * - Bitcount Prop Single: the pixel face, for headings, labels and short
 *   figures. Its ELSH axis shapes the pixels; the pages set it to 50.
 * - IM Fell DW Pica: the old-style serif, for everything read as a sentence.
 * - IBM Plex Mono: aligned figures, hashes and addresses in dense tables.
 */

export const pixelFace = Bitcount_Prop_Single({
  subsets: ['latin'],
  axes: ['ELSH'],
  display: 'swap',
  variable: '--font-px',
  fallback: ['Courier New', 'monospace'],
});

export const textFace = IM_Fell_DW_Pica({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-text',
  fallback: ['Iowan Old Style', 'Palatino Linotype', 'Georgia', 'serif'],
});

export const numericFace = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
  variable: '--font-num',
  fallback: ['ui-monospace', 'Consolas', 'monospace'],
});

/** Class names that define the --font-* variables; put them on <html>. */
export const fontVariables = `${pixelFace.variable} ${textFace.variable} ${numericFace.variable}`;
