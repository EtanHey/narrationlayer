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

## P2a → P2a-states (PR 2/2)

"Before" is the PR 1/2 head's committed still. "After" is the same still at the PR 2/2 head.

| Pair | Before px | After px | Union px | Changed px | Changed % | Diff |
|---|---|---|---|---|---|---|
| 1280 initial page | 1280×900 | 1280×900 | 1280×900 | 7,365 / 1,152,000 | 0.64 | `a-to-b-1280-page-initial-diff.png` |
| 1280 draft | 559×427 | 559×427 | 559×427 | 0 / 238,693 | 0.00 | `a-to-b-1280-state-draft-diff.png` |
| 1280 saved | 559×350 | 559×350 | 559×350 | 0 / 195,650 | 0.00 | `a-to-b-1280-state-saved-diff.png` |
| 1280 final page | 1280×900 | 1280×977 | 1280×977 | 1,033,848 / 1,250,560 | 82.67 | `a-to-b-1280-page-final-diff.png` |
| 390 initial page | 780×2664 | 780×2872 | 780×2872 | 1,307,356 / 2,240,160 | 58.36 | `a-to-b-390-page-initial-diff.png` |
| 390 draft | 780×854 | 780×854 | 780×854 | 12 / 666,120 | 0.00 | `a-to-b-390-state-draft-diff.png` |
| 390 saved | 780×699 | 780×699 | 780×699 | 0 / 545,220 | 0.00 | `a-to-b-390-state-saved-diff.png` |
| 390 final page | 780×2664 | 780×3066 | 780×3066 | 1,436,753 / 2,391,480 | 60.08 | `a-to-b-390-page-final-diff.png` |

Reading the diffs:
- **Initial page:** the only change is the harness banner. At 1280 that means the new controls and the reworded "other devices and network failures" line. At 390 the extra control row pushes everything below it down, so the shifted content counts as changed.
- **Draft and saved:** these field states are unchanged by P2a-states. The 12 px at 390 draft are anti-aliasing at the corners of the focused editor's ring.
- **Final page:** it differs because P2a-states' capture reaches more states (conflict resolved, a note saved after a lost acknowledgement, capacity on question 2) and changes the page height.
- **New states:** conflict, capacity, not confirmed and account switched have no counterpart at the PR 1/2 head. Their stills are in `proof/screens/`.
