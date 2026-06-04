# Veritas -- Full Implementation Plan for Claude Code

## Project Overview

**Veritas** is the rebrand and expansion of `verify.leul.et` (currently the UI for the Verifier API). It becomes the full product home at `veritas.et`, adding premium features on top of a free-forever base.

### Two Repos Involved

| Repo | Role | Stack |
|---|---|---|
| `verifier-api` | The API backend, endpoints never change | Node.js, Express, TypeScript, Prisma, MySQL |
| `verifier-ui-t3` | The frontend, becomes `veritas.et` | Next.js (T3), NextAuth, Telegram login, shadcn/ui, Prisma, MySQL |

### Cardinal Rules

- **Never change or move any existing API endpoints.** `verifyapi.leulzenebe.pro/[endpoint]` stays forever. 413 live users depend on it.
- **Never remove free access** to existing endpoints for any API key.
- **All existing API keys get `grandfathered = true`**. Grandfathered keys bypass all feature gates permanently.
- The only new paywall is `/verify-image` for non-grandfathered FREE keys, since it costs real money (Mistral API).
- Keep open-source integrity -- no secrets in code, everything sensitive stays in `.env`.

---

## Repo 1: `verifier-api` Changes

### Step 1: Prisma Schema Migration

File: `prisma/schema.prisma`

**Change `ApiTier` enum** (already exists, just extend):
```prisma
enum ApiTier {
  FREE
  PRO
  BUSINESS
}
```

**Add to existing `ApiKey` model:**
```prisma
model ApiKey {
  // ... all existing fields stay exactly as-is ...
  grandfathered   Boolean           @default(false)
  Webhook         Webhook[]
  CheckoutSession CheckoutSession[]
}
```

**Add new models at the bottom of schema:**
```prisma
model Webhook {
  id         String            @id @default(cuid())
  apiKeyId   String
  apiKey     ApiKey            @relation(fields: [apiKeyId], references: [id], onDelete: Cascade)
  url        String
  events     Json
  active     Boolean           @default(true)
  createdAt  DateTime          @default(now())
  deliveries WebhookDelivery[]

  @@index([apiKeyId])
}

model WebhookDelivery {
  id         String   @id @default(cuid())
  webhookId  String
  webhook    Webhook  @relation(fields: [webhookId], references: [id], onDelete: Cascade)
  payload    Json
  statusCode Int?
  success    Boolean
  attempts   Int      @default(1)
  createdAt  DateTime @default(now())

  @@index([webhookId])
}

model CheckoutSession {
  id                String         @id @default(cuid())
  apiKeyId          String
  apiKey            ApiKey         @relation(fields: [apiKeyId], references: [id])
  productName       String
  expectedAmount    Float
  merchantAccount   String
  acceptedProviders Json
  redirectUrl       String
  webhookUrl        String?
  status            CheckoutStatus @default(PENDING)
  paidReference     String?
  createdAt         DateTime       @default(now())
  expiresAt         DateTime

  @@index([apiKeyId])
  @@index([status])
}

enum CheckoutStatus {
  PENDING
  PAID
  EXPIRED
}
```

**After running `prisma migrate dev`, run this one-time SQL:**
```sql
UPDATE ApiKey SET grandfathered = true;
```
This ensures every existing key bypasses all future feature gates permanently.

---

### Step 2: Rate Limiting Middleware

File: `src/middleware/rateLimiter.ts` (new file)

Create a per-API-key rate limiter that reads the key's tier from the database and applies the appropriate limit:

| Tier | Requests/min |
|---|---|
| FREE (non-grandfathered) | 10 |
| FREE (grandfathered) | 30 |
| PRO | 60 |
| BUSINESS | 300 |

Use an in-memory store (e.g. a `Map` keyed by API key ID with a sliding window counter). Do not add a new npm dependency for this -- implement it simply.

Apply this middleware to all `/verify-*` and `/verify` routes, after the existing API key auth middleware.

---

### Step 3: Image Verification Gate

File: `src/middleware/tierGate.ts` (new file)

Create middleware that gates `/verify-image` specifically:

```
if (apiKey.tier === 'FREE' && apiKey.grandfathered === false) {
  return 402 with JSON:
  {
    "error": "Image verification requires a Pro or Business plan.",
    "upgrade": "https://veritas.et/dashboard/billing"
  }
}
```

