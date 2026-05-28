const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_API_KEY = process.env.FIXIT_API_KEY || "change-this-secret";
const COMMISSION_RATE = 0.1;

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const dbPath = path.join(dataDir, "db.json");

const defaultDb = {
  workers: [
    { id: 1, name: "Ramesh Kumar", service: "Electrician", charge: 300, phone: "9876543210", rating: 4.8, exp: "7 yrs, all wiring and fuse work", area: "Ambikapur", status: "Available" },
    { id: 2, name: "Suresh Patel", service: "Plumber", charge: 250, phone: "9123456780", rating: 4.5, exp: "5 yrs, pipe fitting and leak fixes", area: "Ambikapur", status: "Available" },
    { id: 3, name: "Mohan Verma", service: "Electrician", charge: 350, phone: "9988776655", rating: 4.7, exp: "10 yrs, commercial and home wiring", area: "Darima", status: "Busy" },
    { id: 4, name: "Lakshmi Devi", service: "Cleaning", charge: 400, phone: "9871234560", rating: 4.9, exp: "3 yrs, deep cleaning expert", area: "Ambikapur", status: "Available" },
    { id: 5, name: "Rajesh Singh", service: "Carpenter", charge: 500, phone: "9765432100", rating: 4.6, exp: "8 yrs, furniture and doors", area: "Ambikapur", status: "Available" },
    { id: 6, name: "Dinesh Gupta", service: "AC Repair", charge: 600, phone: "9654321098", rating: 4.4, exp: "6 yrs, all AC brands", area: "Ambikapur", status: "Busy" }
  ],
  bookings: []
};

function ensureDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(defaultDb, null, 2));
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function isAuthorized(req) {
  const token = req.headers["x-api-key"] || "";
  if (!ADMIN_API_KEY || !token) return false;
  const expected = Buffer.from(String(ADMIN_API_KEY));
  const actual = Buffer.from(String(token));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requireAdmin(req, res) {
  if (isAuthorized(req)) return true;
  sendError(res, 401, "Admin API key required");
  return false;
}

function sanitizeWorker(input) {
  const charge = Number(input.charge);
  const rating = Number(input.rating || 4.5);
  const phone = String(input.phone || "").replace(/[^\d+]/g, "");
  if (!input.name || !input.service || !Number.isFinite(charge) || charge <= 0 || phone.length < 10) {
    throw new Error("Name, service, valid charge, and phone are required");
  }
  return {
    id: Date.now(),
    name: String(input.name).trim().slice(0, 80),
    service: String(input.service).trim().slice(0, 40),
    charge: Math.round(charge),
    phone,
    rating: Math.min(5, Math.max(1, Number.isFinite(rating) ? rating : 4.5)),
    exp: String(input.exp || "Experienced").trim().slice(0, 120),
    area: String(input.area || "Local").trim().slice(0, 80),
    status: input.status === "Busy" ? "Busy" : "Available"
  };
}

function makeBooking(worker) {
  const commission = Math.round(worker.charge * COMMISSION_RATE);
  const total = worker.charge + commission;
  const now = new Date();
  return {
    id: Date.now(),
    workerId: worker.id,
    workerName: worker.name,
    service: worker.service,
    area: worker.area,
    phone: worker.phone,
    base: worker.charge,
    commission,
    total,
    status: "confirmed",
    createdAt: now.toISOString(),
    time: now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) +
      " . " + now.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })
  };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) return sendError(res, 403, "Forbidden");

  fs.readFile(filePath, (err, data) => {
    if (err) return sendError(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml"
    };
    res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = readDb();

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, app: "FixIt", privateApi: true });
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    return sendJson(res, 200, {
      workers: db.workers,
      settings: {
        commissionRate: COMMISSION_RATE,
        upiId: process.env.FIXIT_UPI_ID || "yashdewangan110@okicici",
        merchantName: process.env.FIXIT_MERCHANT_NAME || "FixIt"
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    return requireAdmin(req, res) ? sendJson(res, 200, { ok: true }) : undefined;
  }

  if (req.method === "GET" && url.pathname === "/api/bookings") {
    if (!requireAdmin(req, res)) return;
    return sendJson(res, 200, { bookings: db.bookings });
  }

  if (req.method === "POST" && url.pathname === "/api/bookings") {
    const body = await parseBody(req);
    const worker = db.workers.find(w => Number(w.id) === Number(body.workerId));
    if (!worker) return sendError(res, 404, "Worker not found");
    const booking = makeBooking(worker);
    db.bookings.push(booking);
    writeDb(db);
    return sendJson(res, 201, { booking });
  }

  if (req.method === "POST" && url.pathname === "/api/workers") {
    if (!requireAdmin(req, res)) return;
    const worker = sanitizeWorker(await parseBody(req));
    db.workers.push(worker);
    writeDb(db);
    return sendJson(res, 201, { worker });
  }

  const workerDelete = url.pathname.match(/^\/api\/workers\/(\d+)$/);
  if (req.method === "DELETE" && workerDelete) {
    if (!requireAdmin(req, res)) return;
    const id = Number(workerDelete[1]);
    const nextWorkers = db.workers.filter(w => Number(w.id) !== id);
    if (nextWorkers.length === db.workers.length) return sendError(res, 404, "Worker not found");
    db.workers = nextWorkers;
    writeDb(db);
    return sendJson(res, 200, { ok: true });
  }

  sendError(res, 404, "API route not found");
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
    } else {
      serveStatic(req, res);
    }
  } catch (error) {
    sendError(res, 400, error.message || "Request failed");
  }
});

ensureDb();
server.listen(PORT, () => {
  console.log(`FixIt is running at http://localhost:${PORT}`);
  console.log("Set FIXIT_API_KEY before publishing. Current key is the development default.");
});
