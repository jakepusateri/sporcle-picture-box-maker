const { test: base, expect } = require('@playwright/test');
const { PNG } = require('pngjs');
const fs = require('node:fs');
const path = require('node:path');

const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
function fixture(kind = 'quadrants', width = 400, height = 300) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let color = typeof kind === 'number' ? colors[kind] : colors[(x >= width / 2 ? 1 : 0) + (y >= height / 2 ? 2 : 0)];
    if (kind === 'frequency') color = Array(3).fill(x % 2 * 255);
    if (kind === 'detail') color = Array(3).fill(Math.round(128 + 55 * Math.sin(x / 6) + 35 * Math.sin(y / 9) + 20 * Math.sin((x + y) / 21)));
    const offset = (y * width + x) * 4;
    png.data.set([...color, 255], offset);
  }
  return { name: 'generated.png', mimeType: 'image/png', buffer: PNG.sync.write(png) };
}

const test = base.extend({
  blockPica: [false, { option: true }],
  page: async ({ page, blockPica }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      if (blockPica && message.location().url === 'https://cdn.jsdelivr.net/npm/pica@9.0.1/dist/pica.js' && /net::ERR_FAILED/.test(message.text())) return;
      errors.push(message.text());
    });
    if (blockPica) await page.route('https://cdn.jsdelivr.net/npm/pica@9.0.1/dist/pica.js', route => route.abort('failed'));
    await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
    await page.addInitScript(() => {
      window.testDecodes = [];
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () {
        const pending = decode.call(this);
        window.testDecodes.push(pending);
        return pending;
      };
      window.testCroppies = [];
      Object.defineProperty(window, 'Croppie', {
        configurable: true,
        set(Constructor) {
          Object.defineProperty(window, 'Croppie', { value: new Proxy(Constructor, {
            construct(target, args) {
              const instance = Reflect.construct(target, args);
              window.testCroppies.push(instance);
              return instance;
            },
          }), configurable: true });
        },
      });
    });
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => typeof Croppie)).toBe('function');
    await use(page);
    if (errors.length) base.info().expectedStatus = 'passed';
    expect(errors, 'No page errors or unexpected console errors').toEqual([]);
  },
});

async function create(page, count = 4, width = 150, height = 150) {
  for (const [id, value] of Object.entries({ count, width, height })) await page.locator(`#${id}`).fill(String(value));
  await page.locator('#create-boxes').click();
}
async function upload(page, i, file = fixture(i % 4)) {
  await page.locator(`#upload-${i}`).setInputFiles(file);
  await expect.poll(() => page.evaluate(i => {
    const c = window.testCroppies.findLast(c => c.element.id === `upload-demo-${i}`);
    return !!c?.data.url && c.elements.img.complete && c.get().zoom > 0;
  }, i)).toBe(true);
  // Croppie finishes binding on an animation frame after image load.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function render(page) {
  const previous = await page.locator('#result').getAttribute('src');
  await page.locator('#final-render').click();
  await expect.poll(() => page.locator('#result').getAttribute('src')).not.toBe(previous);
  await page.locator('#result').evaluate(img => img.decode());
  return page.locator('#result').getAttribute('src');
}
async function pixels(page) {
  return page.locator('#result').evaluate(img => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    return { width: canvas.width, height: canvas.height, data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data) };
  });
}
async function slots(page, expected, width = 150, height = 150) {
  const result = await pixels(page);
  expect([result.width, result.height]).toEqual([width, height * expected.length]);
  expected.forEach((color, i) => color.forEach((channel, j) => {
    const offset = ((i * height + Math.floor(height / 2)) * width + Math.floor(width / 2)) * 4;
    expect(Math.abs(result.data[offset + j] - channel)).toBeLessThanOrEqual(8);
  }));
}

