// Renders assets/logo.svg into the PNG/ICO sizes the app and installer need.
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const sizes = [16, 20, 24, 32, 48, 64, 128, 256];
const pngs = {};
for (const s of sizes) {
  pngs[s] = await sharp('assets/logo.svg', { density: 600 }).resize(s, s).png().toBuffer();
}
writeFileSync('assets/tray.png', pngs[32]);
writeFileSync('assets/icon.png', await sharp('assets/logo.svg', { density: 600 }).resize(512, 512).png().toBuffer());

// Minimal ICO writer: PNG-compressed entries are valid for Vista+.
const entries = sizes.map((s) => ({ s, buf: pngs[s] }));
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach(({ s, buf }, i) => {
  const o = 6 + i * 16;
  header.writeUInt8(s >= 256 ? 0 : s, o);
  header.writeUInt8(s >= 256 ? 0 : s, o + 1);
  header.writeUInt8(0, o + 2);
  header.writeUInt8(0, o + 3);
  header.writeUInt16LE(1, o + 4);
  header.writeUInt16LE(32, o + 6);
  header.writeUInt32LE(buf.length, o + 8);
  header.writeUInt32LE(offset, o + 12);
  offset += buf.length;
});
writeFileSync('assets/icon.ico', Buffer.concat([header, ...entries.map((e) => e.buf)]));
console.log('icons written');
