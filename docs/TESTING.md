# Browser characterization tests

The suite guards the single-file application's behavior. Selectors
use existing ids and Croppie's structural elements, not presentation classes
(except the grid's existing structural wrapper). Chromium is the only target.

## Running

Install a Node LTS release and Python 3, then:

```sh
npm ci
npx playwright install chromium
npm test
```

Playwright serves the repository on `127.0.0.1:8000`; that port must be free.
Internet access is required for the existing Croppie 2.6.5 CDN JS and CSS.
The lockfile pins the test dependencies. Tests run serially to avoid contaminating
performance measurements. Runtime PNG fixtures are generated with pngjs: four
solid colors, 400x300 quadrants, a 64x64 image, and 4000x3000 quadrants.

To intentionally replace the crop baseline after reviewing a rendering change:

```sh
UPDATE_GOLDENS=1 npx playwright test -g F10
```

Review and commit `tests/golden/quadrant-crop.png`. This is decoded JPEG output
saved losslessly as PNG, not a source fixture or a screenshot. The independent
reference uses browser `drawImage` with high-quality smoothing and the actual
Croppie crop coordinates. RGB mean absolute difference must be below 6 against
that reference, and below 2 against the golden (0–255 channel scale). Slot-center
color checks tolerate 8 per channel for JPEG artifacts.

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
`test.fail()` markers. The existing crop golden is unchanged.

| Test | Fixed behavior |
| --- | --- |
| B1 | Create with changed dimensions must resize existing viewports and output correctly. |
| B2 | Render before Create or after Reset must leave output hidden, not create `data:,`. |
| B3 | Blank, letters, zero, and negative width/height/count are rejected with inline errors. Width/height accept whole numbers 1–2000, count 1–100, and quality 0.1–1. Number inputs reject letters as an empty value. Additional cases cover upper bounds and fractional dimensions. |
| B4 | Rendering six 4000×3000 sources should take under 500ms. Logs elapsed time from Render click through async JPEG blob completion, excluding upload and source decoding. Each upload is decoded and stored as an ImageBitmap before rendering. This is machine-dependent. Crops larger than 4× the output in both dimensions are drawn directly into a 4× intermediate with high-quality smoothing, then Hermite-resampled to output size. Smaller crops retain the source-resolution patch with a small margin; upscaling uses high-quality `drawImage`. Hermite caches only the most recent geometry's coefficients, not image pixels. |
| B5 | `#outcanvas` contains no script elements. |

## Preview columns

The field is labeled **Preview columns**. It lays out the on-screen grid with
exactly that many columns; output remains a single vertical strip. A dedicated
test checks actual box positions for three columns and verifies strip dimensions.
Additional tests cover blob URL revocation, invalid image uploads, and quality
validation before rendering.

## Upload workflow and interface

The single-file UI follows the system light/dark preference. Settings and the
preview grid adapt to narrow screens; oversized viewports remain accessible by
horizontal scrolling rather than changing the output or crop dimensions.
The action bar reports the rendered slot count, dimensions, and JPEG size.

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
golden remain unchanged.
