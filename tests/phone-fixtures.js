const generated = new Map();

async function phoneJPEG(playwright, width = 8064, height = 6048) {
  const key = `${width}x${height}`;
  if (!generated.has(key)) generated.set(key, (async () => {
    const browser = await playwright.chromium.launch();
    try {
      const page = await browser.newPage();
      const base64 = await page.evaluate(({ width, height }) => {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ['red', 'lime', 'blue', 'yellow'].forEach((color, i) => {
          ctx.fillStyle = color;
          ctx.fillRect(i % 2 * width / 2, Math.floor(i / 2) * height / 2, width / 2, height / 2);
        });
        const result = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
        canvas.width = canvas.height = 0;
        return result;
      }, { width, height });
      return Buffer.from(base64, 'base64');
    } finally { await browser.close(); }
  })());
  return generated.get(key);
}

function rotatedJPEG(buffer) {
  const exif = Buffer.from('ffe1002245786966000049492a0008000000010012010300010000000600000000000000', 'hex');
  return Buffer.concat([buffer.subarray(0, 2), exif, buffer.subarray(2)]);
}

function memoryProbe() {
  const canvases = new Map(), bitmaps = new Set(), urls = new Map();
  const state = { peakCanvasBytes: 0, maxCanvasArea: 0, peakBitmapBytes: 0, currentBitmapBytes: 0, currentCanvasBytes: 0, activeURLs: 0 };
  function sample() {
    let canvasBytes = 0, bitmapBytes = 0;
    for (const canvas of canvases.keys()) {
      const area = canvas.width * canvas.height;
      canvasBytes += area * 4;
      state.maxCanvasArea = Math.max(state.maxCanvasArea, area);
    }
    for (const bitmap of bitmaps) {
      if (!bitmap.width) bitmaps.delete(bitmap);
      else bitmapBytes += bitmap.width * bitmap.height * 4;
    }
    state.currentCanvasBytes = canvasBytes;
    state.currentBitmapBytes = bitmapBytes;
    state.peakCanvasBytes = Math.max(state.peakCanvasBytes, canvasBytes);
    state.peakBitmapBytes = Math.max(state.peakBitmapBytes, bitmapBytes);
    state.activeURLs = urls.size;
    state.activeImageURLs = [...urls.values()].filter(blob => blob.type.startsWith('image/')).length;
    state.activeScriptURLs = state.activeURLs - state.activeImageURLs;
    return { ...state };
  }
  for (const key of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key);
    Object.defineProperty(HTMLCanvasElement.prototype, key, { ...descriptor, set(value) {
      descriptor.set.call(this, value); canvases.set(this, true); sample();
    } });
  }
  if (window.createImageBitmap) {
    const create = window.createImageBitmap;
    window.createImageBitmap = async (...args) => {
      const bitmap = await create(...args); bitmaps.add(bitmap); sample(); return bitmap;
    };
  }
  const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL;
  URL.createObjectURL = function (blob) { const url = createURL.call(this, blob); urls.set(url, { size: blob.size, type: blob.type }); sample(); return url; };
  URL.revokeObjectURL = function (url) { urls.delete(url); revokeURL.call(this, url); sample(); };
  window.phoneMemory = sample;
}

module.exports = { phoneJPEG, rotatedJPEG, memoryProbe };
