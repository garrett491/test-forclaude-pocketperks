/**
 * Generates the awkward test images the QA matrix needs: very wide, very
 * tall, square, portrait, landscape, transparent, white, dark, a flyer with
 * text in it, and a low-resolution logo.
 *
 * Every image carries a solid 6px frame and a label in each corner. If any
 * part of the frame or any corner label is missing on screen, the image was
 * cropped — which makes "no cropping" something a screenshot can prove.
 *
 * Test tooling only. Uses sharp, which Astro already installs.
 */
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || join(process.cwd(), '.supabase-local', 'storage', 'merchant-media', 'fixtures');
mkdirSync(OUT, { recursive: true });

const specs = [
  { name: 'logo-very-wide', w: 1200, h: 240, bg: 'transparent', fg: '#12611B', text: 'CROSSROADS PIZZA' },
  { name: 'logo-very-tall', w: 240, h: 900, bg: '#FFFFFF', fg: '#060E22', text: 'TALL' },
  { name: 'logo-square-dark', w: 600, h: 600, bg: '#101310', fg: '#A8DE8F', text: 'SQ' },
  { name: 'logo-lowres', w: 40, h: 40, bg: '#FFFFFF', fg: '#B3261E', text: 'L' },
  { name: 'logo-white-bg', w: 800, h: 400, bg: '#FFFFFF', fg: '#12611B', text: 'WIDE AWAKE' },
  { name: 'photo-landscape-16x9', w: 1600, h: 900, bg: '#6B8E6B', fg: '#FFFFFF', text: '16:9 STOREFRONT' },
  { name: 'photo-portrait-3x4', w: 900, h: 1200, bg: '#8E6B6B', fg: '#FFFFFF', text: '3:4 PORTRAIT' },
  { name: 'photo-panorama-2x1', w: 1600, h: 800, bg: '#6B6B8E', fg: '#FFFFFF', text: '2:1 PANORAMA' },
  { name: 'photo-4x3', w: 1200, h: 900, bg: '#5A6B5C', fg: '#FFFFFF', text: '4:3 FOOD' },
  { name: 'photo-1x2', w: 700, h: 1400, bg: '#3E7F27', fg: '#FFFFFF', text: '1:2 TALL' },
  { name: 'flyer-9x16', w: 900, h: 1600, bg: '#FFF7E0', fg: '#7A1F1F', text: 'FLYER $5 OFF', flyer: true },
];

function svg({ w, h, bg, fg, text, flyer }) {
  const frame = 6;
  const size = Math.max(10, Math.min(w, h) / 6);
  const corner = Math.max(8, Math.min(w, h) / 14);
  const lines = flyer
    ? `<text x="50%" y="42%" font-size="${size}" text-anchor="middle" fill="${fg}" font-family="sans-serif" font-weight="700">$5 OFF</text>
       <text x="50%" y="55%" font-size="${size / 2.5}" text-anchor="middle" fill="${fg}" font-family="sans-serif">Any order over $25</text>
       <text x="50%" y="92%" font-size="${size / 3.5}" text-anchor="middle" fill="${fg}" font-family="sans-serif">Expires Dec 31 · One per visit · Fine print at bottom</text>`
    : `<text x="50%" y="55%" font-size="${size}" text-anchor="middle" fill="${fg}" font-family="sans-serif" font-weight="700">${text}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${bg === 'transparent' ? '' : `<rect width="100%" height="100%" fill="${bg}"/>`}
    <rect x="${frame / 2}" y="${frame / 2}" width="${w - frame}" height="${h - frame}" fill="none" stroke="#E0218A" stroke-width="${frame}"/>
    <text x="${frame * 2}" y="${corner + frame}" font-size="${corner}" fill="#E0218A" font-family="sans-serif">TL</text>
    <text x="${w - frame * 2}" y="${corner + frame}" font-size="${corner}" fill="#E0218A" font-family="sans-serif" text-anchor="end">TR</text>
    <text x="${frame * 2}" y="${h - frame * 2}" font-size="${corner}" fill="#E0218A" font-family="sans-serif">BL</text>
    <text x="${w - frame * 2}" y="${h - frame * 2}" font-size="${corner}" fill="#E0218A" font-family="sans-serif" text-anchor="end">BR</text>
    ${lines}
  </svg>`;
}

for (const spec of specs) {
  const buffer = Buffer.from(svg(spec));
  await sharp(buffer).webp({ quality: 82 }).toFile(join(OUT, `${spec.name}.webp`));
  if (spec.w > 640 || spec.h > 640) {
    await sharp(buffer).resize({ width: spec.w >= spec.h ? 640 : undefined, height: spec.h > spec.w ? 640 : undefined })
      .webp({ quality: 80 }).toFile(join(OUT, `${spec.name}-640.webp`));
  }
}
console.log(`wrote ${specs.length} fixture images to ${OUT}`);
