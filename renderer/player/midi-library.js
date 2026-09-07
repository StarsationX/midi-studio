// midi-library.js — where the Player's "See all" song browser gets its files.
//
// This used to be an IIFE loaded AFTER app.js that injected a "Transcribed
// songs" <select> into the sidebar and reached for a GLOBAL setMidiFile(). The
// Library tab supersedes that picker, and the global dependency was a trap: any
// rewrite that scoped app.js silently deleted the feature with no error.
//
// So it is now a plain, explicitly-required data module. app.js asks it for
// songs; it never touches the DOM and never assumes a global exists. The
// persistent-mappings-folder button it used to inject now lives where it
// belongs, in Playback settings > Mapping (app.js), so custom mappings keep
// surviving updates.
(function (global) {
  'use strict';

  var LAST_KEY = 'midi-studio.lib.last';

  function basename(p) {
    return global.Fmt ? global.Fmt.basename(p) : String(p || '').split(/[\\/]/).pop();
  }
  function dirname(p) {
    return global.Fmt ? global.Fmt.dirname(p) : String(p || '').replace(/[\\/][^\\/]*$/, '');
  }

  var dir = '';
  var files = [];          // [{path, name, dir}]
  var loaded = false;
  var inflight = null;
  var listeners = [];
  var unsubChanged = null;

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* a bad listener is not fatal */ }
    }
  }

  function shape(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (typeof p !== 'string' || !/\.midi?$/i.test(p)) continue;
      out.push({ path: p, name: basename(p), dir: dirname(p) });
    }
    out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return out;
  }

  // The folder the app's own transcriptions land in: a manual pick, else the
  // last transcription's folder, else the Forge output folder. main resolves
  // that; we only cache the answer.
  function resolveDir() {
    var studio = global.studio;
    if (!studio || !studio.getLibraryDir) return Promise.resolve('');
    return studio.getLibraryDir().then(function (d) { return d || ''; }, function () { return ''; });
  }

  function refresh() {
    var studio = global.studio;
    if (!studio || !studio.listMidis) {
      files = []; loaded = true; inflight = null; notify();
      return Promise.resolve(files);
    }
    if (inflight) return inflight;
    inflight = resolveDir().then(function (d) {
      dir = d;
      if (!d) return [];
      return studio.listMidis(d).catch(function () { return []; });
    }).then(function (list) {
      files = shape(Array.isArray(list) ? list : []);
      loaded = true;
      inflight = null;
      notify();
      return files;
    }, function () {
      files = []; loaded = true; inflight = null; notify();
      return files;
    });
    return inflight;
  }

  var API = {
    // The folder these songs came from, '' when there is none yet.
    dir: function () { return dir; },
    dirName: function () { return dir ? dir.split(/[\\/]/).filter(Boolean).pop() : ''; },
    // Cached list; call refresh() (or ready()) first.
    files: function () { return files; },
    loaded: function () { return loaded; },
    ready: function () { return loaded && !inflight ? Promise.resolve(files) : refresh(); },
    refresh: refresh,

    // Let the user point it somewhere else. Resolves to the new folder or ''.
    pickFolder: function () {
      var studio = global.studio;
      if (!studio || !studio.pickFolder) return Promise.resolve('');
      return studio.pickFolder().then(function (d) {
        if (!d) return '';
        var done = studio.setLibraryDir ? studio.setLibraryDir(d) : Promise.resolve();
        return Promise.resolve(done).catch(function () {}).then(function () {
          loaded = false;
          return refresh().then(function () { return dir; });
        });
      }, function () { return ''; });
    },

    // Which song was opened from here last, so the browser can preselect it.
    last: function () {
      try { return localStorage.getItem(LAST_KEY) || ''; } catch (e) { return ''; }
    },
    remember: function (p) {
      try { localStorage.setItem(LAST_KEY, p || ''); } catch (e) { /* private mode */ }
    },

    // fn() whenever the list changes. Returns an unsubscribe.
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    // A finished transcription changes the folder contents, and main already
    // broadcasts that, so nothing here polls.
    watch: function () {
      if (unsubChanged) return unsubChanged;
      var studio = global.studio;
      if (studio && studio.onLibraryChanged) {
        unsubChanged = studio.onLibraryChanged(function () { loaded = false; refresh(); });
      } else {
        unsubChanged = function () {};
      }
      return unsubChanged;
    },

    dispose: function () {
      if (unsubChanged) { try { unsubChanged(); } catch (e) {} unsubChanged = null; }
      listeners.length = 0;
    }
  };

  global.PlayerLibrary = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : window);
