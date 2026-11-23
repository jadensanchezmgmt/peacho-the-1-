// POST /api/webhook
// Stripe calls this whenever a payment or subscription changes. It is what switches a
// member's plan on and off in the database, so it works even if their browser is closed.
//
// Needs STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL and SUPABASE_SECRET_KEY.

import Stripe from 'stripe';
import { adminRest } from './_auth.js';

export const config = {
  api: { bodyParser: false } // Stripe needs the raw request body to verify the signature
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function tierFromSubscription(subscription) {
  const priceId = subscription.items && subscription.items.data[0] && subscription.items.data[0].price.id;
  const map = {
    [process.env.STRIPE_PRICE_STARTER]: 'starter',
    [process.env.STRIPE_PRICE_PRO]: 'pro',
    [process.env.STRIPE_PRICE_ULTRA]: 'ultra'
  };
  return map[priceId] || (subscription.metadata && subscription.metadata.tier) || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Webhook is not configured.');
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const sig = req.headers['stripe-signature'];
  const buf = await buffer(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Peacho webhook signature error:', err.message);
    return res.status(400).send('Invalid signature');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.client_reference_id || (session.metadata && session.metadata.user_id);
        const tier = session.metadata && session.metadata.tier;
        if (userId && tier) {
          await adminRest('profiles?on_conflict=user_id', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates',
            body: { user_id: userId, tier, stripe_customer_id: session.customer, updated_at: new Date().toISOString() }
          });
        }
        break;
      }
      case 'customer.subscription.updated': {
        // Covers plan changes and cancellations made in Stripe's billing page.
        const subscription = event.data.object;
        const active = ['active', 'trialing', 'past_due'].includes(subscription.status);
        await adminRest(`profiles?stripe_customer_id=eq.${encodeURIComponent(subscription.customer)}`, {
          method: 'PATCH',
          body: { tier: active ? tierFromSubscription(subscription) : null, updated_at: new Date().toISOString() }
        });
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await adminRest(`profiles?stripe_customer_id=eq.${encodeURIComponent(subscription.customer)}`, {
          method: 'PATCH',
          body: { tier: null, updated_at: new Date().toISOString() }
        });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    // A non-200 makes Stripe retry later, which is what we want if the database was briefly unreachable.
    console.error('Peacho webhook handler error:', err);
    return res.status(500).send('Handler error');
  }

  res.status(200).json({ received: true });
}
