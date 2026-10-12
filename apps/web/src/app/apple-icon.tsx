import { iconPicture } from '@/ui/onebit/pictures';
import { encodePng } from '@/ui/onebit/png';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/** The home screen icon: the anchor with one design pixel of ink round it, at ten image pixels each. */
export default function AppleIcon(): Response {
  const { bits, w, h } = iconPicture(1);
  return new Response(new Uint8Array(encodePng(bits, w, h, 10)), { headers: { 'content-type': contentType } });
}