Apply only to the `/verify-image` route, after the auth middleware. All other endpoints remain open to all tiers.

---

### Step 4: Batch Verification Endpoint

File: `src/routes/verifyBatch.ts` (new file)

**Route:** `POST /verify-batch`
**Auth:** Requires API key (existing auth middleware)
**Tier gate:** PRO and BUSINESS only (return 402 for FREE keys)

**Request body:**
```json
{
  "references": [
    { "reference": "FT253089F68Z", "suffix": "16825193" },
    { "reference": "CE2513001XYT" },
    { "reference": "DASHEN_REF_123456789012345" }
  ]
}
```

**Behavior:**
- Max 20 references per batch (return 400 if exceeded)
- Run all verifications concurrently via `Promise.allSettled`
- Use the existing smart router logic (`/verify`) for each reference internally -- do not duplicate provider detection logic, call it as a function
- Return partial results -- if some fail, return what succeeded

**Response:**
```json
{
  "success": true,
  "total": 3,
  "succeeded": 2,
  "failed": 1,
  "results": [
    { "index": 0, "success": true, "reference": "FT253089F68Z", "data": { ... } },
    { "index": 1, "success": true, "reference": "CE2513001XYT", "data": { ... } },
    { "index": 2, "success": false, "reference": "DASHEN_REF_123456789012345", "error": "Transaction not found" }
  ]
}
```

Log each individual verification in `UsageLog` as normal (each reference = one log entry under the same API key).

---

### Step 5: Checkout Session Endpoints

File: `src/routes/checkout.ts` (new file)

**All routes require API key auth. Checkout sessions are PRO+ only.**

#### `POST /checkout/sessions`
Create a new checkout session.

**Request:**
```json
{
  "productName": "Premium Access",
  "expectedAmount": 199,
  "merchantAccount": "0912345678",
  "acceptedProviders": ["telebirr", "cbe"],
  "redirectUrl": "https://theirapp.com/success",
  "webhookUrl": "https://theirapp.com/webhook",
  "expiresInMinutes": 60
}
```

**Behavior:**
- Validate all fields
- `merchantAccount` must be a valid Telebirr number (251 format or 09 format) or CBE account number -- basic format validation only, not ownership check
- `expectedAmount` must be > 0
- `expiresInMinutes` default 60, max 1440 (24h)
- Generate `cuid()` as session ID
- Store in `CheckoutSession` table
- Return the hosted checkout URL

**Response:**
```json
{
  "sessionId": "clxxxxx",
  "checkoutUrl": "https://veritas.et/c/clxxxxx",
  "expiresAt": "2026-05-29T11:00:00Z"
}
```

#### `GET /checkout/sessions`
List all checkout sessions for the authenticated API key.

**Response:** Array of sessions with status, amount, productName, createdAt, expiresAt, paidReference.

#### `GET /checkout/sessions/:id`
Get a single session by ID. Returns 404 if not found or doesn't belong to the API key.

#### `POST /checkout/sessions/:id/confirm`
**Public endpoint -- no API key required.** This is called by the hosted checkout page when an end user submits their payment reference.

**Request:**
```json
{
  "reference": "CE2513001XYT",
  "provider": "telebirr"
}
```

**Behavior:**
1. Look up the session by ID -- return 404 if not found
2. Check session is `PENDING` -- return 400 if already `PAID` or `EXPIRED`
3. Check `expiresAt` -- if past, mark as `EXPIRED` and return 400
4. Call the appropriate internal verify function (same logic as `/verify` smart router) using the session's own API key for logging
5. Validate result:
   - `result.success === true`
   - `result.settledAmount >= session.expectedAmount` (use `settledAmount` for Telebirr, `transactionAmount` for CBE/Dashen -- map appropriately per provider)
   - The credited account matches `session.merchantAccount` (check `creditedPartyAccount` for Telebirr, receiver account for CBE)
6. If valid: mark session `PAID`, store `paidReference`, fire webhook if configured
7. Return:
```json
{
  "success": true,
  "redirectUrl": "https://theirapp.com/success"
}
```

