// timeline-zoom.js — shared wheel-zoom for every time-axis canvas in the app
// (Forge waveform, Editor waveform, Player range overview).
//
// Each of those draws a whole song across a fixed-width canvas, which is
// useless for picking a exact spot in a five-minute track. This keeps a visible
// window {start, span} in seconds and does the x<->time mapping through it.
// Wheel zooms around the pointer, shift-wheel pans, double-click resets.
(() => {
  'use strict';

  function createTimelineZoom(element, getDuration, onChange) {
    const view = { start: 0, span: 0 };   // span 0 == show everything
    const duration = () => Math.max(0, Number(getDuration()) || 0);
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

    function span() {
      const total = duration();
      if (!total) return 1;
      return clamp(view.span > 0 ? view.span : total, 0.25, total);
    }
    function start() {
      const total = duration();
      return clamp(view.start, 0, Math.max(0, total - span()));
    }

    const api = {
      span, start,
      zoomed: () => view.span > 0 && view.span < duration(),
      // time -> x within a canvas of `width` css pixels, and back
      xFor: (time, width) => (time - start()) / span() * width,
      timeAt: (x, width) => start() + (x / width) * span(),
      reset() { view.span = 0; view.start = 0; if (onChange) onChange(); },
      // keep a moving playhead inside the window
      follow(time) {
        if (!api.zoomed()) return;
        const s = start(), w = span();
        if (time < s || time > s + w) { view.start = clamp(time - w * 0.35, 0, duration() - w); if (onChange) onChange(); }
      },
    };

    element.addEventListener('wheel', (event) => {
      const total = duration();
      if (!total) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const current = span();
      if (event.shiftKey) {
        view.span = current;
        view.start = clamp(start() + (event.deltaY / rect.width) * current, 0, total - current);
      } else {
        const anchor = start() + ratio * current;
        const next = clamp(current * Math.exp(event.deltaY * 0.0016), 0.5, total);
        view.span = next >= total ? 0 : next;
        view.start = clamp(anchor - ratio * span(), 0, Math.max(0, total - span()));
      }
      if (onChange) onChange();
    }, { passive: false });

    element.addEventListener('dblclick', () => api.reset());
    return api;
  }

  window.TimelineZoom = createTimelineZoom;
})();
