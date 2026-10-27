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
  'senate.html',
  'house-reps.html',
  'apm1.jfif',
  'apm7.jfif',
  'apm9.jfif',
  'apm10.jfif',
  'apm11.jfif',
  'apm20.jpg',
  'apm logo.jfif',
  'apm-oyo-fingerprint.png',
  'apm-campaign-banner.png',
  'apm-campaign-poster-mobile.png',
  'apm-oyo-leadership-team.png',
  'apm-oyo-full-team.png',
  'apm-oyo-senate-team.png',
  'apm-oyo-house-team.png',
  'apm-shina-peller.jpeg',
  'apm-olufemi-ajadi.jpg',
  'apm-kolawole-adedeji.jpeg',
  'house-akin-fagbemi.jpg',
  'house-kolawole-sheu.jpg',
  'house-folajimi-oyekunle.jpg',
  'house-abass-adigun.jpg',
  'house-sunday-makanjuola.jpg',
  'house-john-adisa-oke.jpg',
  'house-najimdeen-oyedeji.jpg',
  'house-toheeb-adegoke.jpg',
  'house-akeem-olatunji.jpg',
  'house-seun-ashamu.jpg',
  'house-ezekiel-oladimeji.jpg',
  'house-anthony-adepoju.jpg',
  'house-adeniyi-adebisi.jpg',
  'apm-bimbo-open-salawu.jpeg',
  'apm-salaudeen-adebayo.jpeg',
  'apm-omituntun.jpeg',
  'hero-mobile.jpg',
  'pci-team-2027.jpg'
];

fs.mkdirSync(publicDir, { recursive: true });

for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(publicDir, file));
}

console.log(`Prepared ${files.length} static files for Vercel.`);
