// changelog.js — the CHANGELOG.md parser behind the What's New screen.
//
// Dependency-free, DOM-free and side-effect-free, so the same file loads as a
// classic script in the shell (window.Changelog) and under Node for the tests
// (module.exports), which is the pattern every shared module here follows.
//
// The format it reads is the one CHANGELOG.md documents at the top of itself:
//
//   ## 3.0.0 "Graphite" — 2026-09-07
//   an optional intro paragraph
//   ### New
//   - a bullet
//   - **A lead.** the rest of the bullet
//
// Two hard rules, because this runs on a file a user can edit and on release
// notes fetched from GitHub:
//   1. it NEVER throws. Every entry point returns { ok:false, error } instead,
//      and the screen degrades to a link to the full changelog.
//   2. anything it does not understand is ignored rather than guessed at.
'use strict';

(function (root) {
  // A release heading: '## 3.0.0 "Graphite" — 2026-09-07'. The version must
  // start with a digit, which is the whole reason '## Changelog' is not read as
  // a release. Name quotes may be straight or curly; the date separator may be
  // a hyphen, either dash, a middot or a colon, or absent.
  var H_RELEASE = /^#{1,3}\s+v?(\d[^\s"“(]*)\s*(?:["“']([^"”']*)["”']\s*)?(?:[-–—·:,]\s*(.*?)\s*)?$/;
  // A section heading. In a changelog these are '###'; a GitHub release body
  // just as often uses '##', so both are accepted and the release test above
  // gets first refusal.
  var H_SECTION = /^#{2,4}\s+(.+?)\s*$/;
  var BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
  var CONT = /^\s{2,}(\S.*)$/;

  // Canonical section names, in the order the screen shows them. 'New' first is
  // the point of the screen; 'Known issues' is last because it is the caveat,
  // not the news. Anything unrecognised keeps its own wording and sits between
  // the two, in file order.
  var CANON = {
    'new': 'New', 'added': 'New', 'additions': 'New', 'features': 'New',
    'changed': 'Changed', 'changes': 'Changed', 'improved': 'Changed', 'improvements': 'Changed',
    'fixed': 'Fixed', 'fixes': 'Fixed', 'bug fixes': 'Fixed', 'bugfixes': 'Fixed',
    'removed': 'Removed', 'deprecated': 'Deprecated',
    'known issues': 'Known issues', 'known limitations': 'Known issues', 'caveats': 'Known issues'
  };
  var RANK = { 'New': 0, 'Changed': 1, 'Fixed': 2, 'Removed': 3, 'Deprecated': 4, 'Known issues': 9 };

  function canonSection(raw) {
    var t = String(raw || '').trim().replace(/[:.]+$/, '');
    var hit = CANON[t.toLowerCase()];
    if (hit) return hit;
    if (!t) return 'Notes';
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function rankOf(title) {
    return Object.prototype.hasOwnProperty.call(RANK, title) ? RANK[title] : 5;
  }

  // Inline markdown, reduced to what this screen can render: a leading bold run
  // becomes the bullet's lead, everything else becomes plain text. Nothing here
  // produces markup, so nothing here can inject any.
  function stripInline(s) {
    return String(s == null ? '' : s)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s.,;:)!?]|$)/g, '$1$2')
      .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s.,;:)!?]|$)/g, '$1$2')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // A bullet splits into an optional lead and the rest, so the screen can give
  // the lead more weight without inventing an emphasis of its own.
  //
  // A leading bold run is only a LEAD when it ends a sentence fragment
  // ('**Library.**'). '**Forge** is one workspace' is mid-sentence emphasis, and
  // pulling it out left the bullet reading 'Forge' / 'is one workspace'.
  function toItem(text) {
    var raw = String(text || '').replace(/\s+/g, ' ').trim();
    var lead = '';
    var m = /^\*\*\s*([^*]+?)\s*\*\*\s*(.*)$/.exec(raw);
    if (m && /[.:!?—]$/.test(m[1].trim())) { lead = stripInline(m[1]); raw = m[2]; }
    var body = stripInline(raw);
    if (!lead && !body) return null;
    return { lead: lead, text: body };
  }

  function lines(md) {
    return String(md).replace(/\r\n?/g, '\n').split('\n');
  }

  // Read the body of one release (or one whole release-notes blob): intro
  // paragraphs, then '### Section' groups of bullets.
  function readBody(ls, from, to, opts) {
    var intro = [];
    var sections = [];
    var cur = null;
    var para = [];
    var loose = [];                       // bullets that arrived before any heading
    var sectionHeads = !opts || opts.sections !== false;

    var flushPara = function () {
      var t = stripInline(para.join(' '));
      para.length = 0;
      if (!t) return;
      if (cur) cur.trailing.push(t); else intro.push(t);
    };
    var push = function (item) {
      if (!item) return;
      if (cur) cur.items.push(item); else loose.push(item);
    };

    for (var i = from; i < to; i++) {
      var line = ls[i];
      if (!line || !line.trim()) { flushPara(); continue; }
      if (/^\s*(?:---+|\*\*\*+|===+)\s*$/.test(line)) { flushPara(); continue; }

      var sec = sectionHeads ? H_SECTION.exec(line) : null;
      if (sec && !H_RELEASE.test(line)) {
        flushPara();
        var title = canonSection(sec[1]);
        cur = { title: title, items: [], trailing: [], rank: rankOf(title), at: sections.length };
        sections.push(cur);
        continue;
      }
      var b = BULLET.exec(line);
      if (b) {
        flushPara();
        push(toItem(b[1]));
        // Wrapped bullets: an indented continuation line belongs to the bullet
        // above it, not to a paragraph of its own.
        var target = cur ? cur.items : loose;
        while (i + 1 < to && ls[i + 1] && !BULLET.test(ls[i + 1]) && CONT.test(ls[i + 1])) {
          i += 1;
          var tail = target[target.length - 1];
          if (tail) tail.text = stripInline((tail.text + ' ' + CONT.exec(ls[i])[1]).trim());
        }
        continue;
      }
      if (/^#{1,6}\s/.test(line)) { flushPara(); continue; }   // a heading we do not read
      para.push(line.trim());
    }
    flushPara();

    // Bullets with no heading above them are still the news; give them one.
    if (loose.length) {
      sections.unshift({ title: 'Notes', items: loose, trailing: [], rank: -1, at: -1 });
    }
    sections = sections.filter(function (s) { return s.items.length || s.trailing.length; });
    sections.sort(function (a, b) { return a.rank - b.rank || a.at - b.at; });
    return { intro: intro, sections: sections.map(function (s) {
      return { title: s.title, items: s.items, notes: s.trailing };
    }) };
  }

  function releaseAt(ls, head, from, to) {
    var m = H_RELEASE.exec(ls[head]);
    var body = readBody(ls, from, to, { sections: true });
    return {
      version: m[1].replace(/[.,;:]+$/, ''),
      name: (m[2] || '').trim(),
      date: (m[3] || '').trim(),
      intro: body.intro,
      sections: body.sections
    };
  }

  // ---- public -------------------------------------------------------------

  // parse(markdown) -> { ok, releases } | { ok:false, error }
  function parse(md) {
    try {
      if (typeof md !== 'string' || !md.trim()) return { ok: false, error: 'empty', releases: [] };
      var ls = lines(md);
      var heads = [];
      for (var i = 0; i < ls.length; i++) {
        if (/^#{1,3}\s/.test(ls[i]) && H_RELEASE.test(ls[i])) heads.push(i);
      }
      if (!heads.length) return { ok: false, error: 'no release headings', releases: [] };
      var out = [];
      for (var h = 0; h < heads.length; h++) {
        var end = h + 1 < heads.length ? heads[h + 1] : ls.length;
        var rel = releaseAt(ls, heads[h], heads[h] + 1, end);
        if (rel.version) out.push(rel);
      }
      if (!out.length) return { ok: false, error: 'no releases', releases: [] };
      return { ok: true, releases: out };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), releases: [] };
    }
  }

  // parseNotes(markdown, meta) -> one release-shaped object for a GitHub
  // release body, which carries no '## <version>' heading of its own.
  function parseNotes(md, meta) {
    meta = meta || {};
    try {
      if (typeof md !== 'string' || !md.trim()) return { ok: false, error: 'empty' };
      var ls = lines(md);
      // A body that DOES open with a version heading is a changelog extract;
      // let the real parser have it and take the newest entry.
      for (var i = 0; i < ls.length; i++) {
        if (!ls[i].trim()) continue;
        if (/^#{1,3}\s/.test(ls[i]) && H_RELEASE.test(ls[i])) {
          var p = parse(ls.slice(i).join('\n'));
          if (p.ok) {
            var r = p.releases[0];
            return { ok: true, release: {
              version: meta.version || r.version, name: r.name || meta.name || '',
              date: r.date || meta.date || '', intro: r.intro, sections: r.sections
            } };
          }
        }
        break;
      }
      var body = readBody(ls, 0, ls.length, { sections: true });
      if (!body.sections.length && !body.intro.length) return { ok: false, error: 'nothing to show' };
      return { ok: true, release: {
        version: String(meta.version || ''), name: String(meta.name || ''),
        date: String(meta.date || ''), intro: body.intro, sections: body.sections
      } };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // Same-release lookup that tolerates a 'v' prefix and a build suffix.
  function find(releases, version) {
    var want = String(version || '').trim().replace(/^v/i, '');
    var list = (releases && releases.length) ? releases : [];
    if (!list.length) return null;
    if (!want) return list[0];
    for (var i = 0; i < list.length; i++) if (list[i].version === want) return list[i];
    for (var j = 0; j < list.length; j++) if (list[j].version.indexOf(want) === 0) return list[j];
    return null;
  }

  // How many bullets a release actually carries — the screen uses it to decide
  // between rendering and degrading.
  function count(release) {
    var n = 0;
    for (var i = 0; i < ((release && release.sections) || []).length; i++) n += release.sections[i].items.length;
    return n;
  }

  var api = { parse: parse, parseNotes: parseNotes, find: find, count: count,
    canonSection: canonSection, stripInline: stripInline, SECTION_ORDER: RANK };

  if (root) root.Changelog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null)));