test('F1 defaults and initial output', async ({ page }) => {
  for (const [id, value] of Object.entries({ width: '150', height: '150', count: '4', columns: '2', quality: '1.0' })) await expect(page.locator(`#${id}`)).toHaveValue(value);
  await expect(page.locator('#download-link')).toBeHidden();
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#sharpen')).toBeChecked();
  expect(await page.evaluate(() => typeof pica)).toBe('function');
});
test('F2 Create builds viewports and upload inputs', async ({ page }) => {
  await create(page, 3, 180, 120);
  await expect(page.locator('.grid-wrapper > .container')).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(page.locator(`#upload-${i}`)).toHaveAttribute('type', 'file');
    expect(await page.locator(`#upload-demo-${i} .cr-viewport`).evaluate(el => [parseFloat(el.style.width), parseFloat(el.style.height)])).toEqual([180, 120]);
  }
});
test('F3 upload binds even a 64x64 image', async ({ page }) => {
  await create(page, 1); await upload(page, 0, fixture(0, 64, 64));
  await expect(page.locator('#upload-demo-0 .cr-image')).toHaveAttribute('src', /^data:image\/png/);
});
test('F4 JPEG output and download', async ({ page }) => {
  await create(page); await upload(page, 0); const src = await render(page);
  expect(src).toMatch(/^blob:/);
  expect(await page.evaluate(async src => (await fetch(src)).headers.get('content-type'), src)).toBe('image/jpeg');
  expect(await page.locator('#result').evaluate(img => [img.naturalWidth, img.naturalHeight])).toEqual([150, 600]);
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#download-link')).toBeVisible();
  await expect(page.locator('#download-link')).toHaveAttribute('href', src);
  await expect(page.locator('#download-link')).toHaveAttribute('download', 'picture-box-150x150.jpg');
});
test('F5 slots follow upload order', async ({ page }) => {
  await create(page); for (let i = 0; i < 4; i++) await upload(page, i);
  await render(page); await slots(page, colors);
});
test('F6 empty boxes are white', async ({ page }) => {
  await create(page, 3); await upload(page, 1); await render(page);
  await slots(page, [[255, 255, 255], colors[1], [255, 255, 255]]);
});
test('F7 count changes preserve earlier uploads', async ({ page }) => {
  await create(page, 2); await upload(page, 0); await upload(page, 1);
  await create(page, 4); await render(page); await slots(page, [colors[0], colors[1], [255, 255, 255], [255, 255, 255]]);
  await create(page, 1); await expect(page.locator('.grid-wrapper > .container')).toHaveCount(1);
  await render(page); await slots(page, [colors[0]]);
});
test('F8 Reset and fresh reuse', async ({ page }) => {
  await create(page, 1); await upload(page, 0); await render(page);
  await page.locator('#reset-all').click();
  await expect(page.locator('.grid-wrapper > *')).toHaveCount(0);
  await expect(page.locator('#result')).toBeHidden(); await expect(page.locator('#download-link')).toBeHidden();
  await create(page, 1); await upload(page, 0, fixture(2)); await render(page); await slots(page, [colors[2]]);
});
test('F9 lower JPEG quality reduces size', async ({ page }) => {
  await create(page, 1); await upload(page, 0, fixture()); const high = await render(page);
  const highSize = await page.evaluate(async url => (await (await fetch(url)).blob()).size, high);
  await page.locator('#quality').fill('0.3'); const low = await render(page);
  const lowSize = await page.evaluate(async url => (await (await fetch(url)).blob()).size, low);
  expect(lowSize).toBeLessThan(highSize);
});