**Webhook firing (after confirm):**
If session has a `webhookUrl`, fire a POST to it:
```json
{
  "event": "checkout.paid",
  "sessionId": "clxxxxx",
  "productName": "Premium Access",
  "paidAmount": 199,
  "paidReference": "CE2513001XYT",
  "provider": "telebirr",
  "paidAt": "2026-05-29T10:32:00Z"
}
```
Fire and forget -- do not block the confirm response on webhook delivery. Log the attempt in `WebhookDelivery`. Retry up to 3 times with exponential backoff (5s, 15s, 45s) in the background using `setTimeout` chains -- no additional queue dependency needed for now.

---

### Step 6: Webhook Management Endpoints

File: `src/routes/webhooks.ts` (new file)

**All routes require API key auth. Webhooks are PRO+ only.**

#### `POST /webhooks`
Register a webhook URL.
```json
{
  "url": "https://theirapp.com/webhook",
  "events": ["checkout.paid", "verification.success", "verification.failed"]
}
```
Max 5 webhooks per API key. Return 400 if exceeded.

#### `GET /webhooks`
List all webhooks for the API key with delivery stats (total deliveries, success rate).

#### `DELETE /webhooks/:id`
Deactivate and delete a webhook.

#### `GET /webhooks/:id/deliveries`
List recent delivery attempts for a webhook (last 100, paginated).

#### `POST /webhooks/:id/retry/:deliveryId`
Manually retry a failed delivery.

---

### Step 7: Admin Endpoint Updates

Add to existing `/admin/stats`:
- Total checkout sessions (by status)
- Total webhook deliveries (success vs. failed)
- Revenue estimate (count of PRO and BUSINESS keys × their monthly price)

---

## Repo 2: `verifier-ui-t3` Changes

### Overview of New Pages

```
veritas.et/                          → Landing page (Phase 7, build last)
veritas.et/dashboard                 → Usage charts (existing, enhance)
veritas.et/dashboard/billing         → Upgrade via Telebirr/CBE
veritas.et/dashboard/checkout        → Checkout session builder + list
veritas.et/dashboard/webhooks        → Webhook management
veritas.et/c/[id]                    → Public hosted checkout page
veritas.et/docs                      → API docs (existing, update)
veritas.et/status                    → Status page (existing)
```

---

### Step 8: Environment Variables

Add to `.env`:
```env
# Veritas Pay -- your own accounts for billing upgrades
VERITAS_TELEBIRR_ACCOUNT=2519XXXXXXXX
VERITAS_CBE_ACCOUNT=XXXXXXXXXXXXXXXX
VERITAS_PRO_PRICE=199
VERITAS_BUSINESS_PRICE=499

# Internal API connection
VERIFIER_API_URL=https://verifyapi.leulzenebe.pro
VERIFIER_API_ADMIN_KEY=your_admin_key

# Public URL
NEXT_PUBLIC_APP_URL=https://veritas.et
```

---

### Step 9: Billing Page

File: `src/app/dashboard/billing/page.tsx`

**Layout:**
- Current plan badge (FREE / PRO / BUSINESS)
- If grandfathered, show a note: "You have legacy free access. Upgrading adds premium features."
- Two plan cards: Pro (199 ETB/mo) and Business (499 ETB/mo)
- Each card lists what's included

**Upgrade flow (client component):**
1. User clicks "Upgrade to Pro"
2. Modal opens showing:
   - "Send exactly 199 ETB to:"
   - Telebirr: `[VERITAS_TELEBIRR_ACCOUNT]`
   - CBE: `[VERITAS_CBE_ACCOUNT]`
   - Warning: "Amount must match exactly"
3. Reference input field + provider selector (Telebirr / CBE)
4. "Confirm Payment" button
5. On submit: call internal Next.js API route `POST /api/billing/upgrade`

**API route:** `src/app/api/billing/upgrade/route.ts`
- Auth: require NextAuth session
- Body: `{ reference, provider, targetTier }`
- Call `@creofam/verifier` SDK to verify the reference
- Validate:
  - `result.success === true`
  - `result.settledAmount >= expectedAmount` (based on `targetTier`)
  - `result.creditedPartyAccount` or `result.creditedPartyTelebirrNo` matches your configured account
- If valid: call Verifier API admin endpoint to upgrade the user's API key tier
- Return success or descriptive error

**Error states to handle:**
- Reference already used (track in a simple `BillingPayment` table or check `UsageLog`)
- Amount doesn't match
- Wrong recipient account
- Verification failed (transaction not found)

