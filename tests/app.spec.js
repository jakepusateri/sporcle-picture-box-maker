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
  await page.locator('#dimensions-form button').click();
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
  await page.locator('#final-render').click();
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
  expect(src).toMatch(/^data:image\/jpeg;base64,/);
  expect(await page.locator('#result').evaluate(img => [img.naturalWidth, img.naturalHeight])).toEqual([150, 600]);
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#download-link')).toBeVisible();
  await expect(page.locator('#download-link')).toHaveAttribute('href', src);
  await expect(page.locator('#download-link')).toHaveAttribute('download', /.+/);
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
  await page.locator('#quality').fill('0.3'); const low = await render(page);
  expect(low.length).toBeLessThan(high.length);
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
  expect(meanDiff(actual.data, reference)).toBeLessThan(6);
  const goldenPath = path.join(__dirname, 'golden', 'quadrant-crop.png');
  if (process.env.UPDATE_GOLDENS === '1') fs.writeFileSync(goldenPath, PNG.sync.write({ width: actual.width, height: actual.height, data: Buffer.from(actual.data) }));
  const golden = PNG.sync.read(fs.readFileSync(goldenPath));
  expect([actual.width, actual.height]).toEqual([golden.width, golden.height]);
  expect(meanDiff(actual.data, golden.data)).toBeLessThan(2);
});
test('F11 zoom changes subsequent render', async ({ page }) => {
  await create(page, 1); await upload(page, 0, fixture()); const before = await render(page);
  await page.evaluate(() => window.testCroppies[0].setZoom(1.4));
  expect(await render(page)).not.toBe(before);
});
test('F12 non-square output', async ({ page }) => {
  await create(page, 3, 200, 100); for (let i = 0; i < 3; i++) await upload(page, i);
  await render(page); await slots(page, colors.slice(0, 3), 200, 100);
});

test('B1 existing viewports should resize', async ({ page }) => {
  test.fail(); await create(page, 1); await upload(page, 0); await create(page, 1, 200, 100);
  expect(await page.locator('.cr-viewport').evaluate(el => [parseFloat(el.style.width), parseFloat(el.style.height)])).toEqual([200, 100]);
  await render(page); await slots(page, [colors[0]], 200, 100);
});
for (const reset of [false, true]) test(`B2 Render ${reset ? 'after Reset' : 'before Create'} stays hidden`, async ({ page }) => {
  test.fail(); if (reset) { await create(page); await page.locator('#reset-all').click(); }
  await page.locator('#final-render').click(); await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#result')).not.toHaveAttribute('src', 'data:,');
});
for (const field of ['width', 'height', 'count']) for (const value of ['', 'letters', '0', '-1']) {
  test(`B3 rejects ${field}=${JSON.stringify(value)}`, async ({ page }) => {
    test.fail();
    await page.evaluate(() => {
      const form = document.querySelector('#dimensions-form'), submit = form.onsubmit;
      form.onsubmit = function (event) {
        try { return submit.call(this, event); }
        catch (error) { window.validationException = error.message; }
      };
    });
    await page.locator(`#${field}`).fill(value); await page.locator('#dimensions-form button').click();
    expect(await page.evaluate(() => window.validationException), 'Validation must not throw').toBeUndefined();
    await expect(page.locator('.grid-wrapper > *')).toHaveCount(0);
    await page.locator('#final-render').click();
    await expect(page.locator('#result')).toBeHidden();
    await expect(page.locator('#result')).not.toHaveAttribute('src', 'data:,');
  });
}
test('B4 six large images render under 500 milliseconds', async ({ page }) => {
  test.fail(); await create(page, 6); const large = fixture('quadrants', 4000, 3000);
  for (let i = 0; i < 6; i++) await upload(page, i, large);
  const milliseconds = await page.evaluate(() => {
    const start = performance.now(); document.querySelector('#final-render').click(); return performance.now() - start;
  });
  console.log(`B4 render time: ${milliseconds.toFixed(1)} ms`);
  await page.locator('#result').evaluate(img => img.decode());
  expect(milliseconds).toBeLessThan(500);
});
test('B5 canvas must not contain scripts', async ({ page }) => {
  test.fail(); await expect(page.locator('#outcanvas script')).toHaveCount(0);
});