function meanDiff(a, b) {
  expect(a.length).toBe(b.length);
  let total = 0; for (let i = 0; i < a.length; i++) if (i % 4 !== 3) total += Math.abs(a[i] - b[i]);
  return total / (a.length / 4 * 3);
}
for (const sharpen of [false, true]) test(`F10 non-default crop, Sharpen ${sharpen ? 'on' : 'off'}`, async ({ page }) => {
  await page.locator('#sharpen').setChecked(sharpen);
  await create(page, 1); await upload(page, 0, fixture());
  await page.evaluate(async () => {
    const c = window.testCroppies[0];
    await c.bind({ url: c.data.url, points: [70, 30, 270, 230] });
    c.setZoom(0.9);
  });
  await render(page); const actual = await pixels(page);
  const reference = await page.evaluate(() => {
    const c = window.testCroppies[0], { points, zoom } = c.get();
    const canvas = document.createElement('canvas'); canvas.width = 150; canvas.height = 150;
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c.elements.img, Math.floor(points[0] * zoom) / zoom, Math.floor(points[1] * zoom) / zoom, 150 / zoom, 150 / zoom, 0, 0, 150, 150);
    return Array.from(ctx.getImageData(0, 0, 150, 150).data);
  });
  const referenceDiff = meanDiff(actual.data, reference);
  console.log(`F10 Sharpen ${sharpen ? 'on' : 'off'} reference mean absolute difference: ${referenceDiff}`);
  if (!sharpen) expect(referenceDiff).toBeLessThan(3);
  if (process.env.REPORT_OLD_GOLDEN === '1') {
    const old = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'golden', 'quadrant-crop.png')));
    console.log(`F10 Sharpen ${sharpen ? 'on' : 'off'} OLD golden mean absolute difference: ${meanDiff(actual.data, old.data)}`);
    return;
  }
  const goldenPath = path.join(__dirname, 'golden', `quadrant-crop-sharpen-${sharpen ? 'on' : 'off'}.png`);
  if (process.env.UPDATE_GOLDENS === '1') fs.writeFileSync(goldenPath, PNG.sync.write({ width: actual.width, height: actual.height, data: Buffer.from(actual.data) }));
  const golden = PNG.sync.read(fs.readFileSync(goldenPath));
  expect([actual.width, actual.height]).toEqual([golden.width, golden.height]);
  const goldenDiff = meanDiff(actual.data, golden.data);
  console.log(`F10 Sharpen ${sharpen ? 'on' : 'off'} golden mean absolute difference: ${goldenDiff}`);
  expect(goldenDiff).toBeLessThan(2);
});
test('F11 zoom changes subsequent render', async ({ page }) => {
  await create(page, 1); await upload(page, 0, fixture());
  await page.evaluate(async () => {
    const c = window.testCroppies[0];
    await c.bind({ url: c.data.url, points: [0, 0, 300, 300] });
  });
  await render(page);
  const before = await pixels(page);
  await page.evaluate(() => window.testCroppies[0].setZoom(1.4));
  await render(page);
  const difference = meanDiff((await pixels(page)).data, before.data);
  console.log(`F11 zoom output mean absolute difference: ${difference}`);
  expect(difference).toBeGreaterThan(1);
});
test('F12 non-square output', async ({ page }) => {
  await create(page, 3, 200, 100); for (let i = 0; i < 3; i++) await upload(page, i);
  await render(page); await slots(page, colors.slice(0, 3), 200, 100);
});

test('B1 existing viewports should resize', async ({ page }) => {
  await create(page, 1); await upload(page, 0); await create(page, 1, 200, 100);
  expect(await page.locator('.cr-viewport').evaluate(el => [parseFloat(el.style.width), parseFloat(el.style.height)])).toEqual([200, 100]);
  await render(page); await slots(page, [colors[0]], 200, 100);
});
for (const reset of [false, true]) test(`B2 Render ${reset ? 'after Reset' : 'before Create'} stays hidden`, async ({ page }) => {
  if (reset) { await create(page); await page.locator('#reset-all').click(); }
  await page.locator('#final-render').click(); await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#result')).not.toHaveAttribute('src', 'data:,');
  await expect(page.locator('#message')).toContainText('Create');
});
for (const field of ['width', 'height', 'count']) for (const value of ['', 'letters', '0', '-1']) {
  test(`B3 rejects ${field}=${JSON.stringify(value)}`, async ({ page }) => {
    await page.evaluate(() => {
      const form = document.querySelector('#dimensions-form'), submit = form.onsubmit;
      form.onsubmit = function (event) {
        try { return submit.call(this, event); }
        catch (error) { window.validationException = error.message; }
      };
    });
    if (value === 'letters') {
      await page.locator(`#${field}`).evaluate(input => { input.value = 'letters'; });
    } else await page.locator(`#${field}`).fill(value);
    await page.locator('#create-boxes').click();
    expect(await page.evaluate(() => window.validationException), 'Validation must not throw').toBeUndefined();
    await expect(page.locator('.grid-wrapper > *')).toHaveCount(0);
    await expect(page.locator('#message')).not.toBeEmpty();
    await page.locator('#final-render').click();
    await expect(page.locator('#result')).toBeHidden();
    await expect(page.locator('#result')).not.toHaveAttribute('src', 'data:,');
  });
}
test('B4 six large images render under 3000 milliseconds', async ({ page }) => {
  await create(page, 6); const large = fixture('quadrants', 4000, 3000);
  for (let i = 0; i < 6; i++) await upload(page, i, large);
  await page.evaluate(() => Promise.all(window.testDecodes));
  const milliseconds = await page.evaluate(async () => {
    const start = performance.now();
    const result = document.querySelector('#result');
    const previous = result.src;
    document.querySelector('#final-render').click();
    await new Promise(resolve => {
      const observer = new MutationObserver(() => {
        if (result.src !== previous) { observer.disconnect(); resolve(); }
      });
      observer.observe(result, { attributes: true, attributeFilter: ['src'] });
    });
    return performance.now() - start;
  });
  console.log(`B4 render time: ${milliseconds.toFixed(1)} ms`);
  await page.locator('#result').evaluate(img => img.decode());
  expect(milliseconds).toBeLessThan(3000);
});
test('B5 canvas must not contain scripts', async ({ page }) => {
  await expect(page.locator('#outcanvas script')).toHaveCount(0);
});

