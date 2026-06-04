const fs = require('fs');
const path = require('path');

const pngPath = path.join(__dirname, 'src', 'assets', 'SNT-Logo.png');
const icoPath = path.join(__dirname, 'src', 'assets', 'SNT-Logo.ico');

if (fs.existsSync(pngPath)) {
  const pngBuf = fs.readFileSync(pngPath);
  
  // 6-byte ICO Header
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type (1 = ICO)
  header.writeUInt16LE(1, 4); // Number of images
  
  // 16-byte Directory Entry
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0); // Width (0 means 256px)
  entry.writeUInt8(0, 1); // Height (0 means 256px)
  entry.writeUInt8(0, 2); // Color count (0 for >256 colors)
  entry.writeUInt8(0, 3); // Reserved
  entry.writeUInt16LE(1, 4); // Color planes
  entry.writeUInt16LE(32, 6); // Bits per pixel
  entry.writeUInt32LE(pngBuf.length, 8); // Size of PNG data
  entry.writeUInt32LE(22, 12); // Offset of PNG data (header + entry size = 6 + 16 = 22)
  
  const icoBuf = Buffer.concat([header, entry, pngBuf]);
  fs.writeFileSync(icoPath, icoBuf);
  console.log('✓ Successfully created SNT-Logo.ico from SNT-Logo.png!');
} else {
  console.log('Error: SNT-Logo.png not found.');
}
