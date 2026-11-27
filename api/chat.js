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
const IMAGE_PROMPT = [
  "You are a master vector illustrator. Create ONE polished, professional SVG illustration of what the user asks for.",
  "Format: viewBox='0 0 500 500', include xmlns, no external assets, no <script>, no <foreignObject>, no text unless the user asked for words.",
  "Craft: give it a clear focal point and real depth. Build it in layers: a rich background (gradient or soft shapes), a midground, a detailed foreground subject, then highlights and soft shadows on top.",
  "Use a deliberate, harmonious palette of 4-6 colors plus tints. Use <linearGradient>/<radialGradient> for volume, rounded shapes, subtle drop shadows via <feGaussianBlur> filters, and highlight shapes with low opacity so things feel dimensional, not flat.",
  "Keep proportions believable, shapes smooth, and the composition balanced with comfortable margins. Add tasteful small details (texture dots, rim light, sparkles, leaves, etc.) that suit the subject.",
  "Be efficient so the file finishes: define reusable parts once in <defs> and reuse them with <use>, avoid long redundant paths, and stay under about 9,000 characters.",
  "Return ONLY the raw <svg>...</svg> markup, fully closed, nothing before or after it, no markdown fences, no explanation."
].join(" ");

const ANIMATION_PROMPT = [
  "You are a motion designer. Create ONE delightful, polished looping animated scene of what the user asks for, as a self-contained HTML fragment.",
  "Format: a single inline <svg viewBox='0 0 320 320' width='320' height='320'> (plus an optional <style> block). No JavaScript, no external files or fonts, no <script>.",
  "Animate with CSS @keyframes and/or SVG SMIL (<animate>, <animateTransform>). Use transform-box:fill-box and transform-origin so parts rotate and scale around their own centers.",
  "Craft: give the scene a gradient background, a clear main subject built from several shapes, and a supporting layer of secondary motion (floating particles, drifting clouds, twinkling stars, waves, glow pulses) at different speeds so it feels alive.",
  "Use smooth easing (ease-in-out or cubic-bezier), stagger parts with animation-delay, and make the main loop 3 to 8 seconds, repeating forever (infinite) with a seamless start and end.",
  "Use a harmonious palette with gradients and soft shadows. Keep everything inside the 320x320 area.",
  "Be efficient so the file finishes: reuse shapes via <defs>/<use> or shared CSS classes, and stay under about 8,000 characters.",
  "Return ONLY the raw HTML fragment, fully closed, nothing before or after it, no markdown fences, no explanation."
].join(" ");

const SYSTEM_PROMPTS = { image: IMAGE_PROMPT, animation: ANIMATION_PROMPT };
// Pictures and animations need far more room than a chat reply.
const MAX_TOKENS_BY_KIND = { chat: MAX_TOKENS_CAP, image: 4000, animation: 3500 };

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
        max_tokens: Math.min(Number(max_tokens) || 1000, MAX_TOKENS_BY_KIND[requestKind]),
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
