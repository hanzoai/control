/*
 * Hanzo Edit — the ever-present "contribute to this page" widget.
 *
 * Drop into ANY Hanzo app:  <script async src="https://hanzo.app/edit.js"></script>
 *
 * The page self-declares its source via <meta> tags:
 *   <meta name="hanzo:repo"     content="owner/repo">   (required)
 *   <meta name="hanzo:path"     content="path/to/file"> (optional default)
 *   <meta name="hanzo:branch"   content="main">         (optional, default main)
 *   <meta name="hanzo:provider" content="github">       (optional, default github)
 *   <meta name="hanzo:key"      content="pk_...">        (optional project key)
 *   <meta name="hanzo:anchor"   content="#selector">     (optional launcher mount)
 *
 * ZERO manual path: the widget resolves the source file(s) for the CURRENT view
 * itself and pre-fills the field (the user may override). It ranks candidates
 * from the best available signal, in order:
 *   1. an explicit `hanzo:path` (a page that maps 1:1 to a file),
 *   2. a React `_debugSource` on the element in view (DEV builds only — absent
 *      in production, so never depended on),
 *   3. the app's build-time route manifest (`/edit-manifest.json`) — the App
 *      Router pathname → `app/…/page.tsx` (+ its layout chain), the reliable
 *      signal since it is derived from the same filesystem convention Next
 *      routes on. Absent on apps that don't ship one → step 4.
 *   4. a convention guess (`app/<segments>/page.tsx` + root layout).
 *
 * Every submission also carries a context trace so a reviewing agent/dev knows
 * exactly where + what: the route, the ranked candidate files, the DOM
 * breadcrumb of what was on screen, the app version, the analytics session id, a
 * present-when-available session-replay deep-link, and a short usage trace.
 *
 * With no hanzo:repo the widget does nothing. Otherwise it renders a small
 * floating control that lets ANYONE suggest a fix, and lets a signed-in user with
 * credits (or an admin) run Hanzo's agent to fork→edit→PR the resolved file. All
 * privilege is enforced SERVER-SIDE by /v1/edit; the widget only shapes the CTA
 * from /v1/me. Framework-free, Shadow-DOM isolated, theme-neutral. No deps.
 */