---

### Step 10: Usage Dashboard Enhancement

File: `src/app/dashboard/page.tsx` (enhance existing)

Add to the existing dashboard:
- **Requests over time** -- line chart (last 30 days), pulling from `UsageLog` via an API route
- **By endpoint** -- bar chart showing which endpoints are called most
- **Success rate** -- percentage of `statusCode < 400` responses
- **Current month usage** -- count vs. tier limit (show ∞ for grandfathered/BUSINESS)

Use `recharts` for charts (already available in T3 stack context).

API route: `src/app/api/dashboard/stats/route.ts`
- Require NextAuth session
- Fetch `UsageLog` entries for the user's API keys filtered by `createdAt >= startOfMonth`
- Group and aggregate server-side, return clean JSON for the charts

---

### Step 11: Checkout Builder

File: `src/app/dashboard/checkout/page.tsx`

**Two sections:**

**1. Create Checkout Session form:**
- Product name (text input)
- Amount in ETB (number input, min 1)
- Merchant account (their Telebirr or CBE account that will receive payment)
- Accepted providers (multi-checkbox: Telebirr, CBE, Dashen, Abyssinia, CBE Birr)
- Redirect URL (text input, must be valid URL)
- Webhook URL (optional, text input)
- Expires in (select: 30 min / 1 hour / 6 hours / 24 hours)
- Submit → `POST /checkout/sessions` via the Verifier API using their API key
- On success: show the generated URL with a copy button and a QR code (use `qrcode.react`)

**2. Sessions list table:**
- Columns: Product, Amount, Status (badge), Created, Expires, Reference (if paid), Link (copy button)
- Status badges: PENDING (yellow), PAID (green), EXPIRED (grey)
- Paginated, newest first
- Pulls from `GET /checkout/sessions`

---

### Step 12: Webhook Management Page

File: `src/app/dashboard/webhooks/page.tsx`

**Two sections:**

**1. Register webhook form:**
- URL input
- Event checkboxes: `checkout.paid`, `verification.success`, `verification.failed`
- Submit → `POST /webhooks`

**2. Webhooks list:**
- Each webhook shows URL, events, active status toggle, delete button
- Expandable row shows recent deliveries (status code, timestamp, success badge, retry button)
- Pulls from `GET /webhooks` and `GET /webhooks/:id/deliveries`

---

### Step 13: Hosted Checkout Page

File: `src/app/c/[id]/page.tsx`

**Public page -- no auth required.**

