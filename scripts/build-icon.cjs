const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'build', 'icon.png');
const outputPath = path.join(root, 'build', 'icon.ico');
const rendererPath = path.join(root, 'public', 'icon.png');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const source = nativeImage.createFromPath(sourcePath);

if (source.isEmpty()) throw new Error(`Could not load ${sourcePath}`);

const images = sizes.map((size) => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
const directorySize = 6 + images.length * 16;
let offset = directorySize;
const header = Buffer.alloc(directorySize);

header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

images.forEach((image, index) => {
  const entry = 6 + index * 16;
  const size = sizes[index];
  header.writeUInt8(size === 256 ? 0 : size, entry);
  header.writeUInt8(size === 256 ? 0 : size, entry + 1);
  header.writeUInt8(0, entry + 2);
  header.writeUInt8(0, entry + 3);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
});

fs.writeFileSync(outputPath, Buffer.concat([header, ...images]));
fs.mkdirSync(path.dirname(rendererPath), { recursive: true });
fs.writeFileSync(rendererPath, source.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
console.log(`Wrote ${outputPath} (${sizes.join(', ')} px) and ${rendererPath}`);
app.exit(0);
