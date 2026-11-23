// POST /api/create-portal-session
// Opens Stripe's hosted page where a member can update their card, switch plans, or cancel.
// The customer is looked up from the signed-in user, never taken from the request.

import Stripe from 'stripe';
import { getUser, getProfile } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Payments aren\'t set up yet.' });
  }

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Sign in first.' });

  try {
    const profile = await getProfile(user.id);
    if (!profile.stripe_customer_id) {
      return res.status(400).json({ error: 'No membership found for this account.' });
    }
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const publicUrl = process.env.PUBLIC_URL || `https://${req.headers.host}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${publicUrl}/`
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Peacho /api/create-portal-session error:', err);
    return res.status(500).json({ error: 'Couldn\'t open billing. Try again.' });
  }
}
