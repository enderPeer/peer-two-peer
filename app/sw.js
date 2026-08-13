/* ==========================================================================
   Peer two Peer — service worker.

   Three jobs, and one promise.

     1. The app shell is installable and starts offline.
     2. Static assets are served instantly and refreshed in the background.
     3. Calls to /api go to the network first, because a stale balance is a
        lie and a stale price is a mispriced impression.

   The promise: a picture is never kept past its post's expiry. A post is a
   lease. When the lease ends the post settles, the payload is redacted from
   every node, and a cache that quietly held a copy would make that deletion
   a fiction. So the media cache stores the expiry alongside the bytes and
   drops them the moment they are due — and drops them early on request.

   Note on clocks: core/replay.mjs may never consult one, and does not. This
   file is not the rulebook. Nothing here moves a balance or decides what is
   true; the worst a wrong clock can do here is forget a picture too early,
   which is always safe, or serve one a few seconds late, which the eviction
   check on the next read corrects.

   ── cache naming and version bumps ─────────────────────────────────────────
   Two families, deliberately different:

     ptp-shell-v<N>   the documents, the stylesheet, the modules.
     ptp-static-v<N>  everything else same-origin that is not API or media.

   Both carry VERSION in their name. Bump VERSION on any change to a
   precached file. The new worker installs its new caches beside the old ones,
   and only on `activate` — that is, once the old worker has released its
   clients — are the old ones deleted. A half-updated shell is therefore
   impossible: a client runs entirely on v(N) or entirely on v(N+1).

     ptp-media        NOT versioned, on purpose.

   The pictures are members' bytes, fetched over the network and possibly
   large. Discarding them because a stylesheet changed would spend other
   people's bandwidth to no benefit. Media correctness is governed by expiry,
   which is per entry and independent of any shell release, so the media cache
   survives every bump and is pruned by time and by settlement instead.
   ========================================================================== */

/* Bumped to 2: index.html and style.css are both precached REQUIRED entries and
   both changed. Leaving this at 1 would keep every returning client on the
   shell that announced the meter twice and demoted refusals to polite — the
   accessibility fixes would ship and nobody already installed would receive
   them. This constant is the only thing that makes a shell change reach a
   device that already has the old one. */
const VERSION = 2;

const SHELL_CACHE  = `ptp-shell-v${VERSION}`;
const STATIC_CACHE = `ptp-static-v${VERSION}`;
const MEDIA_CACHE  = 'ptp-media';

/* Caches this worker owns. Anything else beginning with "ptp-" is a leftover
   from an older VERSION and is removed on activate. */
const KEEP = new Set([SHELL_CACHE, STATIC_CACHE, MEDIA_CACHE]);

/* The shell, in two halves.

   REQUIRED is fetched with addAll, which is atomic: if one entry is missing
   the install fails, the old worker stays in charge, and nothing ends up half
   updated. These four are the app — without any one of them there is nothing
   to start. */
const REQUIRED = [
  './',
  './index.html',
  './style.css',
  './app.mjs',
];

/* OPTIONAL is fetched one entry at a time and allowed to fail. Modules that
   load lazily, or that a given deployment may legitimately not ship, belong
   here: an absent side module should cost one feature, never the whole app's
   ability to start with the network off. */
const OPTIONAL = [
  './manifest.webmanifest',
  './storage.mjs',
];

const SHELL = [...REQUIRED, ...OPTIONAL];

/* Resolved once against this worker's own scope, so the router can tell a
   shell file from any other static asset without string surgery. */
const SHELL_PATHS = new Set(SHELL.map((s) => new URL(s, self.location).pathname));

/* The header we add to a cached picture to record when it stops being ours to
   keep. Milliseconds since the epoch, as a decimal string. */
const EXP_HEADER = 'x-ptp-expires';