test('@antialias high-frequency crop has no moire', async ({ page, browserName }) => {
  await create(page, 1); await upload(page, 0, fixture('frequency', 3071, 3067));
  await render(page);
  const result = await pixels(page);
  const gray = Array.from({ length: result.width * result.height }, (_, i) => result.data[i * 4]);
  const mean = gray.reduce((sum, value) => sum + value, 0) / gray.length;
  const stddev = Math.sqrt(gray.reduce((sum, value) => sum + (value - mean) ** 2, 0) / gray.length);
  const rowMeans = Array.from({ length: result.height }, (_, y) => gray.slice(y * result.width, (y + 1) * result.width).reduce((sum, value) => sum + value, 0) / result.width);
  console.log(`Anti-alias ${browserName}: mean=${mean.toFixed(4)} std-dev=${stddev.toFixed(4)} range=${Math.max(...gray) - Math.min(...gray)}`);
  expect(Math.abs(mean - 127.5)).toBeLessThan(2);
  expect(stddev).toBeLessThan(1.5);
  expect(Math.max(...gray) - Math.min(...gray)).toBeLessThanOrEqual(6);
  expect(Math.max(...rowMeans) - Math.min(...rowMeans)).toBeLessThan(2);
  await expect(page.locator('#render-status')).not.toContainText('fallback');
});

function edgeEnergy(result) {
  let energy = 0;
  for (let y = 0; y < result.height - 1; y++) for (let x = 0; x < result.width - 1; x++) {
    const i = (y * result.width + x) * 4;
    energy += (result.data[i] - result.data[i + 4]) ** 2 + (result.data[i] - result.data[i + result.width * 4]) ** 2;
  }
  return energy / ((result.width - 1) * (result.height - 1) * 2);
}

test('Sharpen increases edge energy without changing the crop', async ({ page }) => {
  await create(page, 1); await upload(page, 0, fixture('detail', 1200, 900));
  const crop = await page.evaluate(() => window.testCroppies[0].get());
  await page.locator('#sharpen').uncheck(); await render(page); const off = await pixels(page);
  await page.locator('#sharpen').check(); await render(page); const on = await pixels(page);
  console.log(`Sharpen edge energy: off=${edgeEnergy(off).toFixed(3)} on=${edgeEnergy(on).toFixed(3)}`);
  expect(meanDiff(off.data, on.data)).toBeGreaterThan(0.1);
  expect(edgeEnergy(on)).toBeGreaterThan(edgeEnergy(off) * 1.05);
  expect(await page.evaluate(() => window.testCroppies[0].get())).toEqual(crop);
});

test('pica upsamples small images without fallback', async ({ page }) => {
  await create(page, 1); await upload(page, 0, fixture('detail', 64, 64));
  await render(page);
  expect(await page.locator('#result').evaluate(img => [img.naturalWidth, img.naturalHeight])).toEqual([150, 150]);
  await expect(page.locator('#render-status')).not.toContainText('fallback');
});

test.describe('pica CDN failure', () => {
  test.use({ blockPica: true });
  test('browser fallback renders and shows a notice', async ({ page }) => {
    expect(await page.evaluate(() => typeof pica)).toBe('undefined');
    await create(page, 2); await upload(page, 0); await render(page);
    await slots(page, [colors[0], [255, 255, 255]]);
    await expect(page.locator('#render-status')).toContainText('used browser fallback');
    await expect(page.locator('#final-render')).toHaveText('Render');
    await expect(page.locator('#final-render')).toBeEnabled();
  });
});

