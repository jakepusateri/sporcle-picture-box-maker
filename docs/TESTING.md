# Browser characterization tests

The suite guards the single-file application's behavior. Selectors
use existing ids and Croppie's structural elements, not presentation classes
(except the grid's existing structural wrapper). Chromium runs the full suite;
Firefox runs the `@antialias` regression. WebKit also runs the `@phone` memory,
orientation, error-handling and resource-lifecycle regressions.

## Resize quality

The app uses pinned **pica 9.0.1**, Lanczos3, with amount 80 / radius 0.6 /
threshold 2 unsharp enabled by default. Sharpen off disables only unsharp.
The crop math and source origin calculation are unchanged, now relative to a
bounded working image. Crops are passed to pica's JS/WASM worker pipeline, with
native CIB resizing disabled for this final resample. Upload preparation uses
native high-quality bitmap resizing separately, before any Croppie binding.
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

The `@antialias` test runs in all three browser projects: a generated 3071×3067
zone plate shrinks to 150×150. Its grayscale formula is
`round(127.5 + 127.5*sin(pi*(dx²+dy²)/4096))`, centered on the source image.
Analysis uses only the annulus 20–60 output pixels from center (10,040 samples),
away from legitimate low-frequency central detail and the crop edges.
The local source frequencies are `(dx/4096, dy/4096)` cycles/source pixel.
Using the actual fit crop/zoom, the test verifies that every annulus pixel's
largest frequency component exceeds twice the output Nyquist (`zoom/2`);
the measured minimum ratio after working-copy preparation is 2.6914. The helper
maps working-copy coordinates back to the original zone plate before calculating
frequency. The source components themselves remain
below the input Nyquist, so this is resampling aliasing, not source aliasing.
The unchanged limits require mean within 2 of 127.5 and **std-dev below 1.5**
in this region. The fixture and metric are shared in `tests/antialias.js`.

The same fixture, crop mapping, JPEG quality 1.0, ROI and metric discriminate:

| Pipeline | Engine | Annulus std-dev | Result at <1.5 |
| --- | --- | ---: | --- |
| Old Hermite + 4× pre-shrink (`e6e8499`) | Chromium | 4.9904 | Fail |
| Native B, smoothing high where supported | Chromium | 3.2505 | Fail |
| Native B | Firefox | 77.4531 | Fail |
| Native B, smoothing high | Linux WebKit | 87.4828 | Fail |
| Current bounded upload + pica | Chromium | 0.0519 | Pass |
| Current bounded upload + pica | Firefox | 0.0000 | Pass |
| Current bounded upload + pica | Linux WebKit | 0.3722 | Pass |

The historical run executes a saved app whose SHA-256 was checked against
`git show e6e8499:index.html`, not a reimplementation of Hermite. Native controls
draw the same original-resolution image/crop directly to the final canvas;
current pica runs through the actual Render button in every engine. Measurements
use final decoded JPEG output, not unencoded intermediates. Even the highest
pica std-dev is over four times below the unchanged limit, while the old pipeline
is over three times above it. The replaced one-pixel-stripe fixture had old
std-dev 0 and did not discriminate; it is no longer the regression test.
The generated detail fixture separately checks that Sharpen increases edge
energy by over 5%, changes output pixels, and does not move the crop.
Fallback tests cover a blocked CDN and thrown resize errors/recovery. Only the
blocked pica URL's expected `net::ERR_FAILED` console message is allowed in the
CDN-failure test; unrelated errors still fail. JPEG-error injection targets only
the JPEG worker protocol, leaving the newly introduced pica workers functional.

Before regenerating the intentional pica goldens, new-vs-historical-golden RGB
MAE was **0.6887111111 (off)** / **0.7237777778 (on)**. Off's independent-reference
MAE was **0.9747851852**. Those intentional goldens are unchanged by the later
zone-plate regression improvement.

## Phone memory and lifecycle

All file loads share one sequential preparation queue, including individual
inputs and box drops. Bulk import was already sequential; the original problem
was retaining full-resolution sources, not parallelizing that bulk loop.
Large inputs are reduced **once to a 2048px longest-side working copy** (at most
4,194,304 pixels), then saved to a lossless PNG blob. Small inputs are unchanged.
Only this working URL reaches Croppie and the app's retained Image. There is no
retained per-box ImageBitmap, FileReader or base64 URL. Inputs are cleared after
selection so their FileLists do not retain original files after processing.

JPEG/PNG dimensions are read from at most 256KiB of headers before decoding;
JPEG EXIF orientations 5–8 swap the target axes. Other formats use a temporary
Image's load metadata (without forcing `decode()`); its URL/src are released
before preparation. The preferred path is native `createImageBitmap(Blob)` with
high-quality resize and `imageOrientation: 'from-image'`, followed by a bounded
canvas and PNG encoding. A small capability probe checks that resize options
are honored, avoiding a full-resolution bitmap on older implementations.
The bitmap is closed and the canvas zeroed in `finally`. Native orientation is
baked into the working PNG; small originals use the browser's EXIF handling.
The decoder's own internal allocation is browser-controlled, not a JavaScript
heap or canvas allocation; a resize request does not prove it never temporarily
decodes the original. No more than one such preparation is active.

If bitmap resizing is unavailable/fails, sources up to 16,777,216 pixels use one
temporary decoded Image and high-quality drawImage into a bounded canvas.
Larger sources fail with an actionable per-slot message instead of explicitly
forcing an unsafe full-resolution decode. Unsupported/corrupt files retain
their own error slots while subsequent files continue in order. Replace frees
the previous photo before preparation, so a failed replacement leaves an error
slot rather than retaining the old image. Reset invalidates queued bulk work.

Zoom is capped at 1 working pixel per output pixel for adequately sized images;
inherently small inputs can still enlarge to cover the viewport. This trades
the old extreme full-resolution zoom for bounded phone memory. Cropping is
otherwise unchanged. The final resize still uses pica Lanczos3/unsharp, now
one worker with 512px tiles and a one-second idle lifetime instead of four
long-lived workers. The new working-copy coordinate mapping is accounted for
by the zone-plate frequency calculation; its threshold and F10 goldens are not
regenerated or weakened.

Every app canvas is bounded: source preparation/crop <=2048²; output is rejected
**before allocation** above 16,777,216 pixels or 16,384px tall. Render's patch,
tile, output and JPEG worker canvases are zeroed after use, including errors.
The JPEG snapshot bitmap is closed and its dedicated worker/URL terminated and
revoked. Clear/Replace/removal/Reset clear Image src values and revoke photo
URLs. Viewport rebuilding transfers ownership of existing working URLs rather
than leaking/revoking them prematurely. Hidden result src and URL are cleared.

### Allocation audit: four 8064×6048 JPEGs

One original RGBA raster is **186.05MiB**; four are **744.19MiB**.
Before the fix, each box held the original data URL, app Image, full-sized
ImageBitmap and Croppie Image. Counting one or two decoded Image surfaces plus
the bitmap gives **1,488–2,233MiB** of logical retained raster storage for four
photos. Browser cache/GPU sharing can reduce physical usage; this is an estimate,
not a measured process-memory claim. Base64 adds 4/3 of encoded bytes as string
characters (one or two bytes per character), in addition to native decoded data.
At fit zoom the old crop scratch canvas was **35.71MP**, over iOS's area limit.
Old Clear/Replace/Reset closed stored bitmaps but relied on GC for Images/data
URLs; output canvas/preview allocations survived reset, and the strip was not
area-checked.

Afterward, each 4:3 working image is **2048×1536 = 12MiB**. Four app/Croppie
images cost **48–96MiB** of logical decoded storage depending on cache sharing,
plus content-dependent compressed working blobs (not base64 strings). An upload
temporarily owns one 12MiB bitmap and a 12MiB canvas, not four originals. A
browser may still allocate a transient original during native decode, but the
app no longer retains it or duplicates it per box. For ordinary 150px boxes,
the strip/encoding snapshot is only 150×600×4 = 0.343MiB each.

Instrumented Chromium at 390×844, uploading four generated 48MP JPEGs and
rendering, measured (JS heap sampled via CDP every 50ms):

| Allocation | Before | After |
| --- | ---: | ---: |
| Peak main-page JS heap (CDP Performance) | 16,533,688 B | 15,785,576 B |
| Peak live main-thread canvas estimate (RGBA×area) | 143,360,312 B | 12,582,912 B |
| Largest individual canvas | 35,712,576 px | 3,145,728 px |
| Peak explicitly tracked main-thread ImageBitmaps | 793,895,580 B | 12,582,912 B |
| Retained large ImageBitmaps after render | 780,337,152 B | 0 B |

These synthetic, flat-quadrant JPEGs are 289,413 encoded bytes each, so they
exercise native decoded allocations without realistic compressed-photo heap
costs. JS heap alone is **not** the OOM metric: CDP excludes most image/GPU and
worker memory. The canvas/bitmap probe records logical RGBA storage, not RSS,
and excludes worker-internal surfaces. The counter also sees ~40KiB of small
canvases and an 8-byte bitmap from unclosed/GC-eligible pica capability probes;
instrumentation holds references, so this is not evidence of real-world
retention. A small capability-probe script URL lasts until page unload, while
the active resize worker/script is reclaimed after its idle period. These are
not per-photo leaks. Resource tests distinguish image URLs from library-owned
scripts. Source/header/encoded Blob storage is separate.

`@phone` runs in Chromium and Linux WebKit at 390×844. It checks four full-sized
JPEG uploads, bounded sources/canvases/bitmaps, rendering, large and small EXIF-6
fixtures (actual viewport screenshot pixels plus exported pixels), corrupt HEIC
batch recovery, source-URL ownership across Clear/Replace/rebuild/Reset,
pending-load cancellation, legacy bitmap behavior, native metadata loading,
and rejection of unsafe output geometry. JPEG fixtures are generated in a
separate desktop Chromium process, then that process is closed before uploads;
its intentionally large fixture-generation canvas is not an app allocation.
WebKit does not expose CDP heap metrics. Linux WebKit/mobile viewport emulation
does **not** reproduce iOS's WebContent process budget. Real iOS, the reported
phone/files, and successful HEIC/HDR decoding remain unverified.

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
3071x3067 sinusoidal zone plates, and smooth detailed patterns.

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
