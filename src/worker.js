/**
 * IsaaCart — Cloudflare Worker
 * Static assets (public/) + JSON API backed by D1.
 *
 * Public routes:
 *   GET  /api/health        → service + database check
 *   POST /api/contact       → save a contact message
 *   POST /api/book          → save an artwork booking request
 *   GET  /api/artworks      → gallery artworks (public)
 *   GET  /img/<key>         → uploaded images
 *
 * Admin routes (cookie session, login at /admin):
 *   POST /api/admin/login   → { password }
 *   POST /api/admin/logout
 *   GET  /api/admin/session → auth check
 *   GET  /api/admin/artworks / POST create / POST :id update / DELETE :id
 *   GET  /api/admin/messages / POST :id status / DELETE :id
 *   POST /api/admin/upload  → { name, data(base64) } stores image in D1
 *
 * Anything else → static assets from public/ (incl. /admin → admin.html)
 */

const MAX_BODY_BYTES = 20000;      // JSON forms
const MAX_IMAGE_BASE64 = 1600000;  // ~1.2 MB decoded after client resize
const SESSION_HOURS = 12;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function fail(error, status = 400) {
  return json({ ok: false, error }, status);
}

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function clientIp(request) {
  const xff = request.headers.get('x-forwarded-for');
  return (
    request.headers.get('cf-connecting-ip') ||
    (xff ? xff.split(',')[0].trim() : '') ||
    'unknown'
  );
}

function text(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  const raw = await request.text();
  if (raw.length > maxBytes) throw httpError('Payload too large', 413);
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw httpError('Invalid JSON body', 400);
  }
}

/* ============================================================
   SESSION HELPERS (HMAC-signed expiry, HttpOnly cookie)
   ============================================================ */

async function hmacHex(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sessionCookie(exp, sig) {
  return `adm=${exp}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`;
}

const CLEAR_COOKIE = 'adm=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';

async function isAdmin(request, env) {
  if (!env.ADMIN_SECRET) return false;
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)adm=(\d+)\.([a-f0-9]{64})/);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!exp || Date.now() > exp) return false;
  const sig = await hmacHex('adm' + m[1], env.ADMIN_SECRET);
  return sig === m[2];
}

async function checkPassword(env, password) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SECRET) {
    throw httpError('Admin password is not configured yet (set ADMIN_PASSWORD secret)', 500);
  }
  const a = await hmacHex(text(password, 200), env.ADMIN_SECRET);
  const b = await hmacHex(env.ADMIN_PASSWORD, env.ADMIN_SECRET);
  return a === b;
}

/** Max 5 failed logins per IP per 10 minutes. */
async function loginThrottled(env, request) {
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM login_throttle WHERE ip = ?1 AND created_at > datetime('now', '-10 minutes')`)
    .bind(clientIp(request))
    .first();
  return (row ? row.n : 0) >= 5;
}

/* ============================================================
   RATE LIMIT (public forms) — 5 submissions / 10 min / IP
   ============================================================ */

async function rateLimited(env, request) {
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ip = ?1 AND created_at > datetime('now', '-10 minutes')`)
    .bind(clientIp(request))
    .first();
  return (row ? row.n : 0) >= 5;
}

function userAgent(request) {
  return text(request.headers.get('user-agent'), 300) || null;
}

/* ============================================================
   PUBLIC FORM HANDLERS
   ============================================================ */

function validate(d, needMessage) {
  const name = text(d.name, 80);
  const phone = text(d.phone, 24);
  const email = text(d.email, 120);
  const subject = text(d.subject, 150);
  const message = text(d.message, 5000);

  if (name.length < 2) return { error: 'Please enter your name' };
  if (phone.replace(/[^\d]/g, '').length < 7) return { error: 'Please enter a valid phone number' };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { error: 'That email address looks invalid' };
  if (needMessage && message.length < 5) return { error: 'Please write a short message' };

  return { name, phone, email, subject, message };
}

