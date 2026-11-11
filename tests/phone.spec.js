const { test: base, expect } = require('@playwright/test');
const { PNG } = require('pngjs');
const { phoneJPEG, rotatedJPEG, memoryProbe } = require('./phone-fixtures');

const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
    await page.addInitScript(memoryProbe);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await use(page);
    expect(errors).toEqual([]);
  },
});
test.setTimeout(120000);

function file(buffer, name = 'phone.jpg') { return { name, mimeType: 'image/jpeg', buffer }; }
function small(color, width = 400, height = 300) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([...color, 255], i);
  return { name: 'small.png', mimeType: 'image/png', buffer: PNG.sync.write(png) };
}
async function create(page, count = 4, width = 150, height = 150) {
  for (const [id, value] of Object.entries({ count, width, height })) await page.locator(`#${id}`).fill(String(value));
  await page.locator('#create-boxes').click();
}
async function render(page) {
  await page.locator('#final-render').click();
  await expect(page.locator('#result')).toBeVisible();
  await page.locator('#result').evaluate(img => img.decode());
  await expect(page.locator('#final-render')).toBeEnabled();
}
function colorsAt(png, positions, colors) {
  positions.forEach(([x, y], i) => colors[i].forEach((value, channel) => {
    expect(Math.abs(png.data[(y * png.width + x) * 4 + channel] - value)).toBeLessThanOrEqual(8);
  }));
}
async function outputPixels(page) {
  return page.locator('#result').evaluate(img => {
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const pixels = { width: canvas.width, height: canvas.height, data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data) };
    canvas.width = canvas.height = 0;
    return pixels;
  });
}

test('@phone four 48MP JPEGs bind and render within canvas and bitmap budgets', async ({ page, playwright, browserName }, info) => {
  const buffer = await phoneJPEG(playwright);
  let peakJSHeap = 0, timer, cdp;
  if (browserName === 'chromium') {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    timer = setInterval(() => cdp.send('Performance.getMetrics').then(result => {
      peakJSHeap = Math.max(peakJSHeap, result.metrics.find(metric => metric.name === 'JSHeapUsedSize').value);
    }).catch(() => {}), 50);
  }
  try {
    await page.locator('#bulk-upload').setInputFiles(Array.from({ length: 4 }, (_, i) => file(buffer, `phone-${i}.jpg`)));
    await expect(page.locator('.container.is-loaded')).toHaveCount(4, { timeout: 90000 });
    const dimensions = await page.locator('.cr-image').evaluateAll(images => images.map(image => [image.naturalWidth, image.naturalHeight]));
    expect(dimensions).toEqual(Array(4).fill([2048, 1536]));
    expect(await page.locator('.cr-image').evaluateAll(images => images.every(image => image.src.startsWith('blob:')))).toBe(true);
    await render(page);
    expect(await page.locator('#result').evaluate(img => [img.naturalWidth, img.naturalHeight])).toEqual([150, 600]);
    const memory = await page.evaluate(() => phoneMemory());
    console.log(`Phone memory ${browserName}: ${JSON.stringify({ peakJSHeap: cdp ? peakJSHeap : 'unavailable', ...memory })}`);
    await info.attach('phone-memory.json', { body: JSON.stringify({ peakJSHeap, ...memory, dimensions }), contentType: 'application/json' });
    expect(memory.maxCanvasArea).toBeLessThanOrEqual(4194304);
    expect(memory.peakBitmapBytes).toBeLessThan(16 * 1024 * 1024);
    expect(memory.currentBitmapBytes).toBeLessThan(1024);
    expect(memory.currentCanvasBytes).toBeLessThan(65536);
    expect(await page.locator('#outcanvas').evaluate(c => [c.width, c.height])).toEqual([0, 0]);
    await expect(page.locator('#render-status')).not.toContainText('fallback');
  } finally { clearInterval(timer); if (cdp) await cdp.detach(); }
});

for (const [width, height, workingWidth, workingHeight] of [[8064, 6048, 1536, 2048], [400, 300, 300, 400]]) test(`@phone EXIF-6 ${width}x${height} JPEG is upright in preview and output`, async ({ page, playwright }, info) => {
  const buffer = rotatedJPEG(await phoneJPEG(playwright, width, height));
  await create(page, 1);
  await page.locator('#upload-0').setInputFiles(file(buffer, 'rotated.jpg'));
  await expect(page.locator('.container.is-loaded')).toHaveCount(1, { timeout: 90000 });
  expect(await page.locator('.cr-image').evaluate(img => [img.naturalWidth, img.naturalHeight])).toEqual([workingWidth, workingHeight]);
  const expected = [[0, 0, 255], [255, 0, 0], [255, 255, 0], [0, 255, 0]];
  const preview = await page.locator('.cr-viewport').screenshot({ path: info.outputPath('upright-preview.png') });
  colorsAt(PNG.sync.read(preview), [[38, 38], [114, 38], [38, 114], [114, 114]], expected);
  await render(page);
  colorsAt(await outputPixels(page), [[37, 37], [112, 37], [37, 112], [112, 112]], expected);
  expect(await page.locator('.cr-slider').getAttribute('max')).toBe('1.0000');
});

test('@phone undecodable image gets a slot error and the batch continues', async ({ page }) => {
  await page.locator('#bulk-upload').setInputFiles([
    { name: 'unsupported.heic', mimeType: 'image/heic', buffer: Buffer.from('not a supported image') },
    small([0, 255, 0]), small([255, 0, 0]),
  ]);
  await expect(page.locator('#message')).toContainText('Added 2 images');
  await expect(page.locator('.container').nth(0).locator('.box-message')).toContainText('Could not load unsupported.heic');
  await expect(page.locator('.container.is-loaded')).toHaveCount(2);
  await render(page);
  colorsAt(await outputPixels(page), [[75, 75], [75, 225], [75, 375], [75, 525]], [[255, 255, 255], [0, 255, 0], [255, 0, 0], [255, 255, 255]]);
});

