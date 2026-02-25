# 📦 Changelog

All notable changes to this project will be documented in this file.

---

## [3.0.1] - 2026-02-25

### 🚀 Improved

- **Telebirr Proxy Upgrades**: The core `fetchFromProxySource` logic now properly traps `ETIMEDOUT` / `ECONNABORTED` and translates them into an HTTP 502 with contextual error messages down to the API client, instead of surfacing a generic 404 or hanging silently.
- **Upgraded PHP Proxy (`verify.php`)**: Rewrote the fallback Ethiotelecom request engine from `file_get_contents` to `cURL`. Now explicit SSL Certificate errors and connection timeouts from Ethiotelecom are properly trapped and returned as JSON to the node backend, and then to the user.
- **Secured PHP Proxy**: added a `key` parameter requirement to `verify.php`, mimicking the M-Pesa implementation to stop unauthorized public access.

---

## [3.0.0] - 2026-02-22

### 🚀 Added

- **Universal Verification Endpoint (`POST /verify`)**: A smart router that dynamically detects the payment provider (CBE, Telebirr, Dashen, Bank of Abyssinia, CBE Birr) based on the reference number structure and payload, simplifying client integrations.

### ♻️ Changed

- Promoted Universal Router `POST /verify` endpoint as the highlighted/recommended method in primary documentation.

---

## [2.1.1] - 2026-02-21

### 🚀 Added

- Add new M-Pesa verification endpoint with API integration and PDF parsing.
- Update Postman collection to include M-Pesa endpoints.

### 💾 Database Schema Updates (Important)

- Added `keyHash`, `prefix`, `tier`, and `userId` relational mapping to the `ApiKey` model for enhanced security and identity management.
- Added `createdAt` tracking to the `User` model.
- **Note for contributors:** Because of these schema changes, anyone cloning or pulling the repository must run `pnpm prisma db push` (or `npx prisma db push`) to synchronize their local database.

### 🐛 Fixed & improved

- Increase timeout for Telebirr verification to handle proxy retry logic.
- Implement retry mechanism for Dashen receipt fetching with 5 attempts.
- Update CBE Birr PDF parsing to handle actual document structure.
- Increase wait time for CBE PDF detection from 3s to 6s.
- Resolved a bug where the `verifyCBEBirr` service would fail implicitly if an API key was not explicitly provided through the inner service layer.
- Fixed an issue causing unhandled promise rejections to crash the development server silently during Prisma initialization on Windows.
- Fixed Express route precedence order to prevent the new `/verify` route from swallowing explicit `/verify-*` prefix calls (e.g. `/verify-image`).

---

## [2.1.0] - 2025-11-13

### Added

- Telebirr: Return `bankName` in receipt payloads.

### Changed

- Bump API version to `2.1.0` in package.json, root endpoint, README, Postman collection.

## [1.1.0] - 2025-05-18

> This release introduces the first major backend expansion: transitioning from a fully in-memory system to a database-powered API with authentication, stats, and admin tools.

### 🚀 Added

- 🔐 **API Key Authentication**
  - All verification endpoints (except `/` and `/health`) now require a valid API key.
  - Keys are stored in a Prisma-managed MySQL database.
  - Requests without valid keys are denied with a 401/403 error.

- ⚙️ **Admin Routes**
  - `POST /admin/api-keys`: Generate a new API key.
  - `GET /admin/api-keys`: View all active/used keys (securely abbreviated).
  - `GET /admin/stats`: View endpoint usage, response times, and request logs.

- 📊 **Usage Statistics Logging**
  - Each request is logged to a `UsageLog` table with:
    - API key ID
    - Endpoint
    - Method
    - Response time
    - Status code
    - IP address
  - Statistics are cached in-memory and pulled from the DB for admin views.

- 🛠 **Prisma + MySQL Integration**
  - Introduced full Prisma schema and MySQL connection to persist:
    - API keys
    - Usage logs

- 📁 **API Versioning Support**
  - Branch `api-keys-introduced` now tracks this new release.
  - Tagged as version `v1.1.0` in `package.json`.

### 🧹 Changed

- 🧠 Moved all key storage and logic from in-memory Maps to persistent DB.
- 🔄 `requestLogger` middleware now uses `res.on('finish')` for accurate response timing and DB writes.

### 🛡️ Security

- Admin routes are protected using `x-admin-key` headers.
- API keys are validated per request, and rate-limiting can be layered on in the future.

---

## [1.0.0] - 2025-05-12

> Initial release of the Payment Verifier API.

### ✨ Features

- ✅ **CBE Verification** via reference and suffix using Puppeteer and PDF parsing.
- ✅ **Telebirr Verification** using raw reference scraping.
- ✅ **Image-Based Verification** powered by **Mistral AI**, detecting CBE or Telebirr receipts.
- 🧪 Express API with simple `POST` endpoints:
  - `/verify-cbe`
  - `/verify-telebirr`
  - `/verify-image`
- 🔍 In-memory statistics and logging.

---