/* --------------------------------------------------------------------------
   install — precache the shell.
   addAll is atomic: if one entry 404s the whole install fails and the old
   worker stays in charge, which is the correct outcome. We do not call
   skipWaiting() here; taking over a running client mid-session can swap the
   module graph under it. The page asks for it explicitly instead, by posting
   {type:'SKIP_WAITING'} when it is ready to reload.
   -------------------------------------------------------------------------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(REQUIRED);
    await Promise.all(OPTIONAL.map((u) => cache.add(u).catch(() => null)));
  })());
});


/* --------------------------------------------------------------------------
   activate — drop superseded caches, prune expired pictures, take the clients.
   The sweep runs here because activation is the one moment we are guaranteed
   to get after an update and before the first fetch of the new session.
   -------------------------------------------------------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('ptp-') && !KEEP.has(n))
        .map((n) => caches.delete(n))
    );
    await sweepMedia();
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable();
    }
    await self.clients.claim();
  })());
});


/* --------------------------------------------------------------------------
   messages — the page's three levers.

     SKIP_WAITING  take over now; the page has decided it is safe to reload.
     FORGET        a post settled: delete its picture from this device's cache
                   immediately, without waiting for the expiry to come round.
                   Settlement redacts the payload everywhere, and "everywhere"
                   includes here.
     SWEEP         prune every entry whose expiry has passed.
   -------------------------------------------------------------------------- */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'FORGET' && typeof data.cid === 'string') {
    event.waitUntil(forgetMedia(data.cid));
    return;
  }
  if (data.type === 'SWEEP') {
    event.waitUntil(sweepMedia());
  }
});


/* --------------------------------------------------------------------------
   fetch — the router.

   Only same-origin GETs are ever touched. A cross-origin response is opaque:
   we cannot read its status, so caching it means caching an unknown, and an
   unknown served as the app shell is a blank screen with no explanation.
   Everything else falls through to the network untouched.
   -------------------------------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // A navigation always resolves to the shell, so a deep link works offline.
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigate(event));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req));
    return;
  }

  if (isMedia(url)) {
    event.respondWith(handleMedia(req, url));
    return;
  }

  event.respondWith(staleWhileRevalidate(req));
});


/* --------------------------------------------------------------------------
   handleNavigate — network first, shell as the floor.
   The document is tried over the network (using the preloaded response if the
   browser started one), and any failure lands on the precached shell rather
   than on a browser error page. The app then reads what it can from cache and
   says so in its banner.
   -------------------------------------------------------------------------- */
async function handleNavigate(event) {
  try {
    const preload = await event.preloadResponse;
    if (preload) {
      await putIfOk(SHELL_CACHE, './index.html', preload.clone());
      return preload;
    }
    const fresh = await fetch(event.request);
    await putIfOk(SHELL_CACHE, './index.html', fresh.clone());
    return fresh;
  } catch {
    const cached = await caches.match('./index.html', { cacheName: SHELL_CACHE })
                || await caches.match('./');
    return cached || new Response(
      'Offline, and no copy of the app is stored on this device yet.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  }
}


/* --------------------------------------------------------------------------
   networkFirst — for /api.
   Balances, quotes and the oracle rate must be the live ones; a cached price
   is a price the pool no longer offers. We still keep the last good copy of a
   GET so that an offline app can render *something* and label it as stale,
   but the network always gets the first attempt and always wins when it
   answers.
   -------------------------------------------------------------------------- */
async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok && fresh.type === 'basic') {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await caches.match(req);
    if (cached) {
      // Mark it, so the app can tell the user what they are looking at.
      const headers = new Headers(cached.headers);
      headers.set('x-ptp-stale', '1');
      return new Response(await cached.blob(), {
        status: cached.status,
        statusText: cached.statusText,
        headers,
      });
    }
    return new Response(
      JSON.stringify({ code: 'offline', msg: 'The writer could not be reached.', next: 'Reconnect and retry; nothing was sent.' }),
      { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } }
    );
  }
}


