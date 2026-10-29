# E2E screenshot diffs

Pixel diffs between committed stills, computed in a canvas inside the agent browser (Chrome Beta, CDP 9333).
No dependency was added.

- **Changed pixel:** any RGBA channel differs, or the pixel lies outside one of the two images (a size mismatch).
- **Image:** changed pixels are red, drawn over a faded grey copy of the "after" still.
- **%:** changed pixels / union area (max width × max height).

Captures used the same viewports as `proof/capture.mjs`: 1280×900 at DSF 1, and 390×844 at DSF 2 with `isMobile` and `hasTouch`.

## master → P2a (PR 1/2)

"Before" is master's actual client shell: `capsule/client/index.tsx` at `92adeeb`, byte-for-byte.
- It renders one placeholder paragraph.
- It was mounted with Preact on a static page carrying the same Tailwind base CSS the harness uses.
- This is not the Lakebed dev server's sign-in chrome.

Files: `proof/before/1280-master-shell.png`, `proof/before/390-master-shell.png`.
"After" is the P2a harness initial page, `proof/screens/{1280,390}-page-initial.png`.

| Pair | Before px | After px | Union px | Changed px | Changed % | Diff |
|---|---|---|---|---|---|---|
| 1280 initial | 1280×900 | 1280×900 | 1280×900 | 1,144,562 / 1,152,000 | 99.35 | `1280-initial-diff.png` |
| 390 initial | 780×1688 | 780×2664 | 780×2664 | 2,044,377 / 2,077,920 | 98.39 | `390-initial-diff.png` |

Near-total change is expected. The ground goes from white to mist `#E6ECEA`, and every element is new.
The few unchanged pixels are pure white in both images: the harness banner text, the selected controls and the play glyph.
