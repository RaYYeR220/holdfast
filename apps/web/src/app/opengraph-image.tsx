import { socialCardPicture } from '@/ui/onebit/pictures';
import { encodePng } from '@/ui/onebit/png';

export const alt = 'Holdfast. Lock your runway. Keep your keys. A ship held by a chain to an anchor, drawn in two colours.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** The card for a shared link: 240 by 126 design pixels at five image pixels each. */
export default function OpenGraphImage(): Response {
  const { bits, w, h } = socialCardPicture();
  return new Response(new Uint8Array(encodePng(bits, w, h, 5)), { headers: { 'content-type': contentType } });
}
