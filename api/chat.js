// POST /api/chat
// Everyone who reaches Peacho has a session (a guest session or a real account).
// This route adds your Anthropic key (kept on the server), enforces a daily message
// limit so costs stay predictable. Images and animations are free for everyone, but each
// person (and all guests together) gets a separate daily allowance for them.

import { createHash } from 'node:crypto';
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
  ultra: num(process.env.ULTRA_DAILY_LIMIT, 1000),           // Ultra plan
  // Images + animations per day (they cost more than chat messages)
  createGuest: num(process.env.GUEST_CREATE_DAILY_LIMIT, 3),
  createFree: num(process.env.FREE_CREATE_DAILY_LIMIT, 10),
  createMember: num(process.env.MEMBER_CREATE_DAILY_LIMIT, 50),
  createAll: num(process.env.GLOBAL_CREATE_DAILY_LIMIT, 100)  // everyone combined
});
const ALL_GUESTS_ID = '00000000-0000-0000-0000-000000000000';
const ALL_CREATIONS_ID = '00000000-0000-0000-0000-000000000001';
// A stable second counter id for each person, so creations are counted separately from chat.
const creationId = (userId) => {
  const h = createHash('sha256').update('create:' + userId).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

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

    const limits = LIMITS();
    const limit = isGuest ? limits.guest : isMember ? (limits[profile.tier] || limits.starter) : limits.free;
    const used = await bumpUsage(user.id);
    if (used > limit) {
      return res.status(403).json({ error: { message: isGuest
        ? 'You\'ve used today\'s guest messages. Create a free account for more, or come back tomorrow.'
        : 'You\'ve reached today\'s message limit. It resets tomorrow.' } });
    }
    if (requestKind !== 'chat') {
      const createLimit = isGuest ? limits.createGuest : isMember ? limits.createMember : limits.createFree;
      const madeToday = await bumpUsage(creationId(user.id));
      if (madeToday > createLimit) {
        return res.status(403).json({ error: { message: isGuest
          ? 'You\'ve used today\'s free creations. Create a free account for more, or come back tomorrow.'
          : 'You\'ve used today\'s free image and animation creations. They reset tomorrow.' } });
      }
      const madeByAll = await bumpUsage(ALL_CREATIONS_ID);
      if (madeByAll > limits.createAll) {
        return res.status(403).json({ error: { message: 'Free image and animation creation is full for today. Please try again tomorrow.' } });
      }
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
