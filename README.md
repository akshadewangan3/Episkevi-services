# FixIt Live Services

This is a publishable FixIt marketplace website with a Node.js backend API, customer login, worker login, worker verification, incoming booking workflow, separate admin page, UPI booking, Razorpay Checkout support, WhatsApp review links, and AI-style help chat.

## Main flows

- Customers can search verified workers and book home services.
- Customers get a panel with Home, Profile, Address, App Settings, and Help & Support.
- Workers can register themselves with photo and ID proof, then login after verification.
- Workers get verification steps, personal details, dashboard stats, and incoming bookings.
- Admin can verify or reject worker applications from `public/admin.html` or `/admin`.
- Only verified workers become visible to customers, and customer search shows anonymous service/price options instead of worker identity.
- Customer location is used to keep booking and worker accept actions inside a 50 km service radius.
- Admin can track customers, bookings, payment status, worker fleet, reviews, help tickets, and application queue.
- When a worker marks a job complete, the app opens a WhatsApp review message link for the customer.
- Customer reviews support 1-5 stars and tags like Good behaviour and Excellent service.

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

**The admin panel is no longer part of this website.** It has moved to its
own standalone mini-app in the `admin-panel` folder, which you run
separately (a different PC, port, or host) - see `admin-panel/README.md`.
It calls this site's private `/api/admin/*` endpoints using the same
`FIXIT_API_KEY` you set here. This site only exposes those admin endpoints
over the network; it does not serve any admin HTML page itself anymore.

Admin also uses this key to verify worker applications.

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

Uploaded worker photos and ID files are stored in `public/uploads`. In production, use cloud storage for these documents and protect ID files behind admin authentication.

## Important production note

The WhatsApp review message is opened as a WhatsApp link after the worker marks the job complete. To send WhatsApp messages automatically without a click, you need the official WhatsApp Business API and an approved message template.
