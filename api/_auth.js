// Shared helpers for the API routes. The leading underscore keeps Vercel from
// exposing this file as a public endpoint.
//
// Needs these environment variables in Vercel:
//   SUPABASE_URL              e.g. https://vccxfwvgwztvboosydvt.supabase.co
//   SUPABASE_PUBLISHABLE_KEY  the sb_publishable_... key (safe to share)
//   SUPABASE_SECRET_KEY       the sb_secret_... key (PRIVATE, server only)

const SUPABASE_URL = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');

// Checks the signed-in user's token with Supabase. Returns the user, or null if it isn't valid.
export async function getUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !SUPABASE_URL() || !process.env.SUPABASE_PUBLISHABLE_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL()}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;
    const user = await r.json();
    return user && user.id ? user : null;
  } catch (err) {
    console.error('Peacho getUser error:', err);
    return null;
  }
}

// Calls Supabase's database API with the secret key (bypasses row-level security).
// Only use this in server code, never in the page.
export async function adminRest(path, { method = 'GET', body, prefer } = {}) {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key || !SUPABASE_URL()) throw new Error('Server is missing SUPABASE_URL or SUPABASE_SECRET_KEY.');
  const r = await fetch(`${SUPABASE_URL()}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Supabase ${r.status}: ${text}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

export async function getProfile(userId) {
  const rows = await adminRest(`profiles?user_id=eq.${encodeURIComponent(userId)}&select=tier,stripe_customer_id`);
  return rows && rows[0] ? rows[0] : { tier: null, stripe_customer_id: null };
}

// Adds one to today's message count for this user and returns the new total.
// The count lives in the "usage" table (see supabase-setup.sql).
export async function bumpUsage(userId) {
  const total = await adminRest('rpc/bump_usage', { method: 'POST', body: { p_user: userId } });
  return Number(total);
}
