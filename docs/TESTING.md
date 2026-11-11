# Browser characterization tests

The suite guards the single-file application's behavior. Selectors
use existing ids and Croppie's structural elements, not presentation classes
(except the grid's existing structural wrapper). Chromium runs the full suite;
Firefox and WebKit run only the `@antialias` regression.

## Resize quality

The app uses pinned **pica 9.0.1**, Lanczos3, with amount 80 / radius 0.6 /
threshold 2 unsharp enabled by default. Sharpen off disables only unsharp.
The source-resolution crop and source origin are unchanged; full crops are
passed to pica's JS/WASM worker pipeline, with native CIB resizing disabled.
The bundled Hermite implementation and 4× pre-shrink are removed.

In the five-crop linear-light ImageMagick study, mean SSIM was **0.9398 for E**
(pica + unsharp), **0.9080 for Chromium B**, and **0.8973 for Chromium F**.
Firefox/WebKit B scored only **0.6832 / 0.6673** and visibly aliased fine texture.
Against the mildly sharpened reference, E scored **0.9575**, versus Chromium F's
**0.8962**. These justify the cross-engine resampler rather than relying on the
native smoothing-quality flag. They measure the chosen reference, not exact
Photoshop equivalence.

The Render button shows `Rendering…`, is disabled and exposes `aria-busy` while
pending uploads, asynchronous resizing and export complete. The UI can paint
before processing; heavy resampling runs in pica's worker pool. Revisions still
discard stale results when boxes change during a resize. On missing pica or a
resize exception, the app draws that crop directly with high native smoothing
and appends a small status notice. This is a compatibility fallback, **not** a
promise of equal quality in Firefox/WebKit. A later successful render clears
the notice. JPEG export keeps its existing worker/fallback behavior.

The `@antialias` test runs in all three browser projects: 3071×3067 one-pixel
vertical stripes shrink to 150×150. Assertions require mean within 2 of 127.5,
std-dev below 1.5, full range at most 6, and row-mean range below 2; this guards
against biased averaging and spatial moiré, not just a plausible center pixel.
The generated detail fixture separately checks that Sharpen increases edge
energy by over 5%, changes output pixels, and does not move the crop.
Fallback tests cover a blocked CDN and thrown resize errors/recovery. Only the
blocked pica URL's expected `net::ERR_FAILED` console message is allowed in the
CDN-failure test; unrelated errors still fail. JPEG-error injection targets only
the JPEG worker protocol, leaving the newly introduced pica workers functional.

Before regenerating the intentional pica goldens, new-vs-historical-golden RGB
MAE was **0.6887111111 (off)** / **0.7237777778 (on)**. Off's independent-reference
MAE was **0.9747851852**. The unchanged `e6e8499` app was also rendered from a
saved copy using the exact same generated 3071×3067 stripe fixture: old std-dev
was **0.0000** (mean 127). It passes this synthetic case; the test does not prove
the old pipeline fails on every high-frequency input. The new pica results were
**0.3107** std-dev in Chromium/Firefox and **0.5122** in Linux WebKit, all within
the stated limits. The natural-photo SSIM study above provides the separate
evidence for the resizer's quality improvement.

## Running the suite

Install a Node LTS release and Python 3, then:

```sh
npm ci
npx playwright install chromium firefox webkit
npm test
```

Playwright serves the repository on `127.0.0.1:8000`; that port must be free.
Internet access is required for Croppie 2.6.5 JS/CSS and pica 9.0.1 JS, all
CDN-loaded with SRI. On Linux, install browser host libraries with
`npx playwright install-deps chromium firefox webkit` if needed.
The lockfile pins the test dependencies. Tests run serially to avoid contaminating
performance measurements. Runtime PNG fixtures are generated with pngjs: four
solid colors, 400x300 quadrants, a 64x64 image, 4000x3000 quadrants,
3071x3067 one-pixel black/white vertical stripes, and smooth detailed patterns.

To intentionally replace the crop baseline after reviewing a rendering change:

```sh
REPORT_OLD_GOLDEN=1 npx playwright test --project=chromium -g F10
UPDATE_GOLDENS=1 npx playwright test --project=chromium -g F10
```

Review and commit `tests/golden/quadrant-crop-sharpen-off.png` and
`tests/golden/quadrant-crop-sharpen-on.png`. The original `quadrant-crop.png`
is retained only as a historical Hermite baseline for the reporting command.
Regeneration is authorized here because the resizer deliberately changed to
pica; do not regenerate goldens just to resolve a future regression.
These are decoded JPEG output
saved losslessly as PNG, not a source fixture or a screenshot. The independent
reference uses browser `drawImage` with high-quality smoothing and the actual
Croppie crop coordinates, including the unchanged pixel-origin quantization.
With Sharpen off, RGB mean absolute difference must be below **3** against
that independent native reference, tightened from the former 6. This allows
JPEG quantization and differences between Lanczos3 and the browser kernel near
the quadrant boundaries, while retaining a meaningful crop-registration check.
The reference never calls pica. Sharpen on is protected by its own golden and
the separate edge-energy test, not by comparison to an unsharpened reference.
Both golden differences must be below 2 (0–255 channel scale). Slot-center
color checks tolerate 8 per channel for JPEG artifacts.

F11 starts the quadrant crop off-center so zoom actually moves a color boundary.
The former centered quadrants are almost scale-invariant: switching the kernel
reduced their change to 0.9766 despite the source patch correctly shrinking from
296×296 to 107×107. The new setup retains the unchanged output-MAE `> 1` assertion
and avoids testing incidental kernel differences instead of zoom behavior.

The harness observes Croppie construction through a test-only Proxy injected
before the CDN script executes; this exposes the real API without modifying the
application. All unhandled page errors and console errors fail tests.
Favicon requests are fulfilled with 204. B3 catches submit
handler exceptions explicitly and asserts that none occurred, so invalid-input
exceptions are tested rather than allowed to escape as page errors.

## Feature map

| Test | User-visible behavior to preserve |
| --- | --- |
| F1 | Defaults: 150×150, 4 boxes, 2 columns, quality 1.0; output/download initially hidden. |
| F2 | Create builds N upload boxes with W×H Croppie viewports and indexed file inputs. |
| F3 | Upload binds a source image, including one smaller than the viewport. |
| F4 | Render produces visible W×(H·N) JPEG output and a matching blob download named `picture-box-<W>x<H>.jpg`. |
| F5 | Upload box i becomes vertical output slot i. |
| F6 | Empty upload boxes become white slots. |
| F7 | Increasing count preserves uploads; decreasing removes trailing boxes only. |
| F8 | Reset clears boxes and hides output/download; a fresh create/upload/render works. |
| F9 | Lower JPEG quality yields a smaller JPEG blob for the same input. |
| F10 | Non-default crop position/zoom preserves crop accuracy and current resampling quality. |
| F11 | Changing zoom after rendering updates the next output's pixels (not just its blob URL). |
| F12 | Non-square 200×100 boxes produce correct dimensions and ordered slot colors. |

## Bug regression coverage

The original known bugs are now ordinary passing regression tests, with no
`test.fail()` markers. The pica change intentionally introduces separate on/off
crop goldens; the original is preserved as a historical baseline.

| Test | Fixed behavior |
| --- | --- |
| B1 | Create with changed dimensions must resize existing viewports and output correctly. |
| B2 | Render before Create or after Reset must leave output hidden, not create `data:,`. |
| B3 | Blank, letters, zero, and negative width/height/count are rejected with inline errors. Width/height accept whole numbers 1–2000, count 1–100, and quality 0.1–1. Number inputs reject letters as an empty value. Additional cases cover upper bounds and fractional dimensions. |
| B4 | Rendering six 4000×3000 sources should take under **3000ms**. Logs elapsed time from Render click through async JPEG blob completion, excluding upload and source decoding. Each upload is decoded beforehand. This machine-dependent budget accommodates source-resolution pica Lanczos3 with mild unsharp and worker initialization. There is no 4× pre-shrink or Hermite path. |
| B5 | `#outcanvas` contains no script elements. |

## Preview columns

The field is labeled **Preview columns**. It lays out the on-screen grid with
that many columns on desktop; mobile uses fewer columns when needed to fit.
Output remains a single vertical strip. A dedicated
test checks actual box positions for three columns and verifies strip dimensions.
Additional tests cover blob URL revocation, invalid image uploads, and quality
validation before rendering.

## Upload workflow and interface

The single-file UI follows the system light/dark preference. Settings and the
preview grid adapt to narrow screens; oversized viewports remain accessible by
horizontal scrolling rather than changing the output or crop dimensions.
The action bar reports the rendered slot count, dimensions, and JPEG size.
Mobile regression tests at 390×844 cover both two and three requested preview
columns with non-overlay vertical scrollbars, before upload, after rendering a
generated 4000×3000 JPEG, after scrolling to `(94, 650)`, and after resizing. They
require no page-level or grid-level horizontal overflow with 150px boxes. A
separate deliberately overflowing grid checks that absolutely positioned upload
inputs remain contained by their cards rather than extending the document.

Render waits for the bulk-upload queue as well as individual image loads. JPEG
export transfers a 1:1 snapshot of the finished canvas to an inline worker, which
uses `OffscreenCanvas.convertToBlob`, avoiding main-thread idle-encoder
scheduling. The worker is terminated and its script URL revoked after export.
Browsers without workers or `OffscreenCanvas` retain the `toBlob` fallback.
Tests cover stalled HTML canvas
encoding, rejected exports and recovery, the fallback, and Render clicked while
page-drop decoding is deliberately paused. Crop math and golden tolerances are
unchanged.

Additional browser tests cover:

| Behavior | Guardrail |
| --- | --- |
| Drop one image onto a box | A real DataTransfer drop loads only the selected slot. |
| Add images… | Multiple files fill empty slots in order, preserving existing uploads. |
| Drop multiple files on the page | Count grows to fit, with a notice and the original file order preserved. |
| Clear | The selected slot becomes white while neighboring uploads remain intact. |
| Bulk input errors | Non-images are rejected; the picker also works before Create. |
| Count cap | Bulk imports stop at 100 boxes and explain overflow. |

The Create button now has `#create-boxes` because the settings form also contains
Reset and Add images buttons. All original rendering assertions and the crop
historical golden remain unchanged by the overflow fixes.
