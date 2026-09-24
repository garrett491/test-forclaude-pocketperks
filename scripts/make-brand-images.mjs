/**
 * Builds the raster brand images from the SVGs in public/:
 *   og-default.png        1200×630 link preview (Facebook, texts, email)
 *   logo.png              512×512 square, for search engines' logo field
 *   apple-touch-icon.png  180×180 home-screen icon
 *
 * Re-run after replacing the SVG artwork:  node scripts/make-brand-images.mjs
 * (An uploaded "Link preview image" in admin Settings overrides og-default.)
 */
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const mark = readFileSync('public/logo-mark-light.svg', 'utf8')
  .replace(/<svg[^>]*>/, '').replace('</svg>', '');

const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#093814"/>
  <rect x="24" y="24" width="1152" height="582" rx="28" fill="none" stroke="#56A837" stroke-width="4" stroke-dasharray="18 12"/>
  <g transform="translate(96 175) scale(4.4)">${mark}</g>
  <text x="420" y="300" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="104" fill="#FFFFFF">Pocket Perks</text>
  <text x="424" y="380" font-family="Helvetica, Arial, sans-serif" font-size="42" fill="#A8DE8F">Local deals from businesses near you</text>
</svg>`;

const square = (size, radius) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="${radius}" fill="#093814"/>${mark}</svg>`;

await sharp(Buffer.from(og)).png({ compressionLevel: 9 }).toFile('public/og-default.png');
await sharp(Buffer.from(square(512, 0))).png().toFile('public/logo.png');
await sharp(Buffer.from(square(180, 0))).png().toFile('public/apple-touch-icon.png');
console.log('brand images written');