test('pica resize errors fall back and allow recovery', async ({ page }) => {
  await create(page, 1); await upload(page, 0);
  await page.evaluate(() => { window.originalPica = pica; window.pica = () => ({ resize() { throw new Error('Resize failed'); } }); });
  await render(page); await slots(page, [colors[0]]);
  await expect(page.locator('#render-status')).toContainText('used browser fallback');
  await page.evaluate(() => { window.pica = window.originalPica; });
  await render(page); await slots(page, [colors[0]]);
  await expect(page.locator('#render-status')).not.toContainText('fallback');
});

async function pauseResize(page) {
  await page.evaluate(() => {
    const original = pica; let paused = false;
    window.pica = function (options) {
      const instance = original(options), resize = instance.resize.bind(instance);
      instance.resize = async (...args) => {
        if (!paused) { paused = true; await new Promise(resolve => { window.releaseResize = resolve; }); }
        return resize(...args);
      };
      return instance;
    };
  });
}

test('Rendering state yields to the UI and restores the button', async ({ page }) => {
  await create(page, 1); await upload(page, 0); await pauseResize(page);
  await page.locator('#final-render').click();
  await expect.poll(() => page.evaluate(() => typeof window.releaseResize)).toBe('function');
  await expect(page.locator('#final-render')).toHaveText('Rendering…');
  await expect(page.locator('#final-render')).toBeDisabled();
  await expect(page.locator('#final-render')).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => window.releaseResize());
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#final-render')).toBeEnabled();
  await expect(page.locator('#final-render')).toHaveText('Render');
  await expect(page.locator('#final-render')).not.toHaveAttribute('aria-busy', 'true');
});

test('Updating boxes during pica resize discards stale output', async ({ page }) => {
  await create(page, 1); await upload(page, 0); await pauseResize(page);
  await page.locator('#final-render').click();
  await expect.poll(() => page.evaluate(() => typeof window.releaseResize)).toBe('function');
  await create(page, 1, 200, 100);
  await page.evaluate(() => window.releaseResize());
  await expect(page.locator('#final-render')).toBeEnabled();
  await expect(page.locator('#result')).toBeHidden();
  await render(page); await slots(page, [colors[0]], 200, 100);
});

test('Preview columns controls only the on-screen grid', async ({ page }) => {
  await page.locator('#columns').fill('3');
  await create(page, 6, 100, 80);
  const positions = await page.locator('.grid-wrapper > .container').evaluateAll(elements => elements.map(el => {
    const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y };
  }));
  expect(new Set(positions.map(p => p.x)).size).toBe(3);
  expect(positions.slice(0, 3).every(p => p.y === positions[0].y)).toBe(true);
  expect(positions[3].y).toBeGreaterThan(positions[0].y);
  await render(page); await slots(page, Array(6).fill([255, 255, 255]), 100, 80);
});

for (const [field, value] of [['width', '2001'], ['height', '2001'], ['count', '101'], ['width', '1.5'], ['quality', ''], ['quality', '0'], ['quality', '1.1']]) {
  test(`Validation rejects ${field}=${JSON.stringify(value)}`, async ({ page }) => {
    await page.locator(`#${field}`).fill(value);
    await page.locator('#create-boxes').click();
    await expect(page.locator('.grid-wrapper > *')).toHaveCount(0);
    await expect(page.locator('#message')).not.toBeEmpty();
    await expect(page.locator('#result')).toBeHidden();
  });
}

test('Invalid quality prevents rendering', async ({ page }) => {
  await create(page, 1); await upload(page, 0);
  await page.locator('#quality').fill('0');
  await page.locator('#final-render').click();
  await expect(page.locator('#message')).toContainText('quality');
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#download-link')).toBeHidden();
});

test('Invalid image upload reports an inline error and leaves a white slot', async ({ page }) => {
  await create(page, 1);
  await page.locator('#upload-0').setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await expect(page.locator('#message')).toContainText('Could not load');
  await render(page); await slots(page, [[255, 255, 255]]);
});