This is what the end user (the merchant's customer) sees.

**Layout:**
- Product name and amount (large, clear)
- Payment instructions:
  - "Send [amount] ETB to [merchantAccount]"
  - Show accepted providers with their logos/icons
  - QR code of the merchant account (nice to have)
- Reference input + provider selector dropdown
- "Confirm Payment" button

**On submit:**
- POST to `POST /checkout/sessions/:id/confirm` on the Verifier API
- Loading state while verifying
- On success: show a brief success message, then redirect to `redirectUrl` after 2 seconds
- On failure: show descriptive error (wrong amount, wrong recipient, not found, already paid)

**Edge cases:**
- If session is already PAID: show "This payment has already been confirmed"
- If session is EXPIRED: show "This payment link has expired"
- If session not found: show 404

**Design:** Make this page clean and trustworthy. It will be seen by non-technical end users. Keep it simple: logo, product info, payment instructions, input, button. No nav, no clutter.

---

### Step 14: Landing Page (Build Last)

File: `src/app/page.tsx` (replace existing home)

Build this after all features are live so it describes real things.

**Sections in order:**

1. **Hero** -- "The payment verification infrastructure for Ethiopian developers." CTA: "Get free API key" + "View docs"

2. **Social proof bar** -- "11.1M+ verifications" / "413+ developers" / "6 payment providers" / "1 year of free access"

3. **How it works** -- Three steps: Pay on your platform → Get reference number → Verify instantly. Simple diagram.

4. **Providers** -- CBE, Telebirr, Dashen, Bank of Abyssinia, CBE Birr, M-Pesa logos/cards

5. **Products**
   - **The API** -- Free forever. Verify any Ethiopian payment in one call.
   - **Veritas Pay** -- Hosted checkout pages. Accept payments without a business license.
   - **Pro features** -- Batch verification, higher rate limits, webhook notifications.

6. **Live demo** -- Paste a real reference number, pick a provider, see the result inline. Calls your actual API.

7. **Pricing** -- Free (forever) / Pro 199 ETB/mo / Business 499 ETB/mo. Feature comparison table.

8. **Footer** -- Links to docs, GitHub, status page. "Built by Leul Zenebe / Creofam LLC"

**Style:** GSAP ScrollTrigger for section entrances. Dark theme. Use existing shadcn/ui components. Keep animations purposeful, not decorative.

---

## Build Order for Claude Code

Work in this exact sequence. Each phase is independently shippable:

### Phase 0 -- Infrastructure (no code)
- [ ] Buy `veritas.et`
- [ ] Add to Coolify, point DNS
- [ ] Deploy existing `verifier-ui-t3` at `veritas.et`
- [ ] Set `verify.leul.et` → 301 redirect

### Phase 1 -- API Schema & Gates
- [ ] Update Prisma schema (add `grandfathered`, `Webhook`, `WebhookDelivery`, `CheckoutSession`)
- [ ] Run migration
- [ ] Run one-time SQL to set all existing keys to `grandfathered = true`
- [ ] Add rate limiting middleware
- [ ] Add `/verify-image` tier gate

### Phase 2 -- Billing Page
- [ ] Add env vars for your own Telebirr/CBE accounts and prices
- [ ] Build `dashboard/billing/page.tsx`
- [ ] Build `api/billing/upgrade/route.ts`
- [ ] Test full flow end-to-end on staging

### Phase 3 -- Usage Dashboard
- [ ] Build `api/dashboard/stats/route.ts`
- [ ] Enhance `dashboard/page.tsx` with charts

### Phase 4 -- Batch Verification
- [ ] Build `POST /verify-batch` endpoint on API
- [ ] Add to API docs page

### Phase 5 -- Veritas Pay
- [ ] Build checkout session endpoints on API (`/checkout/sessions/*`)
- [ ] Build `dashboard/checkout/page.tsx`
- [ ] Build public `c/[id]/page.tsx`
- [ ] Wire confirm flow with internal verification + webhook firing

### Phase 6 -- Webhooks
- [ ] Build webhook management endpoints on API
- [ ] Build `dashboard/webhooks/page.tsx`
- [ ] Wire webhook firing into checkout confirm flow

### Phase 7 -- Landing Page
- [ ] Build new `app/page.tsx`
- [ ] Add GSAP animations
- [ ] Wire live demo section to real API

---

## Key Technical Notes for Claude Code

- **Provider field mapping:** Different providers return different field names for amount and recipient. When validating checkout payments, map correctly:
  - Telebirr: `settledAmount`, `creditedPartyTelebirrNo` or `creditedPartyName`
  - CBE: `transactionAmount`, receiver account field
  - Dashen: `transactionAmount`, `receiverName`
  - Abyssinia: check actual response fields from the codebase
  - Always compare amounts with `>=` not `===` to handle fee edge cases

- **Reference deduplication for billing:** Before upgrading a key based on a payment reference, check that the same reference hasn't been used for a previous upgrade. Store successful billing payments in a table or check for duplicates.

- **Webhook security:** When firing webhooks to external URLs, add a signature header so recipients can verify the payload came from Veritas:
  ```
  X-Veritas-Signature: sha256=HMAC(secret, JSON.stringify(payload))
  ```
  The webhook secret is shown once on registration and stored hashed.

- **Checkout page UX:** The `c/[id]` page must work well on mobile. Most end users will be on phones. Large tap targets, clear instructions, minimal inputs.

- **Expiry cleanup:** Add a simple cron-style check -- when a session is fetched and `expiresAt` is in the past and status is still `PENDING`, mark it `EXPIRED` at read time. No separate cleanup job needed initially.

- **`@creofam/verifier` SDK usage in the UI:** Use it in the billing upgrade API route to verify payments to Veritas itself. Do not expose your own account validation env vars to the client side.

- **All monetary amounts in ETB as floats.** No currency conversion needed.

- **MySQL JSON columns:** Prisma handles `Json` type as `TEXT` in MySQL. That's fine for `events` arrays and `acceptedProviders`. Parse carefully on read.