/* --------------------------------------------------------------------------
   staleWhileRevalidate — for the shell and every other static asset.
   The cached copy is returned at once, so the app paints from disk, and the
   network copy replaces it in the background for the next load. This is why
   VERSION exists: a stale asset is corrected on the following visit, and a
   *breaking* change is corrected immediately by a new cache name.
   -------------------------------------------------------------------------- */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(cacheFor(req));
  const cached = await cache.match(req);

  const network = fetch(req).then((res) => {
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  if (cached) return cached;
  const fresh = await network;
  return fresh || new Response('', { status: 504 });
}

/* Shell files live in the shell cache so the version bump governs them; every
   other static asset lives beside them but is disposable. */
function cacheFor(req) {
  return SHELL_PATHS.has(new URL(req.url).pathname) ? SHELL_CACHE : STATIC_CACHE;
}


/* --------------------------------------------------------------------------
   Media — the part with the promise in it.

   A picture is requested as  /media/<cid>?exp=<epochMillis>  where exp is the
   post's expiry, taken from the act. The rule is simple and has no exception:

     · no exp on the URL     → never cached. We do not know when to forget it,
                               so we do not keep it.
     · exp in the past       → never cached, and any copy is deleted on sight.
     · otherwise             → cached with the expiry stamped into a response
                               header, and evicted the first time it is asked
                               for after that instant, or by a sweep, or by a
                               FORGET message at settlement — whichever is
                               first.

   Reads are cache-first, because a picture's bytes are immutable: the cid is
   the sha256 of them, so a hit is by definition the right content. There is
   nothing to revalidate. Only the right to hold it expires.
   -------------------------------------------------------------------------- */

function isMedia(url) {
  return url.pathname.startsWith('/media/');
}

/* The expiry the URL claims, in milliseconds, or null when it claims none.
   Anything unparseable is treated as "none": we refuse to keep bytes whose
   lifetime we cannot read. */
function expiryOf(url) {
  const raw = url.searchParams.get('exp');
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  const ms = Number(raw);
  return Number.isSafeInteger(ms) ? ms : null;
}

/* The cache key drops the query string, so the same picture requested with a
   later exp (after an `extend`) is one entry, not two. The expiry that counts
   is the one stored on the entry, and it is refreshed on every fetch. */
function mediaKey(url) {
  return new Request(url.origin + url.pathname);
}

async function handleMedia(req, url) {
  const exp = expiryOf(url);
  const cache = await caches.open(MEDIA_CACHE);
  const key = mediaKey(url);

  if (exp === null) return fetch(req);          // unknown lifetime, never kept

  const hit = await cache.match(key);
  if (hit) {
    const stored = Number(hit.headers.get(EXP_HEADER) || 0);
    if (stored > Date.now()) return hit;
    await cache.delete(key);                     // the lease ran out
  }

  const res = await fetch(req);
  if (res && res.ok && res.type === 'basic' && exp > Date.now()) {
    await cache.put(key, await stamp(res.clone(), exp));
  }
  return res;
}

/* Re-wrap a response with the expiry recorded on it. The Cache API stores
   whatever Response it is given, headers included, so this is how an entry
   carries its own deadline without a second index to keep in step. */
async function stamp(res, exp) {
  const headers = new Headers(res.headers);
  headers.set(EXP_HEADER, String(exp));
  return new Response(await res.blob(), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/* Delete every cached picture whose expiry has passed. Cheap: it reads keys
   and headers, never bodies. */
async function sweepMedia() {
  const cache = await caches.open(MEDIA_CACHE);
  const keys = await cache.keys();
  const now = Date.now();
  await Promise.all(keys.map(async (key) => {
    const res = await cache.match(key);
    const exp = Number(res && res.headers.get(EXP_HEADER) || 0);
    if (!exp || exp <= now) await cache.delete(key);
  }));
}

/* Forget one picture now. Called when a post settles: the payload is redacted
   from every node, and this device is a node. */
async function forgetMedia(cid) {
  const cache = await caches.open(MEDIA_CACHE);
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((k) => new URL(k.url).pathname.endsWith('/' + cid))
      .map((k) => cache.delete(k))
  );
}


/* --------------------------------------------------------------------------
   putIfOk — write a response to a cache only when it is genuinely a response.
   A 404 or an opaque redirect stored as the app shell is a permanent blank
   screen, so the check is not optional.
   -------------------------------------------------------------------------- */
async function putIfOk(cacheName, key, res) {
  if (!res || !res.ok || res.type !== 'basic') return;
  const cache = await caches.open(cacheName);
  await cache.put(key, res);
}
