import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const publicDir = path.resolve('public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// 1. Regular icon SVG (Clean Notes notepad with pencil and ruled lines)
const notesSvgStandard = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FBBF24" />
      <stop offset="100%" stop-color="#D97706" />
    </linearGradient>
    <linearGradient id="paperGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF" />
      <stop offset="100%" stop-color="#F8FAFC" />
    </linearGradient>
    <linearGradient id="pencilGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#F59E0B" />
      <stop offset="100%" stop-color="#B45309" />
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="125%" height="125%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000000" flood-opacity="0.25" />
    </filter>
    <filter id="paperShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000000" flood-opacity="0.1" />
    </filter>
  </defs>

  <!-- Background Squircle / Pad Base -->
  <rect x="32" y="32" width="448" height="448" rx="100" ry="100" fill="url(#bgGrad)" filter="url(#shadow)" />

  <!-- Notepad Paper Sheet -->
  <rect x="76" y="80" width="360" height="352" rx="28" ry="28" fill="url(#paperGrad)" filter="url(#paperShadow)" />

  <!-- Yellow Accent Top Header of Paper Sheet -->
  <path d="M 76 108 C 76 92.5 88.5 80 104 80 L 408 80 C 423.5 80 436 92.5 436 108 L 436 140 L 76 140 Z" fill="#F59E0B" />

  <!-- Spiral / Ring Binders at the Top -->
  <circle cx="130" cy="78" r="8" fill="#475569" />
  <circle cx="180" cy="78" r="8" fill="#475569" />
  <circle cx="230" cy="78" r="8" fill="#475569" />
  <circle cx="280" cy="78" r="8" fill="#475569" />
  <circle cx="330" cy="78" r="8" fill="#475569" />
  <circle cx="380" cy="78" r="8" fill="#475569" />

  <!-- Ruled Notes Lines -->
  <rect x="116" y="180" width="220" height="12" rx="6" fill="#E2E8F0" />
  <rect x="116" y="224" width="280" height="12" rx="6" fill="#E2E8F0" />
  <rect x="116" y="268" width="260" height="12" rx="6" fill="#E2E8F0" />
  <rect x="116" y="312" width="240" height="12" rx="6" fill="#E2E8F0" />
  <rect x="116" y="356" width="180" height="12" rx="6" fill="#E2E8F0" />

  <!-- Checkmark or Bullet accent on the first line -->
  <circle cx="132" cy="186" r="6" fill="#F59E0B" />
  <circle cx="132" cy="230" r="6" fill="#10B981" />
  <circle cx="132" cy="274" r="6" fill="#6366F1" />

  <!-- Stylized Pencil in bottom right -->
  <g transform="translate(290, 270) rotate(-35)">
    <rect x="0" y="0" width="140" height="24" rx="6" fill="url(#pencilGrad)" />
    <!-- Pencil Tip -->
    <polygon points="140,0 170,12 140,24" fill="#FDE68A" />
    <polygon points="160,8 170,12 160,16" fill="#1E293B" />
    <!-- Pencil Eraser and Ferrule -->
    <rect x="-16" y="0" width="16" height="24" rx="4" fill="#F43F5E" />
    <rect x="-6" y="0" width="6" height="24" fill="#94A3B8" />
  </g>
</svg>`;

// 2. Maskable Icon SVG (Safe zone within central 80% circle, padded for Android adaptive icons)
const notesSvgMaskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="mBgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#D97706" />
      <stop offset="100%" stop-color="#B45309" />
    </linearGradient>
    <linearGradient id="mPaperGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF" />
      <stop offset="100%" stop-color="#F8FAFC" />
    </linearGradient>
    <linearGradient id="mPencilGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#F59E0B" />
      <stop offset="100%" stop-color="#B45309" />
    </linearGradient>
    <filter id="mShadow" x="-10%" y="-10%" width="125%" height="125%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.3" />
    </filter>
  </defs>

  <!-- Full-bleed background for maskable boundary -->
  <rect width="512" height="512" fill="url(#mBgGrad)" />

  <!-- Inner safe zone content (within 60px - 452px) -->
  <g transform="translate(16, 16)">
    <!-- Notepad Paper Sheet -->
    <rect x="90" y="80" width="300" height="320" rx="24" ry="24" fill="url(#mPaperGrad)" filter="url(#mShadow)" />

    <!-- Yellow Accent Top Header -->
    <path d="M 90 104 C 90 90.7 100.7 80 114 80 L 366 80 C 379.3 80 390 90.7 390 104 L 390 130 L 90 130 Z" fill="#F59E0B" />

    <!-- Ruled Notes Lines -->
    <rect x="120" y="165" width="200" height="10" rx="5" fill="#E2E8F0" />
    <rect x="120" y="205" width="240" height="10" rx="5" fill="#E2E8F0" />
    <rect x="120" y="245" width="220" height="10" rx="5" fill="#E2E8F0" />
    <rect x="120" y="285" width="200" height="10" rx="5" fill="#E2E8F0" />
    <rect x="120" y="325" width="160" height="10" rx="5" fill="#E2E8F0" />

    <!-- Bullets -->
    <circle cx="134" cy="170" r="5" fill="#F59E0B" />
    <circle cx="134" cy="210" r="5" fill="#10B981" />
    <circle cx="134" cy="250" r="5" fill="#6366F1" />

    <!-- Stylized Pencil -->
    <g transform="translate(260, 270) rotate(-35)">
      <rect x="0" y="0" width="120" height="20" rx="5" fill="url(#mPencilGrad)" />
      <polygon points="120,0 145,10 120,20" fill="#FDE68A" />
      <polygon points="135,7 145,10 135,13" fill="#1E293B" />
      <rect x="-12" y="0" width="12" height="20" rx="3" fill="#F43F5E" />
    </g>
  </g>
</svg>`;

async function run() {
  console.log('Writing public/icon.svg...');
  fs.writeFileSync(path.join(publicDir, 'icon.svg'), notesSvgStandard);

  console.log('Generating pwa-512x512.png...');
  await sharp(Buffer.from(notesSvgStandard))
    .resize(512, 512)
    .png()
    .toFile(path.join(publicDir, 'pwa-512x512.png'));

  console.log('Generating pwa-192x192.png...');
  await sharp(Buffer.from(notesSvgStandard))
    .resize(192, 192)
    .png()
    .toFile(path.join(publicDir, 'pwa-192x192.png'));

  console.log('Generating apple-touch-icon.png (180x180)...');
  await sharp(Buffer.from(notesSvgStandard))
    .resize(180, 180)
    .png()
    .toFile(path.join(publicDir, 'apple-touch-icon.png'));

  console.log('Generating pwa-maskable-512x512.png...');
  await sharp(Buffer.from(notesSvgMaskable))
    .resize(512, 512)
    .png()
    .toFile(path.join(publicDir, 'pwa-maskable-512x512.png'));

  console.log('Generating favicon.ico / favicon.png...');
  await sharp(Buffer.from(notesSvgStandard))
    .resize(48, 48)
    .png()
    .toFile(path.join(publicDir, 'favicon.png'));

  console.log('All Notes PWA icons successfully generated!');
}

run().catch(console.error);