test('Rendering again and Reset revoke previous blob URLs', async ({ page }) => {
  await page.evaluate(() => {
    window.revokedURLs = [];
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = function (url) { window.revokedURLs.push(url); return revoke.call(this, url); };
  });
  await create(page, 1); await upload(page, 0);
  const first = await render(page), second = await render(page);
  expect(await page.evaluate(() => window.revokedURLs)).toContain(first);
  await page.locator('#reset-all').click();
  expect(await page.evaluate(() => window.revokedURLs)).toContain(second);
});

async function dropFiles(page, selector, files) {
  const transfer = await page.evaluateHandle(files => {
    const data = new DataTransfer();
    for (const file of files) data.items.add(new File([Uint8Array.from(atob(file.base64), ch => ch.charCodeAt(0))], file.name, { type: file.mimeType }));
    return data;
  }, files.map(file => ({ name: file.name, mimeType: file.mimeType, base64: file.buffer.toString('base64') })));
  await page.locator(selector).dispatchEvent('drop', { dataTransfer: transfer });
  await transfer.dispose();
}

test('Drop an image onto a specific box', async ({ page }) => {
  await create(page, 2);
  await dropFiles(page, '.container:nth-child(2)', [fixture(2)]);
  await expect(page.locator('.container.is-loaded')).toHaveCount(1);
  await render(page); await slots(page, [[255, 255, 255], colors[2]]);
});

test('Multi-file picker fills empty slots in order without replacing uploads', async ({ page }) => {
  await create(page, 4); await upload(page, 1, fixture(3));
  await page.locator('#bulk-upload').setInputFiles([fixture(0), fixture(1), fixture(2)]);
  await expect(page.locator('#message')).toContainText('Added 3 images');
  await render(page); await slots(page, [colors[0], colors[3], colors[1], colors[2]]);
});

test('Page drop raises Count to fit and preserves file order', async ({ page }) => {
  await create(page, 1); await upload(page, 0, fixture(0));
  await dropFiles(page, 'body', [fixture(1), fixture(2), fixture(3)]);
  await expect(page.locator('#message')).toContainText('Count increased to 4');
  await expect(page.locator('#count')).toHaveValue('4');
  await expect(page.locator('.container')).toHaveCount(4);
  await render(page); await slots(page, colors);
});

test('Render waits for the entire page-drop queue', async ({ page }) => {
  await create(page, 1); await upload(page, 0);
  await page.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    HTMLImageElement.prototype.decode = async function () { await gate; return decode.call(this); };
    window.releaseUploads = release;
  });
  await dropFiles(page, 'body', [fixture(1), fixture(2), fixture(3)]);
  await page.locator('#final-render').click();
  await expect(page.locator('#result')).toBeHidden();
  await page.evaluate(() => window.releaseUploads());
  await expect(page.locator('#result')).toBeVisible();
  await page.locator('#result').evaluate(img => img.decode());
  await slots(page, colors);
});

test('JPEG export does not depend on HTML canvas idle encoding', async ({ page }) => {
  await create(page, 1); await upload(page, 0);
  await page.evaluate(() => {
    window.idleEncoderCalled = false;
    HTMLCanvasElement.prototype.toBlob = function () { window.idleEncoderCalled = true; };
  });
  await render(page); await slots(page, [colors[0]]);
  expect(await page.evaluate(() => window.idleEncoderCalled)).toBe(false);
});

test('JPEG export failures show an error and allow retry', async ({ page }) => {
  await create(page, 1); await upload(page, 0);
  await page.evaluate(() => {
    window.OriginalWorker = Worker;
    window.Worker = function (url, options) {
      const worker = new window.OriginalWorker(url, options), postMessage = worker.postMessage;
      worker.postMessage = function (message, ...args) {
        if (message.image instanceof ImageBitmap && message.quality !== undefined) {
          queueMicrotask(() => worker.dispatchEvent(new MessageEvent('message', { data: { error: 'Export failed' } })));
        } else postMessage.call(worker, message, ...args);
      };
      return worker;
    };
  });
  await page.locator('#final-render').click();
  await expect(page.locator('#message')).toContainText('Could not export that image');
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#download-link')).toBeHidden();
  await page.evaluate(() => { window.Worker = window.OriginalWorker; });
  await render(page); await slots(page, [colors[0]]);
});

