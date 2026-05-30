# FixIt Live Services

This is a publishable FixIt website with a Node.js backend API, a polished customer frontend, a separate customer panel, a private admin panel, UPI booking, and Razorpay Checkout support.

## Run locally

```powershell
npm start
```

Open:

```text
http://localhost:3000
```

## Private admin API

Set a secret key before publishing:

```powershell
$env:FIXIT_API_KEY="your-strong-secret"
npm start
```

Use the same key in the app's Admin screen to view private bookings, add workers, or delete workers.

## Optional payment settings

```powershell
$env:FIXIT_UPI_ID="yourupi@bank"
$env:FIXIT_MERCHANT_NAME="FixIt"
```

## Razorpay setup

Create API keys in your Razorpay Dashboard and set them before starting the server:

```powershell
$env:RAZORPAY_KEY_ID="rzp_test_or_live_key"
$env:RAZORPAY_KEY_SECRET="your_razorpay_secret"
npm start
```

Razorpay payments use the standard Checkout flow:

1. The server creates a Razorpay order.
2. The customer pays in Razorpay Checkout.
3. The server verifies the returned signature.
4. The booking is saved only after successful verification.

If Razorpay keys are not configured, the Razorpay button is disabled and UPI/cash booking still works.

## Publish

Upload this folder to a Node host such as Render, Railway, Fly.io, or any VPS.

Required start command:

```text
npm start
```

Required environment variable:

```text
FIXIT_API_KEY=your-strong-secret
```

Optional environment variables:

```text
FIXIT_UPI_ID=yourupi@bank
FIXIT_MERCHANT_NAME=FixIt
RAZORPAY_KEY_ID=rzp_test_or_live_key
RAZORPAY_KEY_SECRET=your_razorpay_secret
PORT=3000
```

Data is stored in `data/db.json`. For a high-traffic production app, replace this file storage with a managed database.
