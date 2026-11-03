/**
 * IsaaCart — Cloudflare Worker
 * Static assets (public/) + JSON API backed by D1.
 *
 * Routes:
 *   GET  /api/health   → service + database check
 *   POST /api/contact  → save a contact message
 *   POST /api/book     → save an artwork booking request
 *   anything else      → static assets from public/
 */

const MAX_BODY_BYTES = 20000; // 20 KB is plenty for a form

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
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

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw httpError('Payload too large', 413);
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw httpError('Invalid JSON body', 400);
  }
}

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

/** Simple flood control: max 5 submissions per IP per 10 minutes. */
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

async function handleContact(env, request) {
  const d = await readBody(request);
  // Honeypot: real users never see this field. Bots fill it → fake success, store nothing.
  if (text(d.website, 200)) return json({ ok: true });

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
  if (text(d.website, 200)) return json({ ok: true });

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
      v.name,
      v.phone,
      v.message || null,
      text(d.artworkId, 40) || null,
      text(d.artworkTitle, 120) || 'Untitled',
      text(d.artworkPrice, 30) || null,
      meta,
      clientIp(request),
      userAgent(request)
    )
    .run();

  return json({ ok: true, id: res.meta.last_row_id });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Everything that is not the API is a static asset request.
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        await env.DB.prepare('SELECT 1').first();
        return json({ ok: true, service: 'isaacart-api', db: 'connected' });
      }

      if (url.pathname === '/api/contact') {
        if (request.method !== 'POST') return fail('Method not allowed. Use POST.', 405);
        return await handleContact(env, request);
      }

      if (url.pathname === '/api/book') {
        if (request.method !== 'POST') return fail('Method not allowed. Use POST.', 405);
        return await handleBooking(env, request);
      }

      return fail('Not found', 404);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      return fail(status === 500 ? 'Server error' : err.message, status);
    }
  },
};