test('JPEG export falls back when OffscreenCanvas is unavailable', async ({ page }) => {
  await create(page, 1); await upload(page, 0);
  await page.evaluate(() => { window.OffscreenCanvas = undefined; });
  await render(page); await slots(page, [colors[0]]);
});

test('Clear empties one slot while retaining its neighbors', async ({ page }) => {
  await create(page, 3); for (let i = 0; i < 3; i++) await upload(page, i);
  await page.getByRole('button', { name: 'Clear box 2', exact: true }).click();
  await expect(page.locator('.container.is-loaded')).toHaveCount(2);
  await render(page); await slots(page, [colors[0], [255, 255, 255], colors[2]]);
});

test('Bulk picker creates boxes fresh and rejects non-images', async ({ page }) => {
  await page.locator('#bulk-upload').setInputFiles({ name: 'text.txt', mimeType: 'text/plain', buffer: Buffer.from('text') });
  await expect(page.locator('#message')).toContainText('Please choose image files');
  await expect(page.locator('.container')).toHaveCount(0);
  await page.locator('#bulk-upload').setInputFiles([fixture(0), fixture(1)]);
  await expect(page.locator('#message')).toContainText('Added 2 images');
  await render(page); await slots(page, [colors[0], colors[1], [255, 255, 255], [255, 255, 255]]);
});

test('Bulk fill respects the 100-box limit', async ({ page }) => {
  await create(page, 99, 10, 10);
  await page.locator('#bulk-upload').setInputFiles(Array.from({ length: 101 }, () => fixture(0, 10, 10)));
  await expect(page.locator('#message')).toContainText('maximum 100 boxes', { timeout: 30000 });
  await expect(page.locator('#count')).toHaveValue('100');
  await expect(page.locator('.container')).toHaveCount(100);
});

test.describe('Mobile with a non-overlay vertical scrollbar', () => {
test.use({ context: async ({ playwright, baseURL }, use) => {
  const browser = await playwright.chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  try { await use(await browser.newContext({ baseURL })); }
  finally { await browser.close(); }
} });
for (const columns of [2, 3]) test(`Mobile preview with ${columns} columns has no page overflow`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#columns').fill(String(columns));
  await create(page);
  const checkLayout = async () => {
    const layout = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      root: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      x: scrollX,
      overflowing: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth).map(el => ({ tag: el.tagName, id: el.id, class: el.className, right: el.getBoundingClientRect().right })),
    }));
    expect(layout.root, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
    expect(layout.body).toBeLessThanOrEqual(layout.width);
    expect(layout.x).toBe(0);
    expect(layout.overflowing).toEqual([]);
    expect(await page.locator('.grid-scroll').evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(await page.locator('.grid-scroll').evaluate(el => el.clientWidth));
    const positions = await page.locator('.container').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().x));
    expect(new Set(positions).size).toBe(layout.width < 390 ? 1 : 2);
  };
  await checkLayout();
  const jpeg = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 4000; canvas.height = 3000;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 4000, 3000);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  await upload(page, 0, { name: 'large-4000x3000.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') });
  for (let i = 1; i < 4; i++) await upload(page, i);
  await render(page);
  await page.evaluate(() => window.scrollTo(94, 650));
  expect(await page.evaluate(() => scrollY)).toBe(650);
  await checkLayout();
  await slots(page, colors);
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.grid-wrapper').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(await page.evaluate(() => document.documentElement.clientWidth < 390 ? 1 : 2));
  await checkLayout();
});

test('Off-screen upload inputs remain contained by the grid scroller', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await create(page, 4, 200, 150);
  await page.addStyleTag({ content: '.grid-scroll .grid-wrapper { grid-template-columns: repeat(3, minmax(218px, 1fr)) !important; }' });
  for (let i = 0; i < 4; i++) await upload(page, i);
  await render(page);
  expect(await page.locator('.grid-scroll').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.locator('#upload-2').evaluate(el => el.offsetParent.className)).toContain('container');
  await page.evaluate(() => window.scrollTo(94, 650));
  expect(await page.evaluate(() => scrollX)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => document.documentElement.clientWidth));
  await slots(page, colors, 200, 150);
});
});
