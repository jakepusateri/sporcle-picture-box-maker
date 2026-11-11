const { test: base, expect } = require('@playwright/test');
const { PNG } = require('pngjs');
const fs = require('node:fs');
const path = require('node:path');

const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
function fixture(kind = 'quadrants', width = 400, height = 300) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = typeof kind === 'number' ? colors[kind] : colors[(x >= width / 2 ? 1 : 0) + (y >= height / 2 ? 2 : 0)];
    const offset = (y * width + x) * 4;
    png.data.set([...color, 255], offset);
  }
  return { name: 'generated.png', mimeType: 'image/png', buffer: PNG.sync.write(png) };
}

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
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
test('F10 non-default crop agrees with independent reference and golden', async ({ page }) => {
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
    ctx.drawImage(c.elements.img, Number(points[0]), Number(points[1]), 150 / zoom, 150 / zoom, 0, 0, 150, 150);
    return Array.from(ctx.getImageData(0, 0, 150, 150).data);
  });
  const referenceDiff = meanDiff(actual.data, reference);
  console.log(`F10 reference mean absolute difference: ${referenceDiff}`);
  expect(referenceDiff).toBeLessThan(6);
  const goldenPath = path.join(__dirname, 'golden', 'quadrant-crop.png');
  if (process.env.UPDATE_GOLDENS === '1') fs.writeFileSync(goldenPath, PNG.sync.write({ width: actual.width, height: actual.height, data: Buffer.from(actual.data) }));
  const golden = PNG.sync.read(fs.readFileSync(goldenPath));
  expect([actual.width, actual.height]).toEqual([golden.width, golden.height]);
  const goldenDiff = meanDiff(actual.data, golden.data);
  console.log(`F10 golden mean absolute difference: ${goldenDiff}`);
  expect(goldenDiff).toBeLessThan(2);
});
test('F11 zoom changes subsequent render', async ({ page }) => {
  await create(page, 1); await upload(page, 0, fixture()); await render(page);
  const before = await pixels(page);
  await page.evaluate(() => window.testCroppies[0].setZoom(1.4));
  await render(page);
  expect(meanDiff((await pixels(page)).data, before.data)).toBeGreaterThan(1);
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
test('B4 six large images render under 500 milliseconds', async ({ page }) => {
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
  expect(milliseconds).toBeLessThan(500);
});
test('B5 canvas must not contain scripts', async ({ page }) => {
  await expect(page.locator('#outcanvas script')).toHaveCount(0);
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
