# Peacho

Peacho is a chat site. Anyone can chat as a guest with no sign-in. A free account keeps chats on every device, and a paid plan unlocks images and animation. The page is `public/index.html`. The files in `api/` run on Vercel and keep your private keys off the page.

- `api/chat.js` checks the visitor's session (guest or account), applies the daily message limit, then asks Claude. Image and animation requests also check for a paid plan.
- `api/create-checkout-session.js`, `api/webhook.js`, `api/create-portal-session.js` handle Stripe subscriptions.
- `api/_auth.js` is shared sign-in and database code.
- `supabase-setup.sql` creates the database tables.

## Setup, in order

### 1. Supabase (accounts and saved chats)
1. In your Supabase project, open **SQL Editor**, click **New query**, paste all of `supabase-setup.sql`, and click **Run**.
2. Open **Authentication**, then **Sign In / Providers**. Make sure **Email** is on.
   - For testing, turn **Confirm email** off. Supabase's built-in email sender only allows a few emails per hour, so confirmation emails stall quickly. Turn it back on once you connect your own email service under Authentication, then SMTP settings.
3. Turn on guest chat. In **Authentication → Sign In / Providers**, find **Allow anonymous sign-ins** and switch it on. Without it, nobody can chat before signing in.
4. Open **Authentication**, then **URL Configuration**. Set **Site URL** to your site address (for example `https://peacho.vercel.app`) and add the same address under **Redirect URLs**.

### 2. Vercel settings
In your Vercel project, open **Settings**, then **Environment Variables**, and add:

| Name | Value |
| --- | --- |
| `ANTHROPIC_API_KEY` | your `sk-ant-...` key |
| `SUPABASE_URL` | `https://vccxfwvgwztvboosydvt.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | your `sb_publishable_...` key |
| `SUPABASE_SECRET_KEY` | your `sb_secret_...` key (private, server only) |

Then go to **Overview**, click the **⋯** on the Production Deployment, and choose **Redeploy**.

The Supabase address and publishable key are also written near the top of `public/index.html`. Those two are safe to be public. The secret key must never go in that file.

### 3. Try it
Open your site, create an account, and send a message. Reload the page and your chats should still be there.

## Daily message limits
So costs stay predictable, the server limits messages per day. Defaults: 15 per guest, 300 for all guests combined, 40 for a signed-in account without a plan, and 400 for a paid member. Change them with the `GUEST_DAILY_LIMIT`, `GUEST_GLOBAL_DAILY_LIMIT`, `FREE_DAILY_LIMIT`, and `MEMBER_DAILY_LIMIT` settings in Vercel. Each image or animation counts as one message.

## Payments (Stripe), when you're ready
1. Make a Stripe account and add your bank account for payouts.
2. Create three monthly products ($15, $29, $49) and copy each Price ID.
3. Add `STRIPE_SECRET_KEY`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, and `STRIPE_PRICE_ULTRA` in Vercel.
4. In Stripe, open Developers, then Webhooks, and add an endpoint at `https://YOUR-SITE/api/webhook`. Send these events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
5. Copy the endpoint's signing secret into Vercel as `STRIPE_WEBHOOK_SECRET`, then redeploy.
6. Test with Stripe's test mode (keys starting `sk_test_`) and the test card `4242 4242 4242 4242` before using live keys.

## Known limits
- There is no "forgot password" screen yet.
- Guest chats stay with that browser. If a guest creates an account, their guest chats don't move over.
- Guest sessions can be created by scripts. The daily limits cap the cost, and Supabase's CAPTCHA setting (Authentication, then Attack Protection) adds more protection.
- Messages aren't limited per day. A heavy user costs you real money in Claude usage, so consider daily limits per plan before you charge people.
- Image and animation quality is stylized vector art and CSS animation, not photos or video.
