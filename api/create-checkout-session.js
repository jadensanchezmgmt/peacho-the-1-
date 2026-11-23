// POST /api/create-checkout-session
// Body: { tier }. The signed-in user comes from their token, not from the request body.
// Returns a Stripe Checkout URL. Stripe Checkout offers cards, Apple Pay, and Google Pay
// automatically once they're turned on in your Stripe Dashboard (Settings -> Payment methods).

import Stripe from 'stripe';
import { getUser, getProfile } from './_auth.js';

const PRICE_IDS = () => ({
  starter: process.env.STRIPE_PRICE_STARTER,
  pro: process.env.STRIPE_PRICE_PRO,
  ultra: process.env.STRIPE_PRICE_ULTRA
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Payments aren\'t set up yet. Add STRIPE_SECRET_KEY in your hosting settings.' });
  }

  const user = await getUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Sign in to subscribe.' });
  }

  if (user.is_anonymous) {
    return res.status(403).json({ error: 'Create an account first, then subscribe.' });
  }

  const { tier } = req.body || {};
  const priceId = PRICE_IDS()[tier];
  if (!priceId) {
    return res.status(400).json({ error: `No Stripe price is set for "${tier}". Add STRIPE_PRICE_${String(tier).toUpperCase()} in your hosting settings.` });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const publicUrl = process.env.PUBLIC_URL || `https://${req.headers.host}`;

  try {
    const profile = await getProfile(user.id);
    if (profile.tier) {
      return res.status(400).json({ error: 'You already have a membership. Use Manage membership to change it.' });
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: user.email || undefined,
      client_reference_id: user.id,
      metadata: { tier, user_id: user.id },
      subscription_data: { metadata: { tier, user_id: user.id } },
      success_url: `${publicUrl}/?checkout=success`,
      cancel_url: `${publicUrl}/?checkout=cancelled`
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Peacho /api/create-checkout-session error:', err);
    return res.status(500).json({ error: 'Couldn\'t start checkout. Try again.' });
  }
}