async function handleContact(env, request) {
  const d = await readBody(request);
  if (text(d.website, 200)) return json({ ok: true }); // honeypot
  const v = validate(d, true);
  if (v.error) return fail(v.error);
  if (await rateLimited(env, request)) {
    return fail('Too many messages right now — please try again in a few minutes', 429);
  }
  const res = await env.DB
    .prepare(
      `INSERT INTO messages (type, name, phone, email, subject, message, ip, user_agent)
       VALUES ('contact', ?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .bind(v.name, v.phone, v.email || null, v.subject || null, v.message, clientIp(request), userAgent(request))
    .run();
  return json({ ok: true, id: res.meta.last_row_id });
}

async function handleBooking(env, request) {
  const d = await readBody(request);
  if (text(d.website, 200)) return json({ ok: true }); // honeypot
  const v = validate(d, false);
  if (v.error) return fail(v.error);
  if (await rateLimited(env, request)) {
    return fail('Too many requests right now — please try again in a few minutes', 429);
  }
  const meta = JSON.stringify({
    size: text(d.artworkSize, 60),
    medium: text(d.artworkMedium, 80),
    layers: text(d.artworkLayers, 40),
  });
  const res = await env.DB
    .prepare(
      `INSERT INTO messages (type, name, phone, message, artwork_id, artwork_title, artwork_price, meta, ip, user_agent)
       VALUES ('booking', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      v.name, v.phone, v.message || null,
      text(d.artworkId, 40) || null,
      text(d.artworkTitle, 120) || 'Untitled',
      text(d.artworkPrice, 30) || null,
      meta, clientIp(request), userAgent(request)
    )
    .run();
  return json({ ok: true, id: res.meta.last_row_id });
}

/* ============================================================
   ARTWORK HELPERS
   ============================================================ */

function artworkOut(r) {
  return {
    id: r.id,
    title: r.title,
    cat: r.cat || 'portrait',
    price: Number(r.price) || 0,
    sz: r.sz || '',
    md: r.md || '',
    ly: r.ly || '',
    img: r.img || '',
    desc: r.descr || '',
    av: !!r.av,
    yr: r.yr || '',
    sort: r.sort || 0,
  };
}

function artworkFields(d, partial, existing) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(d, k) || (partial && existing && existing[k] !== undefined && false);

  if (!partial || d.title !== undefined) {
    const t = text(d.title, 120);
    if (t.length < 2) throw httpError('Title must be at least 2 characters', 400);
    out.title = t;
  }
  if (!partial || d.cat !== undefined) out.cat = text(d.cat, 40) || 'portrait';
  if (!partial || d.price !== undefined) {
    const p = Number(d.price);
    out.price = Number.isFinite(p) && p >= 0 && p <= 10000000 ? p : 0;
  }
  if (!partial || d.sz !== undefined) out.sz = text(d.sz, 60) || null;
  if (!partial || d.md !== undefined) out.md = text(d.md, 80) || null;
  if (!partial || d.ly !== undefined) out.ly = text(d.ly, 40) || null;
  if (!partial || d.img !== undefined) {
    const img = text(d.img, 600);
    if (img && !img.startsWith('/img/') && !/^https?:\/\//.test(img)) {
      throw httpError('Image must be an uploaded file or a URL', 400);
    }
    out.img = img || null;
  }
  if (!partial || d.descr !== undefined) out.descr = text(d.descr !== undefined ? d.descr : d.desc, 2000) || null;
  if (!partial || d.av !== undefined) out.av = (d.av === undefined ? true : (d.av === true || d.av === 1 || d.av === '1' || d.av === 'true')) ? 1 : 0;
  if (!partial || d.yr !== undefined) out.yr = text(d.yr, 10) || null;
  if (!partial || d.sort !== undefined) {
    const s = Number(d.sort);
    out.sort = Number.isFinite(s) ? Math.trunc(s) : 0;
  }
  return out;
}

