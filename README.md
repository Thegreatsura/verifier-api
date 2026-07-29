# 📄 Payment Verification API

This API provides verification services for payment transactions made through **Commercial Bank of Ethiopia (CBE)**, **Telebirr**, **Dashen Bank**, **Bank of Abyssinia**, **CBE Birr**, and **M-Pesa** mobile payment platforms in Ethiopia.  
It allows applications to verify the authenticity and details of payment receipts by reference numbers or uploaded images.

> ⚠️ **Disclaimer**: This is **not an official API**. I am **not affiliated with Ethio Telecom, Telebirr, or Commercial Bank of Ethiopia (CBE)**. This tool is built for personal and developer utility purposes only and scrapes publicly available data.

---

## ✅ Features

### 🚀 Universal Verification (Smart Router)

- **One endpoint to rule them all:** Verifies transactions from multiple providers (CBE, Telebirr, Dashen, Bank of Abyssinia, CBE Birr) using a single, intelligent endpoint (`POST /verify`). _Note: M-Pesa is currently supported via its dedicated endpoint only._
- Automatically detects the provider based on the format of the provided `reference` number and accompanying JSON payload.
- Strictly validates payloads and intelligently delegates to the correct backend service.

### 🔷 CBE Payment Verification

- Verifies CBE bank transfers using reference number and account suffix
- Extracts key payment details:
  - Payer name and account
  - Receiver name and account
  - Transaction amount
  - Payment date and time
  - Reference number
  - Payment description/reason

### 🔶 Telebirr Payment Verification

- Verifies Telebirr mobile money transfers using a reference number
- Extracts key transaction details:
  - Payer name and Telebirr number
  - Credited party name and account
  - Bank name (if the transaction was made to another bank)
  - Transaction status
  - Receipt number
  - Payment date
  - Settled amount
  - Service fees and VAT
  - Total paid amount

### 🔷 Dashen Bank Payment Verification

- Verifies Dashen bank transfers using reference number
- Extracts comprehensive transaction details:
  - Sender name and account number
  - Transaction channel and service type
  - Narrative/description
  - Receiver name and phone number
  - Institution name
  - Transaction and transfer references
  - Transaction date and amount
  - Service charges, taxes, and fees breakdown
  - Total amount

### 🔶 Bank of Abyssinia Payment Verification

- Verifies Bank of Abyssinia transfers using reference number and 5-digit suffix
- Extracts key transaction details:
  - Transaction reference and details
  - Account information
  - Payment amounts and dates
  - Verification status

### 🔷 M-Pesa Payment Verification

- Verifies M-Pesa mobile money transfers using receipt reference
- Extracts transaction details from the generated receipt PDFs

### 🔷 CBE Birr Payment Verification

- Verifies CBE Birr mobile money transfers using receipt number and phone number
- Extracts transaction details:
  - Receipt and transaction information
  - Payer and receiver details
  - Transaction amounts and fees
  - Payment status and timestamps
  - Ethiopian phone number validation (251 format)

### 🔷 Image-based Payment Verification

- Verifies payments by analyzing uploaded receipt images
- Uses **Mistral AI** to detect receipt type and extract transaction details
- Supports both **CBE** and **Telebirr** receipt screenshots

---

## 🌐 Hosting Limitations for `verify-telebirr` and `verify-mpesa`

Due to **regional restrictions** by the Telebirr system and Safaricom M-Pesa, hosting these endpoints outside of Ethiopia/Kenya (e.g., on a foreign VPS like Hetzner or AWS) may result in failed receipt verification. Specifically:

- Telebirr’s receipt pages (`https://transactioninfo.ethiotelecom.et/receipt/[REFERENCE]`) often **block or timeout** requests made from foreign IP addresses.
- Safaricom's M-Pesa API (`https://m-pesabusiness.safaricom.et/api/receipt/getReceipt`) strictly blocks connections from foreign data centers, resulting in `504 Gateway Timeout` or `500 Internal Server Errors`.

