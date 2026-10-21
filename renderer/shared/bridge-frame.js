// bridge-frame.js: a panel's half of shared/bridge.js. Loaded before the
// panel's own scripts; borrows the shell's namespaces, bound to this frame, so
// window.api / forge / review / library / perch / studio look exactly as the
// Electron preload left them. Under Electron the preload got here first and
// this does nothing; opened outside the shell it does nothing either.
(() => {
  'use strict';
  if (window.api) return;
  let host = null;
  try { host = window.parent !== window ? window.parent.__studioBridge : null; } catch (_) {}
  if (typeof host !== 'function') return;
  const ns = host(window);
  for (const k of Object.keys(ns)) {
    Object.defineProperty(window, k, { value: ns[k], configurable: true, enumerable: true });
  }
})();
