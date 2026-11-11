const { PNG } = require('pngjs');

const sourceWidth = 3071;
const sourceHeight = 3067;
const chirpDivisor = 4096;
const maxStddev = 1.5;

function zonePlateFixture() {
  const png = new PNG({ width: sourceWidth, height: sourceHeight });
  for (let y = 0; y < sourceHeight; y++) for (let x = 0; x < sourceWidth; x++) {
    const dx = x - (sourceWidth - 1) / 2, dy = y - (sourceHeight - 1) / 2;
    const value = Math.round(127.5 + 127.5 * Math.sin(Math.PI * (dx * dx + dy * dy) / chirpDivisor));
    png.data.set([value, value, value, 255], (y * sourceWidth + x) * 4);
  }
  return { name: 'zone-plate.png', mimeType: 'image/png', buffer: PNG.sync.write(png) };
}

function analyzeZonePlate(result, crop) {
  const values = [];
  let minNyquistRatio = Infinity;
  for (let y = 0; y < result.height; y++) for (let x = 0; x < result.width; x++) {
    const radius = Math.hypot(x + 0.5 - result.width / 2, y + 0.5 - result.height / 2);
    if (radius < 20 || radius > 60) continue;
    const sx = crop.x + (x + 0.5) / crop.zoom - 0.5;
    const sy = crop.y + (y + 0.5) / crop.zoom - 0.5;
    const fx = (sx - (sourceWidth - 1) / 2) / chirpDivisor;
    const fy = (sy - (sourceHeight - 1) / 2) / chirpDivisor;
    minNyquistRatio = Math.min(minNyquistRatio, Math.max(Math.abs(fx), Math.abs(fy)) / (crop.zoom / 2));
    const i = (y * result.width + x) * 4;
    values.push((result.data[i] + result.data[i + 1] + result.data[i + 2]) / 3);
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const stddev = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  return { mean, stddev, minNyquistRatio, samples: values.length };
}

module.exports = { zonePlateFixture, analyzeZonePlate, maxStddev };
