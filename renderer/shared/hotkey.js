// hotkey.js: the one hotkey capture widget, and the one pynput translation.
//
// CONTRACT §12 #25. The Player's ten global bindings live in the Python sidecar,
// which speaks pynput's `<ctrl>+<f6>` syntax, so a capture box has to turn a
// browser KeyboardEvent into that string and back into something a person can
// read. Perch already replays transport as a synthetic hotkey and a remapper is
// wanted in more than one panel, so none of that may live inside a tab.
//
// Three rules this module exists to keep:
//
//   1. `e.code` decides the character, never `e.key`, so Shift+; binds as ';'
//      and not ':'. A pynput listener sees the physical key.
//   2. EMPTY MEANS UNBOUND (invariant 13) for every slot, play/pause/stop
//      included, so those keys can be freed for the game. There is no springing
//      back to a default.
//   3. A focused capture box SUSPENDS the global hotkeys (invariant 13), or the
//      key being rebound fires its old action while you are rebinding it. The
//      widget cannot do that itself -- only the owner knows how to talk to the
//      engine -- so it calls onCapture()/onCommit() and the owner does it.
//
// The CSS (.hk, .hk.is-capturing, .hk.is-empty, .hk-slot, .hk-clear) is already
// in ui.css §2.9. This module builds exactly that markup and nothing else: the
// row, the label and the layout around it belong to the panel.
'use strict';

