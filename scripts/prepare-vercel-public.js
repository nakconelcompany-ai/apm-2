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
  'hero-mobile.jpg',
  'pci-team-2027.jpg'
];

fs.mkdirSync(publicDir, { recursive: true });

for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(publicDir, file));
}

console.log(`Prepared ${files.length} static files for Vercel.`);