### ❌ Affected:

- VPS or cloud servers located outside Ethiopia/Kenya

### ✅ Works Best On:

- Ethiopian-hosted servers (e.g., Ethio Telecom web hosting, TeleCloud VPS)
- Developers self-hosting the code on infrastructure based in Ethiopia

#### 🛠 Proxy Support:

This project supports secondary fallback verification relays hosted inside Ethiopia. When the primary `verify-telebirr` or `verify-mpesa` fetch fails on your foreign VPS, the server can **fallback to our proxy** to complete the verification.
A standalone `mpesa.php` file is included in the `.github` / repository root which can be easily hosted on any cheap generic cPanel host inside Ethiopia to act as your own private proxy.

For best results and full control, clone the repository and **self-host the main Node.js application from inside Ethiopia**.

---

### 🔁 Skip Primary Verifier (For VPS Users)

If you know your environment cannot access the primary endpoint, set the following in your `.env`:

```env
SKIP_PRIMARY_VERIFICATION=true
```

This will skip the primary Telebirr receipt fetch entirely and go straight to the fallback proxy — only for your local use case. Other users can still benefit from both layers.

---

## ⚙️ Installation

```bash
# Clone the repository
git clone https://github.com/Vixen878/verifier-api

# Navigate to the project directory
cd verifier-api

# Install dependencies
pnpm install
```

---

## 🧪 Usage

### 🛠 Development

```bash
pnpm dev
```

### 🚀 Production Build

```bash
pnpm build
pnpm start
```

---

## 📡 API Endpoints

### 🚀 Universal Verification (Smart Router)

#### `POST /verify`

Verify a payment from multiple providers using a single endpoint. The API automatically detects the provider based on the reference format and accompanying payload.

**Requires API Key**

**Request Body:**

```json
{
  "reference": "REQUIRED_REFERENCE_STRING",
  "suffix": "OPTIONAL_SUFFIX_FOR_CBE_OR_ABYSSINIA",
  "phoneNumber": "OPTIONAL_PHONE_FOR_CBEBIRR"
}
```

**Sorting Rules:**

- **Dashen Bank**: `reference` must be 16 chars starting with 3 digits. No extra params.
- **CBE**: `reference` must be 12 chars starting with `FT`. Requires 8-digit `suffix`.
- **Bank of Abyssinia**: `reference` must be 12 chars starting with `FT`. Requires 5-digit `suffix`.
- **CBE Birr**: `reference` must be 10 alphanumeric chars. Requires 10-12 digit `phoneNumber`.
- **Telebirr**: `reference` must be 10 alphanumeric chars. No extra params.

---

### ✅ CBE Verification

#### `POST /verify-cbe`

Verify a CBE payment using a reference number and account suffix.

**Requires API Key**

**Request Body:**

```json
{
  "reference": "REFERENCE_NUMBER",
  "accountSuffix": "ACCOUNT_SUFFIX"
}
```

---

### ✅ Telebirr Verification

#### `POST /verify-telebirr`

Verify a Telebirr payment using a reference number.

**Requires API Key**

**Request Body:**

```json
{
  "reference": "REFERENCE_NUMBER"
}
```

---

### ✅ Dashen Bank Verification

#### `POST /verify-dashen`

Verify a Dashen bank payment using a reference number.

**Requires API Key**

**Request Body:**

```json
{
  "reference": "DASHEN_REFERENCE_NUMBER"
}
```

**Response:**

```json
{
  "success": true,
  "senderName": "John Doe",
  "senderAccountNumber": "1234567890",
  "transactionChannel": "Mobile Banking",
  "serviceType": "Fund Transfer",
  "narrative": "Payment for services",
  "receiverName": "Jane Smith",
  "phoneNo": "251912345678",
  "transactionReference": "TXN123456",
  "transactionDate": "2023-06-15T10:30:00Z",
  "transactionAmount": 1000.0,
  "serviceCharge": 5.0,
  "total": 1005.0
}
```