(function (global) {
  // e.key -> pynput's name for keys that are not a single character.
  var NAMED = {
    ' ': '<space>', 'Enter': '<enter>', 'Tab': '<tab>',
    'Home': '<home>', 'End': '<end>', 'Insert': '<insert>',
    'PageUp': '<page_up>', 'PageDown': '<page_down>',
    'ArrowUp': '<up>', 'ArrowDown': '<down>',
    'ArrowLeft': '<left>', 'ArrowRight': '<right>',
    'Pause': '<pause>', 'ScrollLock': '<scroll_lock>',
    'CapsLock': '<caps_lock>', 'NumLock': '<num_lock>',
    'PrintScreen': '<print_screen>'
  };
  // e.code gives the UNSHIFTED character, so Shift+; binds as ';' not ':'.
  var CODE_CHAR = {
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    Backslash: '\\', BracketLeft: '[', BracketRight: ']',
    Minus: '-', Equal: '=', Backquote: '`', IntlBackslash: '`'
  };
  // pynput token -> what a person reads.
  var LABELS = {
    '<space>': 'Space', '<enter>': 'Enter', '<tab>': 'Tab', '<esc>': 'Esc',
    '<home>': 'Home', '<end>': 'End', '<insert>': 'Insert', '<delete>': 'Delete',
    '<page_up>': 'PgUp', '<page_down>': 'PgDn',
    '<up>': '↑', '<down>': '↓', '<left>': '←', '<right>': '→',
    '<ctrl>': 'Ctrl', '<alt>': 'Alt', '<shift>': 'Shift', '<cmd>': 'Win',
    '<pause>': 'Pause', '<scroll_lock>': 'ScrLk', '<caps_lock>': 'Caps',
    '<num_lock>': 'NumLk', '<print_screen>': 'PrtSc'
  };
  var MODIFIER_KEYS = ['Control', 'Alt', 'Shift', 'Meta'];

  // A KeyboardEvent as pynput syntax, or null when the event carries no key of
  // its own yet (a modifier pressed on its own: keep listening).
  function toPynput(e) {
    if (!e || MODIFIER_KEYS.indexOf(e.key) >= 0) return null;
    var mods = [];
    if (e.ctrlKey) mods.push('<ctrl>');
    if (e.altKey) mods.push('<alt>');
    if (e.shiftKey) mods.push('<shift>');
    var code = e.code || '';
    var b;
    if (/^F\d{1,2}$/.test(e.key)) b = '<' + e.key.toLowerCase() + '>';
    else if (/^[a-z0-9]$/i.test(e.key) && code.indexOf('Numpad') !== 0) b = e.key.toLowerCase();
    else if (NAMED[e.key]) b = NAMED[e.key];
    else if (CODE_CHAR[code]) b = CODE_CHAR[code];
    else if (e.key && e.key.length === 1 && code.indexOf('Numpad') !== 0) b = e.key.toLowerCase();
    else if (e.keyCode) b = '<' + e.keyCode + '>';   // numpad / media / +- fallback
    else return null;
    return mods.concat([b]).join('+');
  }

  // 'Ctrl+<f6>' -> 'Ctrl+F6'. '' stays '' — an unbound slot has no label.
  function label(combo) {
    if (!combo) return '';
    return String(combo).split('+').map(function (part) {
      if (LABELS[part]) return LABELS[part];
      var f = /^<f(\d{1,2})>$/.exec(part);
      if (f) return 'F' + f[1];
      var vk = /^<(\d+)>$/.exec(part);
      if (vk) return 'key ' + vk[1];
      return part.length === 1 ? part.toUpperCase() : part;
    }).join('+');
  }

  function icon(name, size) {
    if (global.Icon && typeof global.Icon.svg === 'function') return global.Icon.svg(name, size);
    return '×';
  }

  // create({label, value, id, describedBy, unbindLabel, placeholder,
  //         onCapture, onCommit, onChange, mount})
  //
  //   label        what this binding does; used in both ARIA labels
  //   value        the current combo in pynput syntax, '' for unbound
  //   onCapture()  the box took focus: SUSPEND the global hotkeys
  //   onCommit(c)  the box settled on a value (blur, clear): persist and re-send
  //   onChange(c)  every accepted keystroke, before the commit
  //   mount        optional parent to append the widget to
  //
  // Returns { el, slot, clear, value(), set(combo), focus(), dispose() }.
  // `el` is the `.hk` element: put it in whatever row the panel wants.
  function create(opts) {
    var o = opts || {};
    var text = o.label == null ? 'Hotkey' : String(o.label);
    var placeholder = o.placeholder || 'Press a key…';
    var empty = o.emptyLabel || 'Unbound';

    var el = document.createElement('div');
    el.className = 'hk';

    var slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'hk-slot';
    if (o.id) slot.id = o.id;
    if (o.describedBy) slot.setAttribute('aria-describedby', o.describedBy);

    // A visible way to unbind. Backspace-while-focused already did it, but
    // nothing on screen said so, so in practice a key stayed bound forever.
    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'hk-clear';
    clear.setAttribute('aria-label', 'Unbind ' + text);
    clear.title = 'Unbind';
    clear.innerHTML = icon('close', 10);

    el.appendChild(slot);
    el.appendChild(clear);

    var combo = o.value ? String(o.value) : '';
    var prev = combo;
    var capturing = false;
    var disposed = false;

    function paint() {
      slot.textContent = combo ? label(combo) : empty;
      el.classList.toggle('is-empty', !combo);
      // Never colour alone: the slot says the word "Unbound" and its ARIA label
      // carries the same thing for a screen reader.
      slot.setAttribute('aria-label', text + ': ' + (combo ? label(combo) : 'unbound'));
    }
    function set(next, quiet) {
      combo = next ? String(next) : '';
      if (capturing) el.classList.remove('is-capturing');
      capturing = false;
      paint();
      if (!quiet && typeof o.onChange === 'function') o.onChange(combo, api);
      return api;
    }
    function commit() {
      if (typeof o.onCommit === 'function') o.onCommit(combo, api);
    }

    function onFocus() {
      prev = combo;
      capturing = true;
      el.classList.add('is-capturing');
      slot.textContent = placeholder;
      if (typeof o.onCapture === 'function') o.onCapture(api);
    }
    function onBlur() {
      capturing = false;
      el.classList.remove('is-capturing');
      // Focused, pressed nothing, left: that is not an unbind.
      if (!combo) set(prev, true); else paint();
      commit();
    }
    function onKeyDown(e) {
      // Every key belongs to this box while it has focus, including Space, Tab
      // and Enter, and none of them may reach the transport behind it.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { slot.blur(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        prev = '';
        set('');
        slot.blur();
        return;
      }
      var next = toPynput(e);
      if (!next) return;              // a modifier on its own: keep listening
      set(next);
      prev = next;
      slot.blur();
    }
    function onClear() {
      prev = '';
      set('');
      commit();
    }

    slot.addEventListener('focus', onFocus);
    slot.addEventListener('blur', onBlur);
    slot.addEventListener('keydown', onKeyDown);
    clear.addEventListener('click', onClear);

    var api = {
      el: el,
      slot: slot,
      clear: clear,
      value: function () { return combo; },
      // set(combo) paints and reports through onChange; set(combo, true) is
      // silent, for restoring a stored value at boot.
      set: set,
      label: function () { return combo ? label(combo) : ''; },
      focus: function () { slot.focus(); return api; },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        slot.removeEventListener('focus', onFocus);
        slot.removeEventListener('blur', onBlur);
        slot.removeEventListener('keydown', onKeyDown);
        clear.removeEventListener('click', onClear);
      }
    };

    paint();
    if (o.mount && o.mount.appendChild) o.mount.appendChild(el);
    return api;
  }

  var API = {
    NAMED: NAMED,
    CODE_CHAR: CODE_CHAR,
    LABELS: LABELS,
    toPynput: toPynput,
    label: label,
    create: create
  };

  global.Hotkey = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : window);