/* ============================================================
   MAIN ROUTER
   ============================================================ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Images uploaded from the admin dashboard
    if (request.method === 'GET' && path.startsWith('/img/')) {
      const key = text(path.slice(5), 64);
      if (!key) return fail('Not found', 404);
      const row = await env.DB.prepare(`SELECT data, mime FROM artwork_images WHERE key = ?1`).bind(key).first();
      if (!row) return fail('Not found', 404);
      const bytes = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
      return new Response(bytes, {
        headers: {
          'content-type': row.mime || 'image/jpeg',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    }

    if (!path.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    try {
      /* ---------- public ---------- */

      if (path === '/api/health' && request.method === 'GET') {
        await env.DB.prepare('SELECT 1').first();
        return json({ ok: true, service: 'isaacart-api', db: 'connected' });
      }

      if (path === '/api/artworks' && request.method === 'GET') {
        const { results } = await env.DB
          .prepare(`SELECT * FROM artworks ORDER BY sort, id`)
          .all();
        return json({ ok: true, artworks: (results || []).map(artworkOut) });
      }

      if (path === '/api/contact') {
        if (request.method !== 'POST') return fail('Method not allowed. Use POST.', 405);
        return await handleContact(env, request);
      }

      if (path === '/api/book') {
        if (request.method !== 'POST') return fail('Method not allowed. Use POST.', 405);
        return await handleBooking(env, request);
      }

      /* ---------- admin: login ---------- */

      if (path === '/api/admin/login' && request.method === 'POST') {
        if (await loginThrottled(env, request)) {
          return fail('Too many failed attempts — wait 10 minutes and try again', 429);
        }
        const d = await readBody(request);
        let ok = false;
        try { ok = await checkPassword(env, d.password); } catch (e) { return fail(e.message, e.status || 500); }
        if (!ok) {
          await env.DB.prepare(`INSERT INTO login_throttle (ip) VALUES (?1)`).bind(clientIp(request)).run();
          await env.DB.prepare(`DELETE FROM login_throttle WHERE created_at < datetime('now', '-30 minutes')`).run();
          return fail('Wrong password', 401);
        }
        await env.DB.prepare(`DELETE FROM login_throttle WHERE ip = ?1`).bind(clientIp(request)).run();
        const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
        const sig = await hmacHex('adm' + exp, env.ADMIN_SECRET);
        return json({ ok: true }, 200, { 'set-cookie': sessionCookie(exp, sig) });
      }

      if (path === '/api/admin/logout' && request.method === 'POST') {
        return json({ ok: true }, 200, { 'set-cookie': CLEAR_COOKIE });
      }

      if (path === '/api/admin/session' && request.method === 'GET') {
        return json({ ok: true, authed: await isAdmin(request, env) });
      }

      /* ---------- admin: everything below needs a session ---------- */

      if (path.startsWith('/api/admin/')) {
        if (!(await isAdmin(request, env))) return fail('Not authorized', 401);

        // ---- artworks ----
        if (path === '/api/admin/artworks' && request.method === 'GET') {
          const { results } = await env.DB.prepare(`SELECT * FROM artworks ORDER BY sort, id`).all();
          return json({ ok: true, artworks: (results || []).map(artworkOut) });
        }

        if (path === '/api/admin/artworks' && request.method === 'POST') {
          const d = await readBody(request, MAX_IMAGE_BASE64 + 40000);
          const f = artworkFields(d, false);
          const res = await env.DB
            .prepare(
              `INSERT INTO artworks (title, cat, price, sz, md, ly, img, descr, av, yr, sort)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
            )
            .bind(f.title, f.cat, f.price, f.sz, f.md, f.ly, f.img, f.descr, f.av, f.yr, f.sort)
            .run();
          return json({ ok: true, id: res.meta.last_row_id });
        }

        let m = path.match(/^\/api\/admin\/artworks\/(\d+)$/);
        if (m) {
          const id = Number(m[1]);
          if (request.method === 'POST' || request.method === 'PUT') {
            const existing = await env.DB.prepare(`SELECT * FROM artworks WHERE id = ?1`).bind(id).first();
            if (!existing) return fail('Artwork not found', 404);
            const d = await readBody(request, MAX_IMAGE_BASE64 + 40000);
            const f = artworkFields(d, true);
            const keys = Object.keys(f);
            if (!keys.length) return fail('Nothing to update', 400);
            const setSql = keys.map((k, i) => `${k} = ?${i + 1}`).join(', ');
            const res = await env.DB
              .prepare(`UPDATE artworks SET ${setSql} WHERE id = ?${keys.length + 1}`)
              .bind(...keys.map((k) => f[k]), id)
              .run();
            return json({ ok: true, updated: res.meta.changes });
          }
          if (request.method === 'DELETE') {
            const res = await env.DB.prepare(`DELETE FROM artworks WHERE id = ?1`).bind(id).run();
            return json({ ok: true, deleted: res.meta.changes });
          }
          return fail('Method not allowed', 405);
        }

        // ---- messages ----
        if (path === '/api/admin/messages' && request.method === 'GET') {
          const status = text(url.searchParams.get('status'), 20);
          const stmt = status
            ? await env.DB.prepare(`SELECT * FROM messages WHERE status = ?1 ORDER BY id DESC LIMIT 300`).bind(status)
            : await env.DB.prepare(`SELECT * FROM messages ORDER BY id DESC LIMIT 300`);
          const { results } = await stmt.all();
          return json({ ok: true, messages: results || [] });
        }

        m = path.match(/^\/api\/admin\/messages\/(\d+)$/);
        if (m) {
          const id = Number(m[1]);
          if (request.method === 'POST') {
            const d = await readBody(request);
            const status = text(d.status, 20);
            if (!['new', 'read', 'archived'].includes(status)) return fail('Invalid status');
            await env.DB.prepare(`UPDATE messages SET status = ?1 WHERE id = ?2`).bind(status, id).run();
            return json({ ok: true });
          }
          if (request.method === 'DELETE') {
            await env.DB.prepare(`DELETE FROM messages WHERE id = ?1`).bind(id).run();
            return json({ ok: true });
          }
          return fail('Method not allowed', 405);
        }

        // ---- image upload (stored in D1, served at /img/<key>) ----
        if (path === '/api/admin/upload' && request.method === 'POST') {
          const d = await readBody(request, MAX_IMAGE_BASE64 + 40000);
          let b64 = text(d.data, MAX_IMAGE_BASE64);
          const dm = b64.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
          let mime = 'image/jpeg';
          if (dm) { mime = dm[1]; b64 = dm[2]; }
          if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return fail('Invalid image data');
          const bytes = Math.floor(b64.length * 0.75);
          if (bytes < 1000) return fail('Image file is too small or empty');
          if (bytes > 1200000) return fail('Image too large after resize (max ~1 MB)');
          const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          await env.DB
            .prepare(`INSERT INTO artwork_images (key, mime, data) VALUES (?1, ?2, ?3)`)
            .bind(key, mime, b64)
            .run();
          return json({ ok: true, url: '/img/' + key, bytes });
        }

        return fail('Not found', 404);
      }

      return fail('Not found', 404);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      return fail(status === 500 ? 'Server error' : err.message, status);
    }
  },
};
