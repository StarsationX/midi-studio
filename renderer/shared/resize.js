// resize.js: draggable dividers for the app's fixed layout tracks.
//
// Every tab is a CSS grid with hard-coded track sizes: a 312px sidebar, a 290px
// rail, a 156px overview strip. Those are reasonable defaults and wrong for
// somebody with a 1366x768 laptop or an ultrawide, and there was no way to
// change any of them.
//
// A divider drives one CSS custom property on the grid container, so the grid
// keeps owning the layout and nothing here has to know what the other tracks
// are. Sizes are remembered per divider.
//
// Markup:
//   <div class="split" style="--side: 312px" data-split="side-w">
//     <aside>...</aside>
//     <i class="grip-h" data-resize="side" data-min="220" data-max="560"></i>
//     <main>...</main>
//   </div>
//
//   data-resize   the custom property to drive, without the dashes
//   data-min/max  bounds in px
//   data-axis     "x" (default) or "y"
//   data-invert   dragging right/down makes the tracked pane SMALLER
'use strict';

(function (global) {
  const STORE = 'midi-studio:splits';

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (_) { return {}; }
  }
  // Read, merge, write. Every tab is a separate frame with its own copy of this
  // module, and they share one localStorage: writing a whole snapshot back
  // erased whatever the other tabs had saved since this one started, so the
  // last pane touched was the only one that survived a reload.
  function remember(k, px) {
    const all = load();
    all[k] = px;
    try { localStorage.setItem(STORE, JSON.stringify(all)); } catch (_) { /* private mode */ }
  }
  function forget(k) {
    const all = load();
    delete all[k];
    try { localStorage.setItem(STORE, JSON.stringify(all)); } catch (_) { /* private mode */ }
  }

  const sizes = load();
  const key = (handle) => {
    const owner = handle.closest('[data-split]');
    return `${(owner && owner.dataset.split) || 'root'}:${handle.dataset.resize}`;
  };

  function clamp(handle, px) {
    const min = Number(handle.dataset.min) || 80;
    const max = Number(handle.dataset.max) || 900;
    return Math.round(Math.max(min, Math.min(max, px)));
  }

  function applyTo(handle, px) {
    const owner = handle.closest('[data-split]') || handle.parentElement;
    if (!owner) return;
    owner.style.setProperty(`--${handle.dataset.resize}`, px + 'px');
  }

  function currentPx(handle) {
    const owner = handle.closest('[data-split]') || handle.parentElement;
    const raw = getComputedStyle(owner).getPropertyValue(`--${handle.dataset.resize}`);
    const px = parseFloat(raw);
    if (Number.isFinite(px)) return px;
    // No property set yet: measure the pane the handle sits against, so the
    // first drag starts from where the layout actually is rather than jumping.
    const axis = handle.dataset.axis === 'y' ? 'y' : 'x';
    const pane = handle.dataset.invert ? handle.nextElementSibling : handle.previousElementSibling;
    if (!pane) return 0;
    const r = pane.getBoundingClientRect();
    return axis === 'y' ? r.height : r.width;
  }

  function attach(handle) {
    if (handle.dataset.resizeReady) return;
    handle.dataset.resizeReady = '1';
    const axis = handle.dataset.axis === 'y' ? 'y' : 'x';
    const invert = handle.dataset.invert !== undefined;

    handle.setAttribute('role', 'separator');
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('aria-orientation', axis === 'y' ? 'horizontal' : 'vertical');
    if (!handle.getAttribute('aria-label')) handle.setAttribute('aria-label', 'Resize');

    const stored = sizes[key(handle)];
    if (Number.isFinite(stored)) applyTo(handle, clamp(handle, stored));

    let from = null;
    const move = (e) => {
      if (!from) return;
      const delta = (axis === 'y' ? e.clientY - from.y : e.clientX - from.x) * (invert ? -1 : 1);
      applyTo(handle, clamp(handle, from.px + delta));
    };
    const up = () => {
      if (!from) return;
      from = null;
      document.body.classList.remove('is-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      remember(key(handle), currentPx(handle));
      // Canvases size themselves off their box, and several are only told to
      // redraw on a window resize.
      window.dispatchEvent(new Event('resize'));
    };
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      from = { x: e.clientX, y: e.clientY, px: currentPx(handle) };
      document.body.classList.add('is-resizing');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    // Keyboard, because a divider you can only reach with a mouse is not a
    // control for everybody.
    handle.addEventListener('keydown', (e) => {
      const less = axis === 'y' ? 'ArrowUp' : 'ArrowLeft';
      const more = axis === 'y' ? 'ArrowDown' : 'ArrowRight';
      if (e.key !== less && e.key !== more) return;
      e.preventDefault();
      const step = (e.shiftKey ? 40 : 8) * (e.key === more ? 1 : -1) * (invert ? -1 : 1);
      applyTo(handle, clamp(handle, currentPx(handle) + step));
      remember(key(handle), currentPx(handle));
      window.dispatchEvent(new Event('resize'));
    });

    // Double-click puts it back where it started.
    handle.addEventListener('dblclick', () => {
      const owner = handle.closest('[data-split]') || handle.parentElement;
      owner.style.removeProperty(`--${handle.dataset.resize}`);
      forget(key(handle));
      window.dispatchEvent(new Event('resize'));
    });
  }

  function apply(root) {
    for (const handle of (root || document).querySelectorAll('[data-resize]')) attach(handle);
  }

  global.Resize = { apply, attach };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => apply());
  } else {
    apply();
  }
})(window);