test('@phone Clear Replace viewport rebuild and Reset release owned URLs', async ({ page }) => {
  await create(page, 2);
  await page.locator('#bulk-upload').setInputFiles([small([255, 0, 0]), small([0, 255, 0])]);
  await expect(page.locator('.container.is-loaded')).toHaveCount(2);
  expect((await page.evaluate(() => phoneMemory())).activeImageURLs).toBe(2);
  await page.getByRole('button', { name: 'Clear box 1', exact: true }).click();
  expect((await page.evaluate(() => phoneMemory())).activeImageURLs).toBe(1);
  const old = await page.locator('.cr-image').last().getAttribute('src');
  await page.locator('#upload-1').setInputFiles(small([0, 0, 255]));
  await expect(page.locator('.container.is-loaded')).toHaveCount(1);
  await expect(page.locator('.cr-image').last()).not.toHaveAttribute('src', old);
  expect((await page.evaluate(() => phoneMemory())).activeImageURLs).toBe(1);
  await create(page, 2, 200, 100);
  await expect(page.locator('.container.is-loaded')).toHaveCount(1);
  await render(page);
  colorsAt(await outputPixels(page), [[100, 50], [100, 150]], [[255, 255, 255], [0, 0, 255]]);
  await page.locator('#reset-all').click();
  const memory = await page.evaluate(() => phoneMemory());
  expect(memory.activeImageURLs).toBe(0);
  expect(memory.currentBitmapBytes).toBeLessThan(1024);
  expect(memory.currentCanvasBytes).toBeLessThan(65536);
});

test('@phone Reset during source preparation discards and releases pending work', async ({ page, playwright }) => {
  const buffer = await phoneJPEG(playwright);
  await page.evaluate(() => {
    const create = window.createImageBitmap;
    let paused = false;
    window.createImageBitmap = async (...args) => {
      if (!paused) { paused = true; await new Promise(resolve => { window.releasePhoneDecode = resolve; }); }
      return create(...args);
    };
  });
  await page.locator('#bulk-upload').setInputFiles([file(buffer), file(buffer, 'second.jpg')]);
  await expect.poll(() => page.evaluate(() => typeof window.releasePhoneDecode)).toBe('function');
  await page.locator('#reset-all').click();
  await page.evaluate(() => window.releasePhoneDecode());
  await page.locator('#final-render').click();
  await expect(page.locator('#message')).toContainText('Create some boxes');
  await expect(page.locator('.container')).toHaveCount(0);
  const memory = await page.evaluate(() => phoneMemory());
  expect(memory.activeURLs).toBe(0);
  expect(memory.currentBitmapBytes).toBeLessThan(1024);
  expect(memory.currentCanvasBytes).toBeLessThan(65536);
});

test('@phone bounds the decoded-image fallback when bitmap resize is unavailable', async ({ page }) => {
  await page.evaluate(() => { window.createImageBitmap = undefined; });
  await create(page, 1);
  await page.locator('#upload-0').setInputFiles(small([0, 255, 0], 3000, 1000));
  await expect(page.locator('.container.is-loaded')).toHaveCount(1);
  expect(await page.locator('.cr-image').evaluate(img => [img.naturalWidth, img.naturalHeight])).toEqual([2048, 683]);
  await render(page);
  colorsAt(await outputPixels(page), [[75, 75]], [[0, 255, 0]]);
  expect((await page.evaluate(() => phoneMemory())).maxCanvasArea).toBeLessThanOrEqual(4194304);
});

test('@phone rejects oversized native decoding when resize options are ignored', async ({ page, playwright }) => {
  const buffer = await phoneJPEG(playwright);
  await page.evaluate(() => {
    const create = window.createImageBitmap;
    window.createImageBitmap = source => create(source);
  });
  await create(page, 1);
  await page.locator('#upload-0').setInputFiles(file(buffer));
  await expect(page.locator('.box-message')).toContainText('cannot safely resize this large image');
  await expect(page.locator('.container.is-loaded')).toHaveCount(0);
  const memory = await page.evaluate(() => phoneMemory());
  expect(memory.peakBitmapBytes).toBeLessThan(1024);
  expect(memory.activeImageURLs).toBe(0);
});

test('@phone prepares formats whose dimensions need native metadata loading', async ({ page }) => {
  await create(page, 1);
  await page.locator('#upload-0').setInputFiles({
    name: 'large.svg', mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000"><rect width="4000" height="3000" fill="red"/></svg>'),
  });
  await expect(page.locator('.container.is-loaded')).toHaveCount(1);
  expect(await page.locator('.cr-image').evaluate(img => [img.naturalWidth, img.naturalHeight])).toEqual([2048, 1536]);
  await render(page);
  colorsAt(await outputPixels(page), [[75, 75]], [[255, 0, 0]]);
  expect((await page.evaluate(() => phoneMemory())).activeImageURLs).toBe(2);
});

for (const [width, height, count] of [[2000, 2000, 5], [1, 2000, 9]]) test(`@phone rejects unsafe output ${width}x${height}x${count} before canvas allocation`, async ({ page }) => {
  await create(page, count, width, height);
  await page.locator('#final-render').click();
  await expect(page.locator('#message')).toContainText('Output is too large');
  await expect(page.locator('#result')).toBeHidden();
  expect((await page.evaluate(() => phoneMemory())).maxCanvasArea).toBeLessThan(16777216);
});
