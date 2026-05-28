# FixIt Live Services

This is a publishable FixIt website with a Node.js backend API.

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
PORT=3000
```

Data is stored in `data/db.json`. For a high-traffic production app, replace this file storage with a managed database.