(function () {
  'use strict';

  // The origin the script was served from is the backend base (works when this
  // runs cross-origin on another Hanzo app). Captured synchronously (currentScript
  // is null inside async callbacks).
  var SELF = document.currentScript;
  if (window.__hanzoEdit) return; // idempotent
  window.__hanzoEdit = true;

  function meta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  // ---- Which repo is this page? ---------------------------------------------
  //
  // The tag is byte-identical on every property:
  //   <script async src="https://hanzo.app/edit.js"></script>
  // so a page that never declares `hanzo:repo` still resolves, from the ONE
  // registry below (host → repo). Keeping the map here — in the single file every
  // site already loads — is why the include needs no per-site thought: adding a
  // property is one line HERE, not a commit in that property's repo.
  //
  // The meta ALWAYS wins when present: a repo knows its own name better than this
  // table does, and a site served on a host we don't list (previews, branch
  // deploys, a new domain) declares itself and works immediately.
  var SITES = {
    'hanzo.ai': 'hanzoai/hanzo.ai',
    'hanzo.app': 'hanzoai/app',
    'hanzo.chat': 'hanzoai/chat',
    'world.hanzo.ai': 'hanzoai/world',
    'docs.hanzo.ai': 'hanzoai/docs',
    'insights.hanzo.ai': 'hanzoai/insights',
    'platform.hanzo.ai': 'hanzoai/platform',
    'cloud.hanzo.ai': 'hanzoai/cloud',
    'ui.hanzo.ai': 'hanzoai/ui',
  };

  // `www.` is never its own property, and an unknown subdomain falls back to the
  // apex's repo only when the apex is one we know.
  function repoForHost(host) {
    host = String(host || '').toLowerCase().replace(/^www\./, '');
    if (SITES[host]) return SITES[host];
    var apex = host.split('.').slice(-2).join('.');
    return SITES[apex] || '';
  }

  var REPO = meta('hanzo:repo') || repoForHost(location.hostname);

  var PATH = meta('hanzo:path');
  var BRANCH = meta('hanzo:branch') || 'main';
  var PROVIDER = meta('hanzo:provider') || 'github';
  var KEY = meta('hanzo:key');

  var BASE = 'https://hanzo.app';
  try {
    if (SELF && SELF.src) BASE = new URL(SELF.src).origin;
  } catch (e) {
    /* keep default */
  }

  // The IAM access token, forwarded as a bearer. Same-site the SDK's session
  // cookie is readable here; a different-site Hanzo app exposes its own token as
  // window.HANZO_TOKEN. hanzo.app verifies whatever arrives against IAM's JWKS.
  function bearer() {
    if (window.HANZO_TOKEN) return String(window.HANZO_TOKEN);
    var m = document.cookie.match(/(?:^|;\s*)hanzo_iam_access_token=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    var t = bearer();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    opts.headers = headers;
    opts.credentials = 'include';
    return fetch(BASE + path, opts);
  }

  function selection() {
    try {
      var s = window.getSelection ? String(window.getSelection()) : '';
      return s.trim().slice(0, 2000);
    } catch (e) {
      return '';
    }
  }

  // ---- Session, replay & usage trace ("what the user was doing") -------------

  // The analytics/insights session id (@hanzo/event's localStorage `hz_session`
  // = {id,last}); fall back to the stable anon id, else a widget-local id. This
  // is the SAME id session-replay is keyed on, so the fix ties to the recording.
  function readJSON(store, k) {
    try {
      return JSON.parse(store.getItem(k) || 'null');
    } catch (e) {
      return null;
    }
  }
  function sessionId() {
    try {
      var ls = window.localStorage;
      var s = readJSON(ls, 'hz_session');
      if (s && s.id) return String(s.id);
      var anon = ls.getItem('hz_anon_id');
      if (anon) return String(anon);
      var own = ls.getItem('hz_edit_sid');
      if (!own) {
        own = 'edit-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        ls.setItem('hz_edit_sid', own);
      }
      return own;
    } catch (e) {
      return '';
    }
  }

  // ---- Session replay (rrweb → Hanzo Insights) ------------------------------
  //
  // The recorder is deliberately NOT bundled here. We load the one Insights
  // itself serves — `<insights>/static/recorder.js` — so the rrweb build that
  // RECORDS is by construction the build the player REPLAYS. Vendoring our own
  // copy would fork that pair and let it drift silently: a recording that the
  // player of the day cannot read is worse than no recording, because it looks
  // like it worked. Same reasoning as the route manifest — prefer the signal
  // derived from the same source as the consumer.
  //
  // Batches ride the documented recordings route (`POST /v1/s`) as the PostHog-
  // shaped `$snapshot` envelope insights-capture parses (its `RawRecording`), and
  // are keyed on the SAME session id the edit payload reports — so a filed fix and
  // its recording are one session and `replayRef`'s deep-link actually resolves.
  var REPLAY = {
    started: false,
    live: false,
    host: 'https://insights.hanzo.ai',
    key: '',
    win: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    buf: [],
    stop: null,
  };

  // Consent & opt-out. Replay is off for anyone who asked not to be measured, and
  // any page can veto it before this script runs (`window.__hanzoNoReplay = true`).
  function replayOptedOut() {
    try {
      if (window.__hanzoNoReplay) return true;
      var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
      if (dnt === '1' || dnt === 'yes') return true;
      if (window.localStorage && localStorage.getItem('hz_replay_off') === '1') return true;
    } catch (e) {
      /* storage blocked → fall through and record */
    }
    return false;
  }

  // Ship a batch. `closing` is the page-going-away path, which uses `keepalive`
  // so the request outlives the document — losing the tail of a session costs
  // exactly the part a bug report needs most.
  //
  // Deliberately NOT sendBeacon: capture 502s on a `text/plain` body, so the
  // envelope must be `application/json`, which is not a CORS-safelisted content
  // type and therefore preflights. `keepalive` fetch preflights cleanly (and the
  // preflight is cached for a day); a beacon's is far less certain. One path,
  // both cases.
  function flushReplay(closing) {
    if (!REPLAY.key || !REPLAY.buf.length) return;
    var batch = REPLAY.buf;
    REPLAY.buf = [];
    var sid = sessionId();
    var body = JSON.stringify([
      {
        event: '$snapshot',
        api_key: REPLAY.key,
        distinct_id: sid,
        properties: {
          $session_id: sid,
          $window_id: REPLAY.win,
          $snapshot_source: 'web',
          $lib: 'hanzo-edit',
          $snapshot_data: batch,
        },
      },
    ]);
    // credentials omitted: the recording is keyed by the publishable ingest key,
    // never by the viewer's Hanzo cookie.
    var opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      credentials: 'omit',
    };
    // `keepalive` caps the body at 64KB, so it is used ONLY when the page is
    // going away and a normal request would be cancelled. An over-size closing
    // batch is dropped rather than silently truncated — the 5s timer means at
    // most that much is ever at risk.
    if (closing) {
      if (body.length > 60000) return;
      opts.keepalive = true;
    }
    fetch(REPLAY.host + '/v1/s', opts).catch(function () {
      /* a dropped batch must never surface on the page being recorded */
    });
  }

  function loadScript(src, cb) {
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = cb;
    s.onerror = function () {
      /* recorder unavailable → the page is untouched, editing still works */
    };
    (document.head || document.documentElement).appendChild(s);
  }

  function startRecorder() {
    var rr = window.rrweb || (window.__InsightsExtensions__ && window.__InsightsExtensions__.rrweb);
    if (!rr || typeof rr.record !== 'function') return;
    REPLAY.live = true;
    REPLAY.stop = rr.record({
      emit: function (ev) {
        REPLAY.buf.push(ev);
        // Cap the hold when the key hasn't landed yet, so a page that never gets
        // config can't grow a buffer without bound.
        if (!REPLAY.key && REPLAY.buf.length > 400) REPLAY.buf.splice(0, REPLAY.buf.length - 400);
        else if (REPLAY.buf.length >= 100) flushReplay(false);
      },
      // Privacy is the DEFAULT, not a deployment option: every input value is
      // masked before it leaves the page, so a recording can never carry a
      // password, a card number, or anything else somebody typed. Opt an element
      // back in with `.hz-unmask`; hide any subtree entirely with `.hz-no-record`.
      maskAllInputs: true,
      maskTextClass: 'hz-mask',
      unmaskTextClass: 'hz-unmask',
      blockClass: 'hz-no-record',
      ignoreClass: 'hz-no-ignore',
      // Never record our own widget: replaying the editor on top of the page it
      // edits is noise, and its panel can hold the user's unsent prose.
      blockSelector: '[data-hanzo-edit]',
      collectFonts: false,
      recordCanvas: false,
      recordCrossOriginIframes: false,
      // A viewer scrubbing into the middle of a long session still needs a full
      // DOM to start from.
      checkoutEveryNms: 300000,
    });

    setInterval(function () {
      flushReplay(false);
    }, 5000);
    // `pagehide` fires where `unload` is unreliable (bfcache, mobile Safari).
    window.addEventListener('pagehide', function () {
      flushReplay(true);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushReplay(true);
    });
  }

  // Boot replay. Orthogonal to editing: it runs on every page carrying the tag,
  // including pages that map to no repo, because a recording is worth having
  // whether or not this page happens to be editable.
  function bootReplay() {
    if (REPLAY.started || replayOptedOut()) return;
    REPLAY.started = true;
    fetch(BASE + '/v1/edit/config', { credentials: 'omit' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (cfg) {
        var ins = (cfg && cfg.insights) || null;
        if (!ins || !ins.enabled || !ins.key) return;
        if (typeof ins.sampleRate === 'number' && ins.sampleRate < 1 && Math.random() > ins.sampleRate) return;
        REPLAY.key = String(ins.key);
        if (ins.host) REPLAY.host = String(ins.host).replace(/\/+$/, '');
        loadScript(REPLAY.host + '/static/recorder.js', startRecorder);
      })
      .catch(function () {
        /* no config → no recording; never a page error */
      });
  }

  // The replay reference attached to every submission. `recording` states whether
  // this session is actually being captured, so a reviewer knows whether the
  // deep-link will have anything behind it rather than guessing.
  function replayRef() {
    var sid = sessionId();
    if (!sid) return undefined;
    return {
      sessionId: sid,
      deepLink: REPLAY.host + '/replay/' + encodeURIComponent(sid),
      recording: REPLAY.live || undefined,
    };
  }

  // Recording starts here — BEFORE the repo gate below, because replay and
  // editing are independent capabilities that happen to share one tag. A page we
  // cannot map to a repo is still a page worth being able to watch back.
  bootReplay();

  // Past this line everything is the EDIT widget, which is meaningless without a
  // repo to open the change against.
  if (!REPO) return;

  // A short ring buffer of recent route events, captured from load. Degrades to
  // just the initial view when the page never client-navigates.
  var USAGE = [];
  function pushUsage(kind) {
    try {
      USAGE.push({ t: Date.now(), route: location.pathname + location.search, kind: kind });
      if (USAGE.length > 12) USAGE.shift();
    } catch (e) {
      /* ignore */
    }
  }
  pushUsage('load');
  (function hookHistory() {
    try {
      ['pushState', 'replaceState'].forEach(function (m) {
        var orig = history[m];
        if (typeof orig !== 'function') return;
        history[m] = function () {
          var r = orig.apply(this, arguments);
          pushUsage('nav');
          return r;
        };
      });
      window.addEventListener('popstate', function () {
        pushUsage('nav');
      });
    } catch (e) {
      /* history not patchable → single-entry trace, still fine */
    }
  })();
  function usageTrace() {
    if (!USAGE.length) return undefined;
    // Normalize timestamps to seconds-ago so the trace reads at a glance.
    var now = Date.now();
    return USAGE.slice(-8).map(function (e) {
      return { agoMs: now - e.t, route: e.route, kind: e.kind };
    });
  }

  // The element most recently interacted with — the thing the user was looking
  // at when they opened the widget (retargets to the shadow host for our own UI,
  // which we ignore).
  var lastEl = null;
  var host = document.createElement('div');
  host.setAttribute('data-hanzo-edit', '');
  // ONE NUMBER, AND IT IS ON AN ELEMENT THE PAGE OWNS.
  //
  // The fab and the panel inside the shadow root asked for 2147483000, which is
  // not a layer so much as a refusal to have one: nothing a page can write beats
  // it, and shadow content cannot be reached by a page's stylesheet either. So
  // the widget painted over a nav drawer's primary CTA on hanzo.ai — measured,
  // 43×32px of "Try Hanzo" unreachable at 390 — and the page had no way to say
  // otherwise.
  //
  // A positioned host with a z-index IS a stacking context, so everything in the
  // shadow tree is clamped to this one value, and this element is in the page's
  // own DOM: `[data-hanzo-edit] { z-index: 400 }` is now a rule that works. The
  // default stays maximal, because this script is embedded on pages it does not
  // own and most of them will never say anything. Only the page that HAS layers
  // knows where a guest belongs.
  host.style.position = 'fixed';
  host.style.zIndex = '2147483000';
  ['pointerdown', 'click', 'focusin'].forEach(function (t) {
    document.addEventListener(
      t,
      function (e) {
        if (e.target && e.target !== host) lastEl = e.target;
      },
      true,
    );
  });

  // ---- DOM breadcrumb (what was on screen) ----------------------------------

  function attr(el, n) {
    return el && el.getAttribute ? el.getAttribute(n) : null;
  }
  function nodeToken(el) {
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    var slot = attr(el, 'data-slot') || attr(el, 'data-component') || attr(el, 'data-testid');
    if (slot) return tag + '[' + slot + ']';
    if (el.id) return tag + '#' + el.id;
    var aria = attr(el, 'aria-label');
    if (aria) return tag + '[aria=' + aria.slice(0, 24) + ']';
    var role = attr(el, 'role');
    if (role) return tag + '[role=' + role + ']';
    var cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    return tag + (cls ? '.' + cls : '');
  }
  function breadcrumb() {
    var el = lastEl && lastEl.isConnected ? lastEl : document.querySelector('main') || document.body;
    var parts = [];
    var hints = [];
    var hops = 0;
    while (el && el.nodeType === 1 && hops < 6) {
      parts.unshift(nodeToken(el));
      var slot = attr(el, 'data-slot') || attr(el, 'data-component');
      if (slot) hints.push(slot);
      if (el === document.body) break;
      el = el.parentElement;
      hops++;
    }
    return { crumb: parts.join(' > ').slice(0, 400), hints: hints };
  }

  // A React `_debugSource` on/above the element in view → the exact source file
  // & line. Present only in DEV builds (the automatic JSX runtime strips it in
  // production), so this is a bonus when available, never a dependency.
  function firstPartyRel(fileName) {
    var m = String(fileName || '').match(/(?:^|\/)((?:app|components|lib|src)\/.+)$/);
    return m ? m[1] : null;
  }
  function fiberSource(el) {
    try {
      for (var k in el) {
        if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
          var f = el[k];
          var hops = 0;
          while (f && hops < 40) {
            if (f._debugSource && f._debugSource.fileName) {
              var rel = firstPartyRel(f._debugSource.fileName);
              if (rel) return { path: rel, line: f._debugSource.lineNumber };
            }
            f = f.return;
            hops++;
          }
        }
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  // ---- Route → source file resolution ---------------------------------------

  var MANIFEST; // cached promise
  function loadManifest() {
    if (MANIFEST) return MANIFEST;
    // The app being viewed serves its OWN manifest (same-origin), not hanzo.app's.
    MANIFEST = fetch(location.origin + '/edit-manifest.json', { credentials: 'omit' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (m) {
        // Only trust file paths that describe THIS repo.
        if (m && m.repo && REPO && m.repo !== REPO) return null;
        return m && Array.isArray(m.routes) ? m : null;
      })
      .catch(function () {
        return null;
      });
    return MANIFEST;
  }

  function pathParts(pathname) {
    return (pathname || '/').split(/[?#]/)[0].split('/').filter(Boolean);
  }
  // Match a manifest route's segments against the current path; return a
  // specificity score (static ≫ dynamic) or null when it doesn't match.
  function matchSpec(segs, parts) {
    var i = 0;
    var spec = 0;
    for (var si = 0; si < segs.length; si++) {
      var s = segs[si];
      if (s.k === 's') {
        if (parts[i] !== s.v) return null;
        i++;
        spec += 3;
      } else if (s.k === 'd') {
        if (i >= parts.length) return null;
        i++;
        spec += 1;
      } else if (s.k === 'c') {
        if (i >= parts.length) return null;
        i = parts.length;
      } else if (s.k === 'o') {
        i = parts.length;
      }
    }
    return i === parts.length ? spec : null;
  }
  function fromManifest(manifest, parts) {
    var best = null;
    var bestSpec = -1;
    for (var i = 0; i < manifest.routes.length; i++) {
      var r = manifest.routes[i];
      var spec = matchSpec(r.segments || [], parts);
      if (spec === null) continue;
      if (spec > bestSpec || (spec === bestSpec && (r.segments || []).length > (best.segments || []).length)) {
        best = r;
        bestSpec = spec;
      }
    }
    if (!best) return [];
    var out = [{ path: best.page, score: 0.9, why: 'route → page' }];
    (best.layouts || []).forEach(function (l, idx) {
      out.push({ path: l, score: 0.55 - idx * 0.05, why: 'route layout' });
    });
    return out;
  }
  function fromConvention(parts) {
    var dir = parts.length ? 'app/' + parts.join('/') : 'app';
    return [
      { path: dir + '/page.tsx', score: 0.4, why: 'convention guess' },
      { path: 'app/layout.tsx', score: 0.3, why: 'root layout' },
    ];
  }

  // Resolve a ranked, de-duplicated candidate list for the current view.
  function resolveCandidates() {
    var parts = pathParts(location.pathname);
    return loadManifest().then(function (manifest) {
      var out = [];
      if (PATH) out.push({ path: PATH, score: 1.0, why: 'declared (hanzo:path)' });
      var el = lastEl && lastEl.isConnected ? lastEl : null;
      var fib = el ? fiberSource(el) : null;
      if (fib) out.push({ path: fib.path, score: 0.95, why: 'react source (dev)' + (fib.line ? ':' + fib.line : '') });
      out = out.concat(manifest ? fromManifest(manifest, parts) : fromConvention(parts));
      if (manifest && out.filter(function (c) { return c.why.indexOf('route') === 0; }).length === 0) {
        // Manifest loaded but no route matched (e.g. an unlisted path) → still
        // give the convention guess something to chew on.
        out = out.concat(fromConvention(parts));
      }
      // De-dupe by path, keeping the highest score; sort desc; cap.
      var seen = {};
      var ranked = [];
      out
        .sort(function (a, b) {
          return b.score - a.score;
        })
        .forEach(function (c) {
          if (seen[c.path]) return;
          seen[c.path] = 1;
          ranked.push({ path: c.path, score: Math.round(c.score * 100) / 100, why: c.why });
        });
      return { candidates: ranked.slice(0, 6), version: manifest ? manifest.version : undefined };
    });
  }

  // ---- UI -------------------------------------------------------------------

  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  // This script is loaded `async` and is often placed in <head>, so it can run
  // before <body> is parsed — in which case `document.body` is null and the
  // append throws, aborting the IIFE and leaving the widget absent. The shadow
  // root is already attached and usable while detached, so build into it now
  // and mount once the body exists.
  // `hanzo:anchor` names an element the LAUNCHER should live inside — a toolbar
  // slot, a status bar — instead of floating at the viewport corner. The fixed
  // corner is right for a normal page and wrong wherever the product already
  // owns that pixel: hanzo.app's builder had to disable the widget outright
  // because the mark landed on top of the customer's preview, and a host page
  // cannot restyle `.fab` from outside a shadow root.
  //
  // Anchoring moves the HOST, so the panel still opens from the launcher and the
  // shadow boundary is untouched. A selector that matches nothing falls back to
  // the corner rather than losing the widget.
  // Put the launcher where `hanzo:anchor` points. Returns true once it lands in
  // the slot. The catch: that slot is usually rendered by the host app's
  // framework AFTER this script runs — hanzo.app's dock is a React node that does
  // not exist at script-load — so a ONE-SHOT querySelector always missed it and
  // the mark fell back to the fixed corner, full size, sitting on the builder
  // chrome. Observed exactly that, three times. So `place` is retryable and
  // `mount` watches for the slot instead of giving up on the first miss.
  function place() {
    var sel = meta('hanzo:anchor');
    if (!sel) return false;
    var slot = document.querySelector(sel);
    if (!slot) return false;
    if (host.parentNode !== slot) {
      host.setAttribute('data-hanzo-anchored', '');
      slot.appendChild(host);
    }
    return true;
  }
  // WATCH for the anchor slot to appear, then dock. The slot is rendered by the
  // host app's framework AFTER this script runs, and on a single-page app the
  // route that OWNS a slot is often reached by client navigation long after this
  // one evaluation — so a one-shot query, OR a short-lived observer that gives
  // up, both miss it and strand the mark at the corner, full size. (Measured on
  // hanzo.app/dev: the `#enso-dock` slot and its meta were both present, yet the
  // fab still floated 56px at the corner — the 10s observer had expired before
  // the builder mounted its dock.) Watch until it lands; disconnect the instant
  // it does. The slot node is stable once created, so there is nothing to
  // re-observe after a successful dock.
  var watching = false;
  function watchForSlot() {
    if (watching || place()) return;
    // Nothing to wait for unless a slot is actually named: a page with no
    // `hanzo:anchor` keeps the corner fallback and arms no observer.
    if (!meta('hanzo:anchor')) return;
    watching = true;
    try {
      var obs = new MutationObserver(function () {
        if (place()) { obs.disconnect(); watching = false; }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      // A floor, not a deadline: SPA navigation re-arms this (below), so the
      // timer only stops the watch on a page that renders no slot at all — it
      // never observes the DOM forever, and never gives up on a slow route.
      setTimeout(function () { obs.disconnect(); watching = false; }, 30000);
    } catch (e) {
      watching = false; /* no MutationObserver: the corner fallback stands */
    }
  }
  function mount() {
    if (!host.parentNode) document.body.appendChild(host); // corner, meanwhile
    watchForSlot();
  }
  if (document.body) {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }

  // Single-page apps swap the DOM under one script evaluation: the slot (and its
  // `hanzo:anchor` meta) belong to a route reached by pushState, AFTER mount()
  // already ran. Re-run placement on every route change so the launcher docks
  // the moment you arrive at the route that owns a slot, and falls back to the
  // corner on one that does not.
  function onRoute() {
    if (place()) return;
    if (host.parentNode !== document.body) document.body.appendChild(host);
    watchForSlot();
  }
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    if (typeof orig !== 'function') return;
    history[m] = function () {
      var r = orig.apply(this, arguments);
      try { onRoute(); } catch (e) { /* placement is best-effort */ }
      return r;
    };
  });
  window.addEventListener('popstate', onRoute);

  // The widget's whole palette, declared ONCE, in terms of the host page's
  // design tokens. Everything below reads these — no literal colour, font or
  // radius appears twice.
  //
  // Custom properties cross the shadow boundary: they are inherited, and `all`
  // does NOT reset them, so `:host{all:initial}` isolates this tree from the
  // page's own rules while `--background`, `--brand-accent`, `--font-geist-sans`
  // and the rest still arrive intact. (Measured on hanzo.app: --brand-accent
  // reads #8b5cf6 and --font-geist-sans reads "Geist" from inside this root.)
  // Adopting the page's stylesheets would be the wrong tool anyway — this script
  // is dropped into OTHER Hanzo apps cross-origin, where the only contract that
  // can be relied on is the token names.
  //
  // Every token carries the literal it replaces as its fallback, so a page that
  // ships no token layer at all renders exactly what it rendered before.
  var TOKENS =
    ':host{all:initial;' +
    '--hz-font:var(--font-geist-sans,var(--font-sans,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif));' +
    '--hz-mono:var(--font-geist-mono,var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace));' +
    // Purple is the ONE accent in this system. The widget used to draw a stray
    // #8ab4ff blue — links, the admin chip, the chosen candidate, the
    // inline-edit outline — which belongs to no palette here.
    '--hz-accent:var(--brand-accent,#8b5cf6);' +
    '--hz-accent-soft:var(--brand-accent-soft,rgba(139,92,246,.14));' +
    '--hz-panel:var(--card,#0e0e0e);' +
    '--hz-field:var(--muted,#171717);' +
    '--hz-text:var(--foreground,#f4f4f5);' +
    '--hz-dim:var(--muted-foreground,#9a9a9a);' +
    '--hz-line:var(--border,rgba(255,255,255,.14));' +
    '--hz-radius:var(--control-radius,8px);' +
    // The ensō lights in WHITE. It used to borrow the composer's
    // --hz-spectrum, which is prismatic BY DESIGN and owner-directed — but that
    // is a decision about the composer, the one surface allowed colour, and the
    // mark inherited it only because the token happened to be in scope. Two
    // different things wearing one value is not sharing, it is coupling: a mark
    // that is meant to be a monochrome circle cannot be, because someone else's
    // ring is iridescent.
    //
    // So the glow is its own token and its own value. Three white stops rather
    // than one, because the sweep still turns: a uniform ring would rotate
    // invisibly. Closes on the stop it opens with — a conic whose ends differ
    // shows a hard seam.
    '--hz-glow:var(--hz-mark-glow,rgba(255,255,255,.62),rgba(255,255,255,.22),' +
    'rgba(255,255,255,.62));' +
    '}';

  var css =
    TOKENS +
    '*{box-sizing:border-box;font-family:var(--hz-font)}' +
    // The trigger is the ensō mark alone — one affordance for every AI action
    // on the page (ask, edit, suggest). It lights rather than grows, so it never
    // reflows content or competes with the page's own controls.
    //
    // The mark IS the button: no disc, no plate, no shadow. It is the canonical
    // Enso brush ring (see ENSO below) — one thick weight, monochrome and quiet
    // until touched, then the SAME ring lights white over a soft, slowly-turning
    // halo. One ring, one weight, in both states — no hairline, no handover to a
    // second ring.
    //
    // --mark is the DRAWN diameter and the only size to change; the halo sizes
    // itself from it.
    //
    // The drawn ring and the hit box are two different numbers, deliberately.
    // The mark is 22px so the corner stays quiet on someone else's page — this
    // script is embedded on pages it does not own, and a 34px ring in a 56px box
    // read as a second product's button parked over theirs. The BOX stays 44,
    // the touch floor: a thumb is about as wide as it is tall, and shrinking the
    // target with the glyph is how an affordance becomes decorative. Nothing
    // catches that regression either — the fab lives in a shadow root, so the
    // deploy gate's querySelectorAll cannot see it.
    ':host([data-hanzo-anchored]) .fab{--mark:18px;position:relative;right:auto;bottom:auto;' +
    'width:20px;height:20px}' +
    '.fab{--mark:22px;position:fixed;right:16px;bottom:16px;z-index:2147483000;display:inline-flex;' +
    'align-items:center;justify-content:center;width:44px;height:44px;padding:0;' +
    'border-radius:999px;border:0;background:transparent;color:var(--hz-text);' +
    'cursor:pointer;line-height:0;-webkit-tap-highlight-color:transparent;' +
    'transition:transform .2s ease}' +
    // `position:relative` puts the ring in the same paint phase as the halo, so
    // tree order stacks the ::before halo UNDER the SVG ring. Without it the SVG
    // paints below every positioned box and the halo covers the mark.
    '.fab svg{width:var(--mark);height:var(--mark);display:block;overflow:visible;position:relative;' +
    'color:var(--hz-dim);transition:color .25s ease}' +
    // The ring stays drawn on hover and lights white; it is never hidden, so the
    // thick ensō is what you see in both states.
    '.fab:hover svg,.fab:focus-visible svg{color:var(--hz-text)}' +
    // One conic sweep, blurred into a soft halo BEHIND the ring — absent at
    // rest, lit on touch and slowly turning. The ring itself is the SVG ensō
    // above; the halo only glows around it.
    '.fab::before{content:"";position:absolute;left:50%;top:50%;' +
    'width:calc(var(--mark) * .9);height:calc(var(--mark) * .9);border-radius:999px;' +
    'background:conic-gradient(var(--hz-glow));transform:translate(-50%,-50%);' +
    'opacity:0;transition:opacity .25s ease;pointer-events:none;' +
    // No `saturate()` — there is no hue left to saturate, and pushing it only
    // hardened the blur's edge.
    'filter:blur(calc(var(--mark) * .22))}' +
    '.fab:hover::before,.fab:focus-visible::before,.fab:active::before{opacity:.7}' +
    '.fab:hover{transform:scale(1.05)}' +
    '.fab:focus-visible{outline:none}' +
    '.fab:active{transform:scale(.96)}' +
    // The sweep turns only while the mark is held, and only where motion is
    // welcome. Everywhere else it holds a still frame — lit, not moving.
    '@media (prefers-reduced-motion:no-preference){' +
    '.fab:hover::before,.fab:focus-visible::before' +
    '{animation:hzPrism 6s linear infinite}}' +
    '@keyframes hzPrism{from{transform:translate(-50%,-50%) rotate(0)}' +
    'to{transform:translate(-50%,-50%) rotate(360deg)}}' +
    '@media (prefers-reduced-motion:reduce){.fab{transition:none}' +
    '.fab:hover,.fab:active{transform:none}}' +
    '.panel{position:fixed;right:16px;bottom:16px;z-index:2147483001;width:360px;max-width:92vw;' +
    'background:var(--hz-panel);color:var(--hz-text);border:1px solid var(--hz-line);border-radius:14px;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.5);overflow:hidden;display:none}' +
    '.panel.open{display:block}' +
    '.hd{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--hz-line)}' +
    '.hd b{font-size:13px;font-weight:600}' +
    '.hd .sub{font-size:11px;color:var(--hz-dim);margin-top:2px}' +
    '.x{background:none;border:none;color:var(--hz-dim);cursor:pointer;font-size:18px;line-height:1;padding:2px 4px}' +
    '.x:hover{color:var(--hz-text)}' +
    '.bd{padding:14px}' +
    'textarea{width:100%;min-height:84px;resize:vertical;background:var(--hz-field);color:var(--hz-text);' +
    'border:1px solid var(--hz-line);border-radius:var(--hz-radius);padding:9px 10px;font-size:13px;outline:none}' +
    'textarea:focus{border-color:var(--hz-accent)}' +
    'input.path{width:100%;margin-top:8px;background:var(--hz-field);color:var(--hz-text);border:1px solid var(--hz-line);' +
    'border-radius:var(--hz-radius);padding:8px 10px;font-size:12px;font-family:var(--hz-mono);outline:none}' +
    'input.path:focus{border-color:var(--hz-accent)}' +
    '.cands{margin-top:7px;display:flex;flex-wrap:wrap;gap:6px}' +
    '.cand{font-family:var(--hz-mono);font-size:11px;color:var(--hz-dim);background:var(--hz-field);' +
    'border:1px solid var(--hz-line);border-radius:6px;padding:3px 7px;cursor:pointer;max-width:100%;overflow:hidden;' +
    'text-overflow:ellipsis;white-space:nowrap}' +
    '.cand:hover{border-color:var(--hz-accent);color:var(--hz-text)}' +
    '.cand.on{border-color:var(--hz-accent);background:var(--hz-accent-soft);color:var(--hz-text)}' +
    '.ctx{font-size:11px;color:var(--hz-dim);margin-top:9px;line-height:1.5;word-break:break-word}' +
    '.row{display:flex;gap:8px;margin-top:12px;align-items:center}' +
    // Primary action stays WHITE — purple is links/active/focus only, never the
    // primary button (the v2 monochrome rule).
    '.btn{flex:1;padding:10px 12px;border-radius:var(--hz-radius);border:none;background:#fff;color:#000;' +
    'font-size:13px;font-weight:600;cursor:pointer}' +
    '.btn:hover{background:#e8e8e8}' +
    '.btn:disabled{opacity:.55;cursor:default}' +
    '.btn.sec{flex:0 0 auto;background:transparent;color:var(--hz-dim);border:1px solid var(--hz-line);font-weight:500}' +
    '.btn.sec:hover{background:var(--hz-field);color:var(--hz-text)}' +
    '.note{font-size:11px;color:var(--hz-dim);margin-top:9px}' +
    // Help and preferences share the panel with the form, under one rule each.
    // A reader in the corner of a page wants a way out and a way to make it
    // readable; two more bubbles would ask them to guess which held which.
    '.sect{border-top:1px solid var(--hz-line);margin-top:12px;padding-top:10px}' +
    '.sect h3{font-size:11px;font-weight:500;color:var(--hz-dim);margin:0 0 4px}' +
    '.hlink{display:flex;align-items:center;justify-content:flex-start;gap:6px;' +
    'min-height:32px;font-size:13px;color:var(--hz-text);text-decoration:none}' +
    '.hlink svg{opacity:.5}.hlink:hover svg{opacity:.9}' +
    '.prow{display:flex;align-items:center;justify-content:space-between;gap:10px;' +
    'min-height:34px;font-size:13px}' +
    '.trk{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:999px;' +
    'background:var(--hz-soft,rgba(255,255,255,.06))}' +
    '.opt{height:22px;padding:0 8px;border:0;border-radius:999px;background:transparent;' +
    'color:var(--hz-dim);font-size:11px;font-family:var(--hz-font);cursor:pointer}' +
    '.opt[data-on]{background:rgba(255,255,255,.10);color:var(--hz-text)}' +
    '.link{color:var(--hz-accent);text-decoration:none}' +
    '.link:hover{text-decoration:underline}' +
    '.msg{font-size:13px;line-height:1.5;word-break:break-word}' +
    '.msg.err{color:#ff9d9d}' +
    // Admin review: the proposed-change diff before a live commit. Added/removed
    // lines stay green/red — that is semantics, not chrome.
    '.diff{margin-top:10px;max-height:38vh;overflow:auto;background:var(--hz-field);border:1px solid var(--hz-line);' +
    'border-radius:var(--hz-radius);padding:8px 10px;font-family:var(--hz-mono);font-size:11px;' +
    'line-height:1.45;white-space:pre;tab-size:2}' +
    '.diff .a{color:#7ee787;background:rgba(46,160,67,.12);display:block}' +
    '.diff .d{color:#ff9d9d;background:rgba(248,81,73,.12);display:block}' +
    '.diff .c{color:var(--hz-dim);display:block}' +
    '.warn{font-size:11px;color:#e3b341;margin-top:9px}' +
    'code{font-family:var(--hz-mono);font-size:11px;background:var(--hz-field);' +
    'border:1px solid var(--hz-line);border-radius:5px;padding:1px 5px}' +
    // Admin affordances: the "admin" chip + the ghost inline-edit button.
    '.adm{color:var(--hz-accent);font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:10px}' +
    '.btn.ghost{width:100%;margin-top:8px;background:transparent;color:var(--hz-dim);border:1px dashed var(--hz-line);' +
    'font-weight:500;padding:9px 12px;border-radius:var(--hz-radius);cursor:pointer}' +
    '.btn.ghost:hover{border-color:var(--hz-accent);color:var(--hz-text)}' +
    '.spin{display:inline-block;width:13px;height:13px;border:2px solid var(--hz-line);border-top-color:var(--hz-text);' +
    'border-radius:50%;animation:hz 0.7s linear infinite;vertical-align:-2px;margin-right:6px}' +
    '@keyframes hz{to{transform:rotate(360deg)}}' +
    // Mobile: the panel becomes a bottom-sheet (full-width, rounded top, safe-area
    // inset) with larger touch targets; the FAB tucks above the home indicator.
    '@media (max-width:560px){' +
    '.fab{right:12px;bottom:calc(12px + env(safe-area-inset-bottom))}' +
    '.panel{left:0;right:0;bottom:0;top:auto;width:100%;max-width:100%;border-radius:16px 16px 0 0;' +
    'border-left:none;border-right:none;border-bottom:none;max-height:88vh;overflow-y:auto;' +
    'padding-bottom:env(safe-area-inset-bottom)}' +
    '.hd{padding:14px 16px}.bd{padding:16px}' +
    'textarea{min-height:96px;font-size:16px}' + // 16px ⇒ iOS never zooms on focus
    'input.path{font-size:14px;padding:11px 12px}' +
    '.btn{padding:14px 14px;font-size:15px}.btn.sec{padding:14px 16px}.btn.ghost{padding:13px 14px}' +
    '.cand{padding:6px 10px;font-size:12px}' +
    '.x{font-size:24px;padding:6px 10px}' +
    '}';

  var style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);

  var PENCIL =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

  // The ensō — Hanzo's AI mark, the CANONICAL glyph: a closed brush ring, r=8.88
  // on a 24 viewBox, stroke 2.64, round caps — byte-identical to the one
  // @hanzo/logo carries and model-icon.tsx / the hanzo.ai models mark draw, so
  // the ensō is one thick weight everywhere. The stroke scales with the mark
  // (no `vector-effect`), like every other place this glyph is drawn: at the
  // 18px dock size it lands ~2px, a bold little brush ring — the weight the mark
  // is meant to have, not the thin hairline it briefly wore.
  var ENSO =
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
    '<circle cx="12" cy="12" r="8.88" fill="none" stroke="currentColor" stroke-width="2.64" stroke-linecap="round"/></svg>';

  var fab = document.createElement('button');
  fab.className = 'fab';
  fab.setAttribute('aria-label', 'Ask or edit this page');
  fab.setAttribute('title', 'Ask or edit this page');
  fab.innerHTML = ENSO;
  root.appendChild(fab);

  var panel = document.createElement('div');
  panel.className = 'panel';
  root.appendChild(panel);

  var ME = {
    authenticated: false,
    isAdmin: false,
    hasCredits: false,
    balance: null,
    // WHY the balance is what it is. `hasCredits:false` alone cannot tell a real
    // zero from a balance we failed to read, and those need opposite remedies.
    balanceState: 'anonymous',
  };

  // Resolved-once-per-open view context.
  var CTX = { candidates: [], version: undefined, chosen: '' };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Decide the primary CTA from identity + credits. Admin's primary is the
  // "goes live" direct commit; the server re-checks sudo for that mode,
  // so this only shapes the UI.
  function cta() {
    if (ME.isAdmin)
      return {
        label: 'Apply live',
        action: 'edit',
        mode: 'direct',
        admin: true,
        note: 'Commits directly to ' + BRANCH + ' — goes live.',
      };
    if (ME.authenticated && ME.hasCredits) return { label: 'Submit fix', action: 'edit', note: 'Uses your credits.' };
    // Not funded — but WHY decides the remedy, and only 'ok' is a real zero.
    // `/v1/me` and `/v1/edit` both already keep these apart (a refused balance is
    // a 401 there, an unreadable one a 503, and 402 is reserved for a balance we
    // READ and found empty). Reading `hasCredits` alone put them back together
    // and billed the customer for our failure: a funded account whose token had
    // gone stale was told to top up.
    if (ME.authenticated && ME.balanceState === 'noauth')
      return { label: 'Suggest a fix', action: 'suggest', stale: true };
    if (ME.authenticated && ME.balanceState === 'unavailable')
      return { label: 'Suggest a fix', action: 'suggest', down: true };
    if (ME.authenticated) return { label: 'Suggest a fix', action: 'suggest', top: true };
    // Anonymous: /v1/suggest requires a name now, so offering the form would
    // collect a paragraph and answer 401. Say what is needed BEFORE it is typed.
    return { label: 'Sign in to suggest', action: 'login', login: true };
  }

  // ---- Help and preferences -------------------------------------------------
  //
  // The knobs are @hanzo/design's, and so is the transform that produces them:
  // `vars(pref)` is imported from the vendored `preference.js` rather than
  // restated here. That module is the one place density 'compact' means 0.85
  // and a face resolves to var(--font-serif); a widget with its own copy is the
  // drift @hanzo/design's docblock already records once.
  //
  // The knobs land on the HOST page's <html>, not in this shadow root — the
  // reader is adjusting the page they are reading, and the root is where every
  // ramp reads them from.
  var PREF_KEY = 'hanzo.appearance'; // @hanzo/appearance exports this as KEY
  var VARS = null; // resolved transform, or null until it arrives

  var PREF_ROWS = [
    { axis: 'type', label: 'Text size', opts: [['S', 0.9], ['M', 1], ['L', 1.15], ['XL', 1.3]] },
    { axis: 'ratio', label: 'Scale', opts: [['Flat', 0.85], ['Default', 1], ['Airy', 1.2]] },
    { axis: 'density', label: 'Spacing', opts: [['Tight', 'compact'], ['Default', 'default'], ['Roomy', 'comfortable']] },
    { axis: 'font', label: 'Font', opts: [['Sans', 'default'], ['System', 'system'], ['Serif', 'serif'], ['Mono', 'mono']] },
    { axis: 'width', label: 'Width', opts: [['Narrow', 'narrow'], ['Default', 'default'], ['Wide', 'wide']] },
  ];

  // Every property vars() can emit. The removal list has to be exhaustive or
  // clearing an axis leaves its last value stuck on the page.
  var PREF_KNOBS = ['--type-scale', '--type-ratio', '--density', '--font-sans',
    '--container-max', '--container-prose', '--container-wide', '--primary', '--accent'];

  function readPref() {
    try {
      var raw = window.localStorage.getItem(PREF_KEY);
      var p = raw ? JSON.parse(raw) : {};
      return p && typeof p === 'object' ? p : {};
    } catch (e) {
      return {};
    }
  }

  function applyPref(p) {
    if (!VARS) return;
    var out = VARS(p);
    var st = document.documentElement.style;
    for (var i = 0; i < PREF_KNOBS.length; i++) {
      var k = PREF_KNOBS[i];
      // An axis nobody set is REMOVED, never written as a neutral: an inline
      // property outranks every stylesheet, so a neutral 1 would silently
      // override a brand that published its own scale.
      if (out[k]) st.setProperty(k, out[k]);
      else st.removeProperty(k);
    }
  }

  function setPref(axis, value) {
    var p = readPref();
    p[axis] = value;
    try {
      window.localStorage.setItem(PREF_KEY, JSON.stringify(p));
    } catch (e) {
      /* storage can be blocked; the page still updates for this visit */
    }
    applyPref(p);
    return p;
  }

  function helpHtml() {
    var out = '<a class="hlink" href="' + BASE + '/docs" target="_blank" rel="noopener">Docs' + OUTLINK + '</a>';
    out += '<a class="hlink" href="' + BASE + '/support" target="_blank" rel="noopener">Get help' + OUTLINK + '</a>';
    out += '<a class="hlink" href="' + BASE + '/contact" target="_blank" rel="noopener">Contact us' + OUTLINK + '</a>';
    return '<div class="sect"><h3>Help</h3>' + out + '</div>';
  }

  var OUTLINK =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 17L17 7M8 7h9v9"/></svg>';

  function prefsHtml() {
    // Nothing is offered until the transform is here — a control that cannot
    // apply its own value is worse than one that is not shown yet.
    if (!VARS) return '';
    var p = readPref();
    var rows = PREF_ROWS.map(function (r) {
      var cur = p[r.axis];
      var opts = r.opts
        .map(function (o) {
          var on = cur === undefined ? o[1] === 1 || o[1] === 'default' : cur === o[1];
          return (
            '<button type="button" class="opt"' + (on ? ' data-on' : '') +
            ' data-axis="' + r.axis + '" data-val="' + esc(String(o[1])) + '">' + esc(o[0]) + '</button>'
          );
        })
        .join('');
      return '<div class="prow"><span>' + esc(r.label) + '</span><span class="trk">' + opts + '</span></div>';
    }).join('');
    return '<div class="sect"><h3>Preferences</h3>' + rows + '</div>';
  }

  function wirePrefs(root) {
    var btns = root.querySelectorAll('.opt[data-axis]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].onclick = function () {
        var axis = this.getAttribute('data-axis');
        var raw = this.getAttribute('data-val');
        // A numeric axis stores a number; a named one stores its word.
        var val = axis === 'type' || axis === 'ratio' ? parseFloat(raw) : raw;
        setPref(axis, val);
        renderForm();
      };
    }
  }

  function renderForm() {
    var c = cta();
    var showPath = c.action === 'edit';
    var chosen = CTX.chosen || (CTX.candidates[0] && CTX.candidates[0].path) || PATH || '';
    var candChips = CTX.candidates.length
      ? '<div class="cands">' +
        CTX.candidates
          .map(function (cand) {
            return (
              '<button type="button" class="cand' +
              (cand.path === chosen ? ' on' : '') +
              '" data-path="' +
              esc(cand.path) +
              '" title="' +
              esc(cand.why) +
              '">' +
              esc(cand.path) +
              '</button>'
            );
          })
          .join('') +
        '</div>'
      : '';
    panel.innerHTML =
      '<div class="hd"><div><b>' +
      (c.admin ? 'Command this page' : 'Improve this page') +
      '</b><div class="sub">' +
      esc(REPO) +
      (BRANCH ? ' · ' + esc(BRANCH) : '') +
      (c.admin ? ' · <span class="adm">admin</span>' : '') +
      '</div></div><button class="x" aria-label="Close">×</button></div>' +
      '<div class="bd">' +
      '<textarea placeholder="' +
      (c.admin
        ? 'Command — e.g. “change the hero headline to Ship faster”'
        : 'Describe the change or fix…') +
      '"></textarea>' +
      (showPath
        ? '<input class="path" placeholder="auto-detected file — edit to override" value="' + esc(chosen) + '"/>' + candChips
        : '') +
      (c.admin
        ? '<button type="button" class="btn ghost" data-inline>✎ Edit text directly on the page</button>'
        : '') +
      '<div class="row">' +
      '<button class="btn primary">' +
      esc(c.label) +
      '</button>' +
      (c.admin
        ? '<button class="btn sec" data-pr>Open PR</button>'
        : c.action === 'edit'
          ? '<button class="btn sec" data-suggest>Suggest</button>'
          : '') +
      '</div>' +
      (c.note ? '<div class="note">' + esc(c.note) + '</div>' : '') +
      (c.top
        ? '<div class="note"><a class="link" href="' + BASE + '/billing" target="_blank" rel="noopener">Top up</a> to open a PR directly.</div>'
        : '') +
      (c.stale
        ? '<div class="note">We couldn’t read your balance — your session expired. <a class="link" href="' +
          BASE +
          '/login" target="_blank" rel="noopener">Sign in again</a> to open a PR.</div>'
        : '') +
      (c.down
        ? '<div class="note">Billing is unreachable, which is on us — your credits are untouched. Try again shortly.</div>'
        : '') +
      (c.login
        ? '<div class="note"><a class="link" href="' + BASE + '/login" target="_blank" rel="noopener">Log in</a> to open a PR directly.</div>'
        : '') +
      '<div class="ctx">Context attached: <b>' +
      esc(location.pathname) +
      '</b>' +
      (CTX.candidates.length ? ' · ' + CTX.candidates.length + ' candidate file' + (CTX.candidates.length > 1 ? 's' : '') : '') +
      (CTX.version ? ' · v' + esc(CTX.version) : '') +
      '</div>' +
      helpHtml() +
      prefsHtml() +
      '</div>';

    wirePrefs(panel);
    panel.querySelector('.x').onclick = close;
    var ta = panel.querySelector('textarea');
    var pathInput = panel.querySelector('.path');
    ta.focus();

    // Candidate chips set the path field (and remember the choice).
    Array.prototype.forEach.call(panel.querySelectorAll('.cand'), function (chip) {
      chip.onclick = function () {
        CTX.chosen = chip.getAttribute('data-path');
        if (pathInput) pathInput.value = CTX.chosen;
        Array.prototype.forEach.call(panel.querySelectorAll('.cand'), function (o) {
          o.classList.toggle('on', o === chip);
        });
      };
    });
    if (pathInput)
      pathInput.oninput = function () {
        CTX.chosen = pathInput.value;
      };

    var pathOf = function () {
      return pathInput ? pathInput.value : chosen;
    };
    panel.querySelector('.btn.primary').onclick = function () {
      submit(c.action, ta.value, pathOf(), c.mode);
    };
    var sug = panel.querySelector('[data-suggest]');
    if (sug)
      sug.onclick = function () {
        submit('suggest', ta.value, pathOf());
      };
    // Admin: "Open PR" runs the same agent edit but as a PR (mode omitted).
    var pr = panel.querySelector('[data-pr]');
    if (pr)
      pr.onclick = function () {
        submit('edit', ta.value, pathOf(), 'pr');
      };
    // Admin: inline click-to-edit the tracked element → a precise instruction.
    var inl = panel.querySelector('[data-inline]');
    if (inl)
      inl.onclick = function () {
        inlineEdit(pathOf());
      };
  }

  function showMessage(html, isErr) {
    panel.innerHTML =
      '<div class="hd"><div><b>Hanzo Edit</b></div><button class="x" aria-label="Close">×</button></div>' +
      '<div class="bd"><div class="msg' +
      (isErr ? ' err' : '') +
      '">' +
      html +
      '</div>' +
      '<div class="row"><button class="btn primary" data-again>New suggestion</button></div></div>';
    panel.querySelector('.x').onclick = close;
    panel.querySelector('[data-again]').onclick = renderForm;
  }

  function busy(label) {
    var b = panel.querySelector('.btn.primary');
    if (b) {
      b.disabled = true;
      b.innerHTML = '<span class="spin"></span>' + esc(label);
    }
    var s = panel.querySelector('[data-suggest]');
    if (s) s.disabled = true;
  }

  // The rich context every submission carries — enough for an agent or dev to
  // review and finish the fix.
  function contextTrace() {
    var bc = breadcrumb();
    return {
      route: location.pathname,
      candidateFiles: CTX.candidates,
      domBreadcrumb: bc.crumb || undefined,
      appVersion: CTX.version || meta('hanzo:version') || undefined,
      sessionId: sessionId() || undefined,
      replayRef: replayRef(),
      usageTrace: usageTrace(),
    };
  }

  // The shared payload skeleton every submission carries.
  function editPayload(effectivePath) {
    var trace = contextTrace();
    return {
      repo: REPO,
      provider: PROVIDER,
      path: effectivePath || undefined,
      branch: BRANCH,
      url: location.href,
      key: KEY || undefined,
      context: selection() || undefined,
      route: trace.route,
      candidateFiles: trace.candidateFiles && trace.candidateFiles.length ? trace.candidateFiles : undefined,
      domBreadcrumb: trace.domBreadcrumb,
      appVersion: trace.appVersion,
      sessionId: trace.sessionId,
      replayRef: trace.replayRef,
      usageTrace: trace.usageTrace,
    };
  }

  function submit(action, text, path, mode) {
    // Signed out: the door refuses an unnamed suggestion, so the primary control
    // opens the sign-in rather than collecting a paragraph to throw away. The
    // return brings the reader back to the page they were reading.
    if (action === 'login') {
      window.open(BASE + '/login?return=' + encodeURIComponent(location.href), '_blank', 'noopener');
      return;
    }
    text = (text || '').trim();
    if (!text) return;
    var effectivePath = (path || '').trim() || (CTX.candidates[0] && CTX.candidates[0].path) || PATH || '';

    if (action === 'suggest') {
      var payload = editPayload(effectivePath);
      payload.suggestion = text;
      busy('Sending…');
      api('/v1/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(readJson)
        .then(function (r) {
          if (r.data && r.data.ok && r.data.issueUrl) {
            showMessage(
              'Suggestion filed: <a class="link" href="' +
                esc(r.data.issueUrl) +
                '" target="_blank" rel="noopener">view issue ↗</a>',
            );
          } else if (r.data && r.data.ok) {
            showMessage('Thanks — your suggestion was received.');
          } else {
            showMessage(esc((r.data && r.data.error) || 'Could not send the suggestion.'), true);
          }
        })
        .catch(function () {
          showMessage('Network error — please try again.', true);
        });
      return;
    }

    postEdit(text, effectivePath, mode);
  }

  // Timestamp of the in-flight edit, so a direct commit can report ~elapsed
  // seconds ("live in ~Ns").
  var editT0 = 0;

  // Run the agent edit: mode 'direct' asks the server to commit straight to the
  // default branch (honored ONLY for an admin — the server re-checks); anything
  // else is the fork→PR flow. All privilege lives server-side; mode is a hint.
  // The in-flight direct edit, remembered so the CONFIRM phase can resend the
  // same instruction + path alongside the admin-approved bytes.
  var lastEdit = null;

  function postEdit(instruction, path, mode) {
    instruction = (instruction || '').trim();
    if (!instruction) return;
    var effectivePath = (path || '').trim() || (CTX.candidates[0] && CTX.candidates[0].path) || PATH || '';
    if (!effectivePath) {
      showMessage('Couldn’t detect a source file for this view — use <b>Suggest</b> instead.', true);
      return;
    }
    lastEdit = { instruction: instruction, path: effectivePath };
    var payload = editPayload(effectivePath);
    payload.instruction = instruction;
    if (mode) payload.mode = mode;
    // Direct mode returns a PROPOSAL first (nothing commits until the admin
    // confirms), so the button reads "Reviewing…" not "Applying…".
    busy(mode === 'direct' ? 'Reviewing…' : 'Opening PR…');
    editT0 = Date.now();
    api('/v1/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(readJson)
      .then(renderEditResult)
      .catch(function () {
        showMessage('Network error — please try again.', true);
      });
  }

  // CONFIRM phase: the admin has reviewed the proposal; commit the EXACT approved
  // bytes straight to the default branch, optimistic-locked to the reviewed sha.
  function confirmEdit(proposed, baseSha) {
    if (!lastEdit) return;
    var payload = editPayload(lastEdit.path);
    payload.instruction = lastEdit.instruction;
    payload.mode = 'direct';
    payload.reviewed = proposed;
    payload.baseSha = baseSha;
    showMessageBusy('Applying…');
    editT0 = Date.now();
    api('/v1/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(readJson)
      .then(renderEditResult)
      .catch(function () {
        showMessage('Network error — please try again.', true);
      });
  }

  // Render a diff string ("+ "/"- "/"  " line prefixes) as colored lines.
  function renderDiff(diff) {
    return diff
      .split('\n')
      .map(function (ln) {
        var k = ln.charAt(0) === '+' ? 'a' : ln.charAt(0) === '-' ? 'd' : 'c';
        return '<span class="' + k + '">' + esc(ln) + '</span>';
      })
      .join('');
  }

  // The admin review gate: show the proposed change (diff, or full contents when
  // the file is too large to diff) and require an explicit "Apply live" before
  // anything reaches the default branch.
  function renderPreview(d) {
    var body = d.diff
      ? '<div class="diff">' + renderDiff(d.diff) + '</div>'
      : '<div class="warn">Large file — review the full proposed contents below.</div>' +
        '<div class="diff">' + esc(String(d.proposed || '')) + '</div>';
    panel.innerHTML =
      '<div class="hd"><div><b>Review before it goes live</b><div class="sub">' +
      esc(d.path || (lastEdit && lastEdit.path) || '') +
      ' · ' + esc(d.branch || BRANCH) +
      ' · <span class="adm">admin</span></div></div><button class="x" aria-label="Close">×</button></div>' +
      '<div class="bd">' +
      body +
      '<div class="warn">This commits directly to ' + esc(d.branch || BRANCH) + ' and goes live to all visitors.</div>' +
      '<div class="row">' +
      '<button class="btn primary" data-apply>Apply live</button>' +
      '<button class="btn sec" data-cancel>Cancel</button>' +
      '</div></div>';
    panel.querySelector('.x').onclick = close;
    panel.querySelector('[data-cancel]').onclick = renderForm;
    panel.querySelector('[data-apply]').onclick = function () {
      var b = panel.querySelector('[data-apply]');
      if (b) {
        b.disabled = true;
        b.innerHTML = '<span class="spin"></span>Applying…';
      }
      confirmEdit(d.proposed, d.baseSha);
    };
  }

  function renderEditResult(r) {
    var d = r.data || {};
    if (d.ok && d.preview) {
      renderPreview(d);
    } else if (d.ok && d.committed) {
      var secs = Math.max(1, Math.round((Date.now() - editT0) / 1000));
      var commit = d.commitUrl
        ? ' <a class="link" href="' + esc(d.commitUrl) + '" target="_blank" rel="noopener">view commit ↗</a>'
        : d.commitSha
          ? ' <code>' + esc(String(d.commitSha).slice(0, 7)) + '</code>'
          : '';
      var live = d.liveUrl
        ? '<div class="note">Live at <a class="link" href="' +
          esc(d.liveUrl) +
          '" target="_blank" rel="noopener">' +
          esc(d.liveUrl.replace(/^https?:\/\//, '')) +
          '</a> — refresh to see the change.</div>'
        : '';
      showMessage('Committed to <b>' + esc(d.branch || BRANCH) + '</b> — live in ~' + secs + 's.' + commit + live);
    } else if (d.ok && d.prUrl) {
      showMessage(
        (d.forked ? 'Forked and opened' : 'Opened') +
          ' a pull request: <a class="link" href="' +
          esc(d.prUrl) +
          '" target="_blank" rel="noopener">' +
          esc(d.prUrl.replace(/^https?:\/\//, '')) +
          ' ↗</a>',
      );
    } else if (r.status === 401 || d.openLogin) {
      showMessage('<a class="link" href="' + BASE + '/login" target="_blank" rel="noopener">Log in</a> to open a PR.', true);
    } else if (r.status === 402 || d.needsCredits) {
      showMessage(
        'You’re out of credits. <a class="link" href="' + BASE + '/billing" target="_blank" rel="noopener">Top up</a> to open a PR.',
        true,
      );
    } else if (d.connect) {
      showMessage(
        'Connect ' +
          esc(PROVIDER) +
          ' in your <a class="link" href="' +
          BASE +
          '/connectors" target="_blank" rel="noopener">Hanzo account</a> to open a PR.',
        true,
      );
    } else {
      showMessage(esc(d.error || 'The edit failed.'), true);
    }
  }

  // What "this is the element you are editing" looks like on someone else's
  // page. A hard 2px box in a colour from no palette read as damage; this is the
  // accent at one hairline, held off the text by an offset, with a soft wash
  // behind it — the same shape a focus ring takes everywhere else in the system.
  //
  // These land on a PAGE element, outside the shadow root, so they read the
  // page's own tokens directly (the widget's --hz-* aliases live on :host and do
  // not reach here) and fall back to the literals when a page ships no tokens.
  function highlight(el) {
    el.style.outline = '1px solid var(--brand-accent, #8b5cf6)';
    el.style.outlineOffset = '2px';
    el.style.boxShadow = '0 0 0 4px var(--brand-accent-soft, rgba(139,92,246,.14))';
    el.style.borderRadius = el.style.borderRadius || '2px';
  }

  // Inline click-to-edit (admin): make the tracked element's text editable in
  // place; on commit (Enter / blur) turn the before→after diff into a precise
  // instruction and apply it live. Escape cancels + restores. Text-only — never
  // touches structure or attributes.
  var inlineActive = false;
  function inlineEdit(path) {
    if (inlineActive) return;
    var el = lastEl && lastEl.isConnected ? lastEl : null;
    // Climb to the nearest element that actually carries text (skip empty wrappers).
    while (el && el !== document.body && !(el.innerText || el.textContent || '').trim()) el = el.parentElement;
    if (!el || el === document.body) {
      showMessage('Click the text you want to change first, then reopen and choose “Edit text directly”.', true);
      return;
    }
    inlineActive = true;
    var before = (el.innerText || el.textContent || '').trim();
    var label = nodeToken(el);
    var prevCE = el.getAttribute('contenteditable');
    // ONE thing to remember: the element's whole inline style, restored verbatim.
    // Remembering `outline` alone meant every property the highlight grew had to
    // be remembered separately, and the first one that was not leaked onto the
    // page for good.
    var prevStyle = el.getAttribute('style');
    close(); // reveal the element so the admin can type over it
    el.setAttribute('contenteditable', 'true');
    highlight(el);
    el.focus();
    // Select all the text so typing replaces it.
    try {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      /* selection is a nicety */
    }

    function restore() {
      if (prevStyle === null) el.removeAttribute('style');
      else el.setAttribute('style', prevStyle);
      if (prevCE === null) el.removeAttribute('contenteditable');
      else el.setAttribute('contenteditable', prevCE);
      el.removeEventListener('keydown', onKey, true);
      el.removeEventListener('blur', onBlur, true);
      inlineActive = false;
    }
    function commit() {
      var after = (el.innerText || el.textContent || '').trim();
      var changed = after && after !== before;
      if (!changed) {
        el.textContent = before;
        restore();
        return;
      }
      restore();
      var instruction =
        'Change the visible text of the ' + label + ' element from "' + before + '" to "' + after + '". Change only that text.';
      fab.style.display = 'none';
      panel.classList.add('open');
      showMessageBusy('Applying…');
      postEdit(instruction, path, 'direct');
    }
    function onKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        el.textContent = before;
        restore();
      }
    }
    function onBlur() {
      commit();
    }
    el.addEventListener('keydown', onKey, true);
    el.addEventListener('blur', onBlur, true);
  }

  // A minimal "working" panel used when a flow starts without a form on screen
  // (inline edit). The subsequent renderEditResult replaces it.
  function showMessageBusy(label) {
    panel.innerHTML =
      '<div class="hd"><div><b>Hanzo Edit</b></div><button class="x" aria-label="Close">×</button></div>' +
      '<div class="bd"><div class="msg"><span class="spin"></span>' +
      esc(label) +
      '</div></div>';
    panel.querySelector('.x').onclick = close;
  }

  function readJson(res) {
    return res
      .json()
      .then(function (data) {
        return { status: res.status, data: data };
      })
      .catch(function () {
        return { status: res.status, data: {} };
      });
  }

  function open() {
    panel.classList.add('open');
    fab.style.display = 'none';
    CTX.chosen = '';
    renderForm(); // render immediately (candidates fill in when resolved)
    resolveCandidates()
      .then(function (res) {
        CTX.candidates = res.candidates;
        CTX.version = res.version;
        if (panel.classList.contains('open')) renderForm();
      })
      .catch(function () {
        /* keep the form usable with no candidates */
      });
  }
  function close() {
    panel.classList.remove('open');
    fab.style.display = '';
  }
  fab.onclick = open;

  // Register this property as a project so it "ties back" and shows in
  // hanzo.app's projects list. Fire-and-forget, idempotent (the server only
  // creates when no project already links this repo), and SIGNED-IN ONLY. The
  // org is derived server-side from the bearer — the browser never picks it.
  var REGISTERED = false;
  function registerProperty() {
    if (REGISTERED) return;
    REGISTERED = true;
    api('/v1/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: REPO }),
    }).catch(function () {
      /* registration is a convenience — never blocks editing */
    });
  }

  // The preference transform, from @hanzo/design via hanzo.app. Cross-origin, so
  // /vendor/appearance/* carries Access-Control-Allow-Origin (next.config.ts) —
  // without it the import rejects and the section simply never appears, which is
  // the honest degradation: the widget's other jobs are unaffected.
  import(BASE + '/vendor/appearance/preference.js')
    .then(function (m) {
      if (m && typeof m.vars === 'function') {
        VARS = m.vars;
        // Apply what this device already chose, then let an open panel show it.
        applyPref(readPref());
        if (panel && panel.classList.contains('open')) renderForm();
      }
    })
    .catch(function () {
      /* no transform, no preferences section — every other capability stands */
    });

  // Probe identity to shape the CTA. It fails CLOSED to the signed-out state,
  // which is now the honest one: the door refuses an unnamed suggestion, so a
  // widget that could not reach /v1/me must not promise one.
  api('/v1/me', { headers: { Accept: 'application/json' } })
    .then(function (r) {
      return r.json();
    })
    .then(function (d) {
      if (d && typeof d === 'object') {
        ME.authenticated = !!d.authenticated;
        ME.isAdmin = !!d.isAdmin;
        ME.hasCredits = !!d.hasCredits;
        ME.balance = typeof d.balance === 'number' ? d.balance : null;
        // Absent state is NOT "you have no money" — an old server that does not
        // send it is our unknown, so it reads as 'unavailable', never as a zero.
        ME.balanceState = typeof d.balanceState === 'string' ? d.balanceState : 'unavailable';
      }
      if (ME.authenticated) registerProperty();
    })
    .catch(function () {
      /* stays signed-out: the CTA asks for a sign-in rather than a paragraph */
    });
})();
