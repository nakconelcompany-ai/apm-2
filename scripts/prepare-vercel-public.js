const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const files = [
  'index.html',
  'admin.html',
  'thankyou.html',
  'adedeji-dhikrullahi.html',
  'akin-fagbemi.html',
  'bimbola-adekanmbi.html',
  'seyi-makinde.html',
  'apm1.jfif',
  'apm7.jfif',
  'apm9.jfif',
  'apm10.jfif',
  'apm11.jfif',
  'apm logo.jfif',
  'apm-oyo-fingerprint.png',
  'apm-campaign-banner.png',
  'apm-campaign-poster-mobile.png',
  'slide 1.png',
  'slide 2.png',
  'slide 3.png',
  'slide 4.png',
  'slide 5.png',
  'hero-mobile.jpg',
  'pci-team-2027.jpg'
];

fs.mkdirSync(publicDir, { recursive: true });

for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(publicDir, file));
}

console.log(`Prepared ${files.length} static files for Vercel.`);
