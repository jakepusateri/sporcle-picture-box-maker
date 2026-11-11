# Browser characterization tests

The suite preserves the current behavior without changing `index.html`. Selectors
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
application. All unhandled page errors and console errors fail tests, including
expected-failure tests. Favicon requests are fulfilled with 204. B3 catches submit
handler exceptions explicitly and asserts that none occurred, so invalid-input
exceptions are tested rather than allowed to escape as page errors.

## Feature map

| Test | User-visible behavior to preserve |
| --- | --- |
| F1 | Defaults: 150×150, 4 boxes, 2 columns, quality 1.0; output/download initially hidden. |
| F2 | Create builds N upload boxes with W×H Croppie viewports and indexed file inputs. |
| F3 | Upload binds a source image, including one smaller than the viewport. |
| F4 | Render produces visible W×(H·N) JPEG output and a matching downloadable link. |
| F5 | Upload box i becomes vertical output slot i. |
| F6 | Empty upload boxes become white slots. |
| F7 | Increasing count preserves uploads; decreasing removes trailing boxes only. |
| F8 | Reset clears boxes and hides output/download; a fresh create/upload/render works. |
| F9 | Lower JPEG quality yields a smaller data URL for the same input. |
| F10 | Non-default crop position/zoom preserves crop accuracy and current resampling quality. |
| F11 | Changing zoom after rendering updates the next output. |
| F12 | Non-square 200×100 boxes produce correct dimensions and ordered slot colors. |

## Known bugs (expected failures)

`test.fail()` marks the desired behavior below. Unexpected success fails the
suite, prompting removal of the marker when the bug is fixed. The runner may
summarize expected failures as “passed”; individual entries show a cross.

| Test | Desired behavior currently broken |
| --- | --- |
| B1 | Create with changed dimensions must resize existing viewports and output correctly. |
| B2 | Render before Create or after Reset must leave output hidden, not create `data:,`. |
| B3 | Blank, letters, zero, and negative width/height/count must be rejected without boxes, exceptions, or invalid output (12 cases). |
| B4 | Rendering six 4000×3000 sources should take under 1.5s. Logs synchronous rendering time in ms, including resampling and JPEG encoding, excluding upload and JPEG decoding. This is machine-dependent. |
| B5 | `#outcanvas` must not contain script elements (currently swallowed by a self-closing canvas tag). |

## Open question

The Columns field currently only affects the on-screen grid width, not the output.
There is no test for Columns behavior yet. Should it remain a layout-only control,
or should output become a multi-column image?
