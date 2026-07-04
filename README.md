# FixIt Admin Panel (standalone)

This is now a **separate mini app**, not part of your public FixIt website.
Your customers and workers can no longer reach the admin panel through your
main site (the `/admin` page has been removed from `server.js`). You run
this admin panel on its own, wherever you like - your own PC, a different
port, or a completely different host/domain than your public site.

It does not store any data itself. It is just the admin screen; when you
open it, you type in the web address of your live FixIt website and your
admin API key, and it talks to that website's private admin API directly
from your browser.

## Run it locally

```powershell
cd admin-panel
npm start
```

Open:

```text
http://localhost:4000
```

(Change the port with `$env:ADMIN_PORT="5000"` before `npm start` if you
want a different one.)

## Using it

1. Open the admin panel (locally or wherever you hosted it).
2. In "Your FixIt site URL", enter the full web address of your live FixIt
   site, for example `https://your-fixit-site.onrender.com` (no trailing
   slash). Click "Save site URL".
3. Enter your `FIXIT_API_KEY` (the same secret key you set on the main
   site's server) and click "Open console".

## Hosting it somewhere else entirely

Because this is just static HTML + a tiny Node static file server, you can
deploy the `admin-panel` folder on its own to any Node host (Render,
Railway, Fly.io, a VPS, or even your own laptop) completely separately
from your main FixIt website. As long as you can reach your main site's
URL from wherever you run this, the admin panel will work.

## Important: keep this URL private

Do not link this admin panel from your public website or share the URL
with customers/workers. Anyone who has both this panel's address AND your
`FIXIT_API_KEY` can manage your bookings and workers, so treat the key
like a password and only share the admin panel's address with people you
trust to manage the business.
