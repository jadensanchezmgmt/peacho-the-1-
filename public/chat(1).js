// POST /api/chat
// Everyone who reaches Peacho has a session (a guest session or a real account).
// This route adds your Anthropic key (kept on the server), enforces a daily message
// limit so costs stay predictable, and keeps image and animation for paid members.

import { checkUser, authFailureMessage, getProfile, bumpUsage, env } from './_auth.js';

const MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS_CAP = 2000;

const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== undefined && value !== '' ? Number(value) : fallback);

// Messages per day. Change them with environment variables in Vercel, no code edit needed.
const LIMITS = () => ({
  guest: num(process.env.GUEST_DAILY_LIMIT, 15),            // each guest
  guestAll: num(process.env.GUEST_GLOBAL_DAILY_LIMIT, 300),  // all guests combined
  free: num(process.env.FREE_DAILY_LIMIT, 40),               // signed-in, no plan
  starter: num(process.env.STARTER_DAILY_LIMIT, 150),        // Starter plan
  pro: num(process.env.PRO_DAILY_LIMIT, 400),                // Pro plan
  ultra: num(process.env.ULTRA_DAILY_LIMIT, 1000)            // Ultra plan
});
const ALL_GUESTS_ID = '00000000-0000-0000-0000-000000000000';

// For image and animation requests the server picks the instructions itself,
// so a member's plan can't be bypassed by sending a different "kind".
const SYSTEM_PROMPTS = {
  image: "You generate a single clean, professional SVG illustration. viewBox must be '0 0 500 500'. No external assets, no scripts. Return ONLY the raw <svg>...</svg> markup, nothing before or after it, no markdown fences, no explanation.",
  animation: "You generate a short, self-contained looping CSS animation as an HTML fragment (inline SVG and/or divs plus a <style> block using @keyframes). No external libraries, no JavaScript, must loop infinitely, must fit visually in a 320x320 area. Return ONLY the HTML fragment, nothing before or after it, no markdown fences, no explanation."
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const apiKey = env('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'Server is missing ANTHROPIC_API_KEY. Add it in your hosting provider\'s environment variables.' } });
  }

  const { user, reason } = await checkUser(req);
  if (!user) {
    return res.status(reason === 'rejected' || reason === 'no_token' ? 401 : 500).json({ error: { message: authFailureMessage(reason) } });
  }
  const isGuest = user.is_anonymous === true;

  const { messages, system, max_tokens, kind } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'Missing messages in request body' } });
  }
  const requestKind = kind === 'image' || kind === 'animation' ? kind : 'chat';

  try {
    const profile = isGuest ? { tier: null } : await getProfile(user.id);
    const isMember = Boolean(profile.tier);

    if (requestKind !== 'chat' && !isMember) {
      return res.status(402).json({ error: { message: 'Image and animation need a membership. Create an account and subscribe to unlock them.' } });
    }

    const limits = LIMITS();
    const limit = isGuest ? limits.guest : isMember ? (limits[profile.tier] || limits.starter) : limits.free;
    const used = await bumpUsage(user.id);
    if (used > limit) {
      return res.status(403).json({ error: { message: isGuest
        ? 'You\'ve used today\'s guest messages. Create a free account for more, or come back tomorrow.'
        : 'You\'ve reached today\'s message limit. It resets tomorrow.' } });
    }
    if (isGuest) {
      const allGuests = await bumpUsage(ALL_GUESTS_ID);
      if (allGuests > limits.guestAll) {
        return res.status(403).json({ error: { message: 'Guest chat is full for today. Create an account to keep chatting, or come back tomorrow.' } });
      }
    }
  } catch (err) {
    console.error('Peacho usage check error:', err);
    // Includes the reason so setup problems are easy to spot. It never contains your keys.
    const reason = String((err && err.message) || err).slice(0, 240);
    return res.status(500).json({ error: { message: `Couldn't check your usage. Reason: ${reason}` } });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: Math.min(Number(max_tokens) || 1000, MAX_TOKENS_CAP),
        system: requestKind === 'chat' ? system : SYSTEM_PROMPTS[requestKind],
        messages: messages.slice(-30)
      })
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Peacho /api/chat error:', err);
    return res.status(500).json({ error: { message: 'Could not reach the AI service. Try again.' } });
  }
}
