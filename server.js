const http = require("http");
const fs = require("fs");
const path = require("path");

// Standalone FixIt Admin mini-server.
// This is completely separate from the main FixIt website's server.js.
// Run this on a different machine, port, or hosting service than your
// public site. It only serves the admin.html panel - it does NOT contain
// any customer/worker data itself. When you open the panel, you enter the
// URL of your live FixIt website and your admin API key, and the panel
// talks to that website's /api/admin/* endpoints directly from your
// browser.

const publicDir = path.join(__dirname, "public");
const PORT = Number(process.env.ADMIN_PORT || 4000);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const routePath = url.pathname === "/" ? "/admin.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, decodeURIComponent(routePath)));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`FixIt Admin panel is running at http://localhost:${PORT}`);
  console.log("Open it, enter your live FixIt site URL + admin API key to log in.");
});
