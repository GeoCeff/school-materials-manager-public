# Interaction guidelines

Archive Search keeps its compact monochrome workspace and bundled Geist fonts. Motion explains a change and then stops. Reading position and native Windows window behavior take precedence over decoration. These are original choices inspired by Bryl Lim's minimal design language, not measured Tarsi animation timings.

## Shared motion

| Interaction | Duration | Treatment |
| --- | --- | --- |
| Press | 90 ms | Subtle inset boundary; no text movement |
| Hover and local success | 140 ms | Fill/border or small opacity reveal |
| Appearance popup | 180 ms in / 120 ms out | 4 px settle, .985 scale, trigger-aligned origin |
| Dialog | 220 ms in / 150 ms out | 6 px settle, .99 scale, coordinated backdrop |
| Explicit palette change | 250 ms | Whole-palette snapshot curtain; no independent text/background fades |
| Windows palette change | Immediate | Quiet atomic update, only in System |

Entry uses `cubic-bezier(.2,.8,.2,1)`; exit uses ease-in. Avoid `transition: all`, springs, persistent pulses, query-result staggers, and animation over PDF pixels. There is no motion dependency or artificial loading delay.

## Appearance

The button exposes the stored System/Light/Dark preference. Its popup uses native Popover lifecycle and `menuitemradio` semantics. The selected check remains separate from hover and keyboard focus. The System description reads the OS-owned media query even while the app uses an explicit palette; Windows chrome remains native.

Enter/Space opens at the selected row. Arrow keys wrap, Home/End go to the edges, and Enter/Space selects. Escape returns focus. Tab dismisses and continues normal navigation. Outside clicks reach their target. Opening a dialog dismisses the popup. Closing rows are inert during their exit.

Preference feedback is immediate; settings writes are serialized and intermediate choices are coalesced. General status replies cannot revert appearance. Same-palette choices update the selected preference without a whole-window transition. A failed latest save restores the confirmed preference in the renderer, native background and service settings, with a retry notice. An older failed write does not replace a newer choice.

Semantic colors change atomically. Supported View Transitions retain complete old/new palettes behind a brief clipping curtain to avoid gray-on-gray intermediate text. If unsupported, changes remain atomic. Snapshots accept no input. Rapid changes finish the prior transition and guard pending snapshot callbacks. The trusted startup preference is supplied before the first useful renderer frame; startup does not animate.

## Reading and overlays

Theme changes do not remount Files, Results, passages or the PDF viewer. Query, filters, scroll, selected text, focus, PDF page and zoom persist. Lists do not animate on polling or every keystroke. Success feedback reserves its footprint, and saving a search does not insert a workspace-shifting banner.

Dialogs use native semantics, modal focus containment and native focus return. CSS discrete transitions retain the closing surface briefly without keeping it interactive. The displayed title/content remains stable during exit. Reopening Saved reloads its data and invalidates callbacks from the earlier visit.

## Reduced motion and validation

Reduced motion removes transforms, entrance/exit delays, snapshot transitions and smooth scrolling. Enabling it during a theme transition finishes the change immediately. Focus and feedback never depend on animation.

Use original synthetic content for screenshots and traces. Check both palettes, all preference pairs, rapid choices, save failure/retry, keyboard dismissal, popup resize/edge placement, dialog reopening, state retention and 1360×900 / 900×700 / 560×520 layouts. Also test native Electron zoom factor 2, not CSS scaling. Inspect intermediate animation frames as well as endpoints.

`tests/ui/appearance-motion.js` checks the synthetic desktop app. `tests/ui/appearance-races.js` installs an isolated browser bridge to test delayed writes, failures and stale status. Core lifecycle tests verify real settings rollback/restart. Keep accessibility-tree evidence distinct from audible speech and renderer offline emulation distinct from physical disconnection. See [release gates](RELEASE_CHECKLIST.md).