---

### ✅ Bank of Abyssinia Verification

#### `POST /verify-abyssinia`

Verify a Bank of Abyssinia payment using a reference number and 5-digit suffix.

**Requires API Key**

**Request Body:**

```json
{
  "reference": "ABYSSINIA_REFERENCE",
  "suffix": "12345"
}
```

**Note:** The suffix must be exactly 5 digits.

---

### ✅ M-Pesa Verification

#### `POST /verify-mpesa`

Verify an M-Pesa payment using a receipt number (reference).

**Requires API Key**

**Request Body:**

```json
{
  "receiptNumber": "RECEIPT_REFERENCE"
}
```

---

### ✅ CBE Birr Verification

#### `POST /verify-cbebirr`

Verify a CBE Birr payment using receipt number and phone number.

**Requires API Key**

**Request Body:**

```json
{
  "receiptNumber": "RECEIPT_NUMBER",
  "phoneNumber": "251912345678"
}
```

**Note:** Phone number must be in Ethiopian format (251 + 9 digits).

---

### ✅ Image Verification

#### `POST /verify-image`

**Requires API Key**

Verify a payment by uploading an image of the receipt. This endpoint supports both CBE and Telebirr screenshots.

**Request Body:**
Multipart form-data with an image file.

- Optional Query Param: `?autoVerify=true`  
  When enabled, the system detects the receipt type and routes it to the correct verification flow automatically.
- **Note**: If the auto-detected receipt is from CBE, the request **must** include your `Suffix` (last 8 digits of your account).

---

## 🧪 Try It (Sample cURL Commands)

### 🚀 Universal Smart Router

```bash
curl -X POST https://verifyapi.leulzenebe.pro/verify \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reference": "FT253089F68Z", "suffix": "16825193" }'
```

### ✅ CBE

```bash
curl -X POST https://verifyapi.leulzenebe.pro/verify-cbe \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reference": "FT2513001V2G", "accountSuffix": "39003377" }'
```

### ✅ Telebirr

```bash
curl -X POST https://verifyapi.leulzenebe.pro/verify-telebirr \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reference": "CE2513001XYT" }'
```

### ✅ Dashen Bank

```bash
curl -X POST https://verifyapi.leulzenebe.pro/verify-dashen \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reference": "DASHEN_REFERENCE_NUMBER" }'
```

### ✅ Bank of Abyssinia

```bash
curl -X POST https://verifyapi.leulzenebe.pro/verify-abyssinia \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reference": "ABYSSINIA_REFERENCE", "suffix": "12345" }'
```

### ✅ CBE Birr

```bash
curl -X POST https://verifyapi.leulzenebe.pro/verify-cbebirr \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "receiptNumber": "RECEIPT_NUMBER", "phoneNumber": "251912345678" }'
```

### ✅ M-Pesa

```bash
curl -X POST https://verifyapi.leulzenebe.pro/verify-mpesa \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "receiptNumber": "RECEIPT_REFERENCE" }'
```

### ✅ Image

```bash
curl -X POST https://verifyapi.leulzenebe.pro/verify-image?autoVerify=true \
  -H "x-api-key: YOUR_API_KEY" \
  -F "file=@yourfile.jpg" \
  -F "suffix=39003377"
```

---

### ✅ Health Check

#### `GET /health`

Check if the API is running properly.

