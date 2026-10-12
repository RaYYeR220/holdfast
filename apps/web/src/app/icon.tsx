import { iconPicture } from '@/ui/onebit/pictures';
import { encodePng } from '@/ui/onebit/png';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

/** The browser tab icon: the anchor, sixteen design pixels at two image pixels each. */
export default function Icon(): Response {
  const { bits, w, h } = iconPicture();
  return new Response(new Uint8Array(encodePng(bits, w, h, 2)), { headers: { 'content-type': contentType } });
}