**No API Key Required**

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2023-06-15T12:34:56.789Z"
}
```

---

### ✅ API Information

#### `GET /`

Get information about the API and available endpoints.

**Response:**

```json
{
  "message": "Verifier API is running",
  "version": "2.1.0",
  "endpoints": [
    "/verify-cbe",
    "/verify-telebirr",
    "/verify-dashen",
    "/verify-abyssinia",
    "/verify-cbebirr",
    "/verify-image"
  ],
  "health": "/health",
  "documentation": "https://github.com/Vixen878/verifier-api"
}
```

---

## 🔐 API Authentication `new`

All verification endpoints require a valid API key.  
Pass the key using either:

- Header: `x-api-key: YOUR_API_KEY`
- Query: `?apiKey=YOUR_API_KEY`

To **generate an API key**, visit: [https://verify.leul.et](https://verify.leul.et)

---

## 📡 Public Endpoint Access

Use your API key to call endpoints from:

```
https://verifyapi.leulzenebe.pro/[endpoint]
```

API Documentation: [https://verify.leul.et/docs](https://verify.leul.et/docs)

---

## 🛠 Admin Endpoints

> Requires `x-admin-key` in header (from your environment config).

### `POST /admin/api-keys`

Generate a new API key.

```json
{
  "owner": "your-identifier"
}
```

### `GET /admin/api-keys`

List existing API keys (masked view).

### `GET /admin/stats`

Retrieve usage statistics:

- Request count by endpoint
- Success/failure ratio
- Average response time
- Requests by IP

---

## 🔐 Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
PORT=3001
NODE_ENV=development # or production
LOG_LEVEL=info       # or debug, error
MISTRAL_API_KEY=your_mistral_api_key # Required for image verification
SKIP_PRIMARY_VERIFICATION=false      # Set to true to bypass primary fetch
```

You can get an API key for Mistral AI from [https://mistral.ai/](https://mistral.ai/)

---

## 📝 Logging

- Uses [`winston`](https://github.com/winstonjs/winston) for structured logging.
- Log files are stored under the `logs/` directory:
  - `logs/error.log` – error-level logs
  - `logs/combined.log` – all logs including debug/info
- `debug` logs are **only visible in development** mode (`NODE_ENV !== 'production'`).

To override log level manually:

```env
LOG_LEVEL=debug
```

---

## 📦 Endpoint Summary

| Method | Endpoint            | Auth | Description                                      |
| ------ | ------------------- | ---- | ------------------------------------------------ |
| POST   | `/verify-cbe`       | ✅   | CBE transaction by reference + suffix            |
| POST   | `/verify-telebirr`  | ✅   | Telebirr receipt by reference                    |
| POST   | `/verify-dashen`    | ✅   | Dashen bank transaction by reference             |
| POST   | `/verify-abyssinia` | ✅   | Abyssinia bank transaction by reference + suffix |
| POST   | `/verify-cbebirr`   | ✅   | CBE Birr transaction by receipt + phone          |
| POST   | `/verify`           | ✅   | Smart universal verification router              |
| POST   | `/verify-image`     | ✅   | Image upload for receipt OCR                     |
| GET    | `/health`           | ❌   | Health check                                     |
| GET    | `/`                 | ❌   | API metadata                                     |
| GET    | `/admin/stats`      | 🔐   | API usage stats                                  |
| GET    | `/admin/api-keys`   | 🔐   | List all API keys                                |
| POST   | `/admin/api-keys`   | 🔐   | Generate API key                                 |

---

## 🧰 Technologies Used

- Node.js with Express
- TypeScript
- Axios – HTTP requests
- Cheerio – HTML parsing
- Puppeteer – headless browser automation (used for CBE scraping)
- Winston – structured logging
- Prisma + MySQL (persistent storage)
- Mistral AI – OCR for image-based verification

---

## 🛠 Prisma Integration

- `apiKey` model stores API key, usage count, owner, timestamps.
- `usageLog` model stores every request metadata:
  - endpoint, method, status code, duration, IP, API key ID

Stats are used for `/admin/stats` endpoint and dashboard monitoring.

---

## 📄 License

MIT License — see the [LICENSE](./LICENSE) file for details.

---

## 👤 Maintainer

**Leul Zenebe**  
Creofam LLC  
🌐 [creofam.com](https://creofam.com)  
🌐 [Personal Site](https://leulzenebe.pro)
