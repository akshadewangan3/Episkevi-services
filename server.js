const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const uploadDir = path.join(publicDir, "uploads");
const dbPath = path.join(dataDir, "db.json");
const envPath = path.join(rootDir, ".env");

function loadEnv() {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const COMMISSION_RATE = 0.1;
const MAX_SERVICE_RADIUS_KM = 50;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";

// ---- Email OTP provider config (set SMTP_* in .env to send real emails) ----
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = process.env.SMTP_SECURE !== "false"; // true = implicit TLS (port 465)
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || "Episkevi";

// ---- Admin API key: never fall back to a hardcoded/guessable secret ----
let ADMIN_API_KEY = process.env.FIXIT_API_KEY || "";
let adminKeyWasGenerated = false;
if (!ADMIN_API_KEY) {
  ADMIN_API_KEY = crypto.randomBytes(24).toString("hex");
  adminKeyWasGenerated = true;
}

const services = ["Electrician", "Plumber", "Carpenter", "AC Repair", "Cleaning"];

const defaultWorkers = [];

const defaultDb = {
  customers: [],
  workers: defaultWorkers,
  workerApplications: [],
  bookings: [],
  reviews: [],
  helpTickets: [],
  sessions: []
};

function ensureDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  if (!fs.existsSync(dbPath)) writeDb(defaultDb);
}

function readDb() {
  ensureDb();
  const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const db = { ...defaultDb, ...raw };
  db.customers = Array.isArray(db.customers) ? db.customers : [];
  db.workers = (Array.isArray(db.workers) ? db.workers : []).map(worker => ({
    verificationStatus: "verified",
    photoUrl: "",
    idUrl: "",
    lat: 23.1226 + (Number(worker.id || 1) * 0.002),
    lng: 83.1956 + (Number(worker.id || 1) * 0.002),
    ...worker,
    status: worker.status === "Available" ? "Online" : worker.status === "Busy" ? "Busy" : (worker.status || "Offline")
  }));
  db.workerApplications = Array.isArray(db.workerApplications) ? db.workerApplications : [];
  db.bookings = Array.isArray(db.bookings) ? db.bookings : [];
  db.reviews = Array.isArray(db.reviews) ? db.reviews : [];
  db.helpTickets = Array.isArray(db.helpTickets) ? db.helpTickets : [];
  db.sessions = (Array.isArray(db.sessions) ? db.sessions : []).filter(s => new Date(s.expiresAt).getTime() > Date.now());
  return db;
}

function writeDb(db) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

// ---------------------------------------------------------------------------
// Security headers applied to every single response (API + static files)
// ---------------------------------------------------------------------------
function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(self), camera=(), microphone=()",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://checkout.razorpay.com https://unpkg.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
      "img-src 'self' data: https://*.basemaps.cartocdn.com",
      "font-src 'self' https://fonts.gstatic.com",
      "connect-src 'self' https://api.razorpay.com",
      "frame-src https://api.razorpay.com"
    ].join("; ")
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...securityHeaders(),
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
      if (body.length > 4_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON")); }
    });
  });
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per key). Good enough for a single-process app;
// swap for a shared store (Redis) if you run more than one instance.
// ---------------------------------------------------------------------------
const rateBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (now > bucket.resetAt) rateBuckets.delete(key);
}, 5 * 60 * 1000).unref();

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

// ---------------------------------------------------------------------------
// Admin auth (unchanged mechanism, timing-safe compare) + rate limiting
// ---------------------------------------------------------------------------
function isAuthorized(req) {
  const token = req.headers["x-api-key"] || "";
  if (!ADMIN_API_KEY || !token) return false;
  const expected = Buffer.from(String(ADMIN_API_KEY));
  const actual = Buffer.from(String(token));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requireAdmin(req, res) {
  if (!rateLimit(`admin:${clientIp(req)}`, 20, 15 * 60 * 1000)) {
    sendError(res, 429, "Too many admin login attempts. Try again later.");
    return false;
  }
  if (isAuthorized(req)) return true;
  sendError(res, 401, "Admin API key required");
  return false;
}

// ---------------------------------------------------------------------------
// OTP + session-based auth for customers and workers.
// Sign-in requires proving ownership of an email address via a one-time
// code sent by email, and every subsequent request is authenticated with a
// bearer session token. The session stays valid (and the person stays
// logged in on that device, via localStorage) until they explicitly log out
// or the session naturally expires after SESSION_TTL_MS.
// ---------------------------------------------------------------------------
const otpStore = new Map(); // key: `${role}:${email}` -> { hash, expiresAt, attempts, lastSentAt }
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 45 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

// ---- Minimal dependency-free SMTP client (implicit TLS on SMTP_PORT, e.g. 465) ----
function smtpCommand(socket, command, expectedCodes) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    function onData(chunk) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || /^\d{3}-/.test(last)) return; // multi-line reply still coming
      socket.removeListener("data", onData);
      const code = Number(last.slice(0, 3));
      if (expectedCodes && !expectedCodes.includes(code)) {
        return reject(new Error(`SMTP server said: ${buffer.trim().split(/\r\n/).pop()}`));
      }
      resolve({ code, message: buffer });
    }
    socket.on("data", onData);
    if (command !== null) socket.write(command + "\r\n");
  });
}

function sendEmailViaSmtp(to, subject, text) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const connectOptions = { host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST };
    const socket = SMTP_SECURE ? tls.connect(connectOptions) : net.connect(connectOptions);
    const readyEvent = SMTP_SECURE ? "secureConnect" : "connect";
    let settled = false;
    const fail = err => { if (!settled) { settled = true; socket.destroy(); reject(err); } };
    socket.setTimeout(15000, () => fail(new Error("SMTP connection timed out")));
    socket.once("error", fail);
    socket.once(readyEvent, async () => {
      try {
        await smtpCommand(socket, null, [220]);
        await smtpCommand(socket, `EHLO ${SMTP_HOST}`, [250]);
        await smtpCommand(socket, "AUTH LOGIN", [334]);
        await smtpCommand(socket, Buffer.from(SMTP_USER).toString("base64"), [334]);
        await smtpCommand(socket, Buffer.from(SMTP_PASS).toString("base64"), [235]);
        await smtpCommand(socket, `MAIL FROM:<${SMTP_FROM}>`, [250]);
        await smtpCommand(socket, `RCPT TO:<${to}>`, [250, 251]);
        await smtpCommand(socket, "DATA", [354]);
        const headers = [
          `From: ${SMTP_FROM_NAME} <${SMTP_FROM}>`,
          `To: <${to}>`,
          `Subject: ${subject}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          ""
        ].join("\r\n");
        const dotStuffed = text.replace(/^\./gm, "..");
        await smtpCommand(socket, `${headers}${dotStuffed}\r\n.`, [250]);
        await smtpCommand(socket, "QUIT", [221]).catch(() => {});
        settled = true;
        socket.end();
        resolve(true);
      } catch (error) {
        fail(error);
      }
    });
  });
}

async function sendOtpEmail(email, otp) {
  try {
    const sent = await sendEmailViaSmtp(
      email,
      "Your Episkevi verification code",
      `Your Episkevi verification code is ${otp}.\nIt expires in 5 minutes. Do not share this code with anyone.\n`
    );
    if (sent) return true;
  } catch (error) {
    console.error("OTP email send failed:", error.message);
    return false;
  }
  console.log(`[DEV OTP] No SMTP provider configured. Code for ${email}: ${otp} (set SMTP_HOST/SMTP_USER/SMTP_PASS in .env to send real emails)`);
  return false;
}

async function requestOtp(res, role, emailRaw) {
  const email = normalizeEmail(emailRaw);
  if (!isValidEmail(email)) return sendError(res, 400, "A valid email address is required");
  const key = `${role}:${email}`;
  const existing = otpStore.get(key);
  if (existing && Date.now() - existing.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
    return sendError(res, 429, `Please wait ${waitSec}s before requesting another code`);
  }
  if (!rateLimit(`otp-req:${key}`, 5, 15 * 60 * 1000)) {
    return sendError(res, 429, "Too many OTP requests for this email. Try again in 15 minutes.");
  }
  const otp = generateOtp();
  otpStore.set(key, { hash: hashValue(otp), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0, lastSentAt: Date.now() });
  const sent = await sendOtpEmail(email, otp);
  const devOtp = !sent && !IS_PRODUCTION ? otp : undefined;
  return sendJson(res, 200, {
    ok: true,
    message: sent ? "A verification code has been sent to your email." : "Email provider not configured — check the server console for the code (development mode only).",
    devOtp
  });
}

function verifyOtpCode(role, emailRaw, codeRaw) {
  const email = normalizeEmail(emailRaw);
  const code = String(codeRaw || "").trim();
  const key = `${role}:${email}`;
  const entry = otpStore.get(key);
  if (!entry) return { ok: false, error: "Request a verification code first" };
  if (Date.now() > entry.expiresAt) { otpStore.delete(key); return { ok: false, error: "Code expired. Request a new one." }; }
  if (entry.attempts >= OTP_MAX_ATTEMPTS) { otpStore.delete(key); return { ok: false, error: "Too many incorrect attempts. Request a new code." }; }
  entry.attempts += 1;
  if (hashValue(code) !== entry.hash) return { ok: false, error: "Incorrect code" };
  otpStore.delete(key);
  return { ok: true, email };
}

function createSession(db, role, email) {
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions = db.sessions.filter(s => !(s.role === role && s.email === email));
  db.sessions.push({ tokenHash: hashValue(token), role, email, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
  return token;
}

function getBearerToken(req) {
  const header = String(req.headers["authorization"] || "");
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1] : "";
}

function resolveSession(db, req) {
  const token = getBearerToken(req);
  if (!token) return null;
  const tokenHash = hashValue(token);
  const session = db.sessions.find(s => s.tokenHash === tokenHash);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;
  return session;
}

function requireSession(db, req, res, role) {
  const session = resolveSession(db, req);
  if (!session || session.role !== role) {
    sendError(res, 401, `Please verify your email to ${role === "worker" ? "access the worker desk" : "continue"}`);
    return null;
  }
  return session;
}

function phone10(value) {
  return String(value || "").replace(/[^\d]/g, "").slice(-10);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function cleanText(value, fallback = "", limit = 120) {
  return String(value || fallback).trim().slice(0, limit);
}

// ---------------------------------------------------------------------------
// File uploads: validate the real file signature (magic bytes), not just the
// label the client claims, so a renamed/mislabeled file can't sneak through.
// ---------------------------------------------------------------------------
function matchesSignature(bytes, mime) {
  if (mime === "image/png") return bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/webp") return bytes.length >= 12 && bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP";
  if (mime === "application/pdf") return bytes.length >= 4 && bytes.slice(0, 4).toString("ascii") === "%PDF";
  return false;
}

function saveUpload(file, prefix) {
  if (!file || !file.dataUrl) return "";
  const match = String(file.dataUrl).match(/^data:(image\/png|image\/jpeg|image\/webp|application\/pdf);base64,(.+)$/);
  if (!match) throw new Error(`${prefix} must be PNG, JPG, WEBP, or PDF`);
  const extByType = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf" };
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 2_500_000) throw new Error(`${prefix} file must be under 2.5 MB`);
  if (!matchesSignature(bytes, match[1])) throw new Error(`${prefix} file content does not match its declared type`);
  fs.mkdirSync(uploadDir, { recursive: true });
  const fileName = `${prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extByType[match[1]]}`;
  fs.writeFileSync(path.join(uploadDir, fileName), bytes);
  return `/uploads/${fileName}`;
}

function sanitizeCustomer(input = {}, emailOverride) {
  const email = normalizeEmail(emailOverride || input.email);
  if (!input.name || !isValidEmail(email)) throw new Error("Customer name and a valid email are required");
  const phone = phone10(input.phone);
  return {
    id: Number(input.id) || Date.now(),
    name: cleanText(input.name, "", 80),
    email,
    phone,
    address: cleanText(input.address, "", 200),
    city: cleanText(input.city, "Ambikapur", 80),
    notification: input.notification === false ? false : true,
    createdAt: input.createdAt || new Date().toISOString()
  };
}

function sanitizeWorkerInput(input = {}, status = "pending") {
  const email = normalizeEmail(input.email);
  const phone = phone10(input.phone);
  const charge = Number(input.charge);
  if (!input.name || !isValidEmail(email) || phone.length !== 10 || !services.includes(input.service) || !Number.isFinite(charge) || charge < 50) {
    throw new Error("Worker name, email, 10 digit phone, service, and valid charge are required");
  }
  return {
    id: Number(input.id) || Date.now(),
    name: cleanText(input.name, "", 80),
    email,
    phone,
    service: input.service,
    area: cleanText(input.area, "Ambikapur", 80),
    charge: Math.round(charge),
    exp: cleanText(input.exp, "Experienced worker", 180),
    rating: Number(input.rating || 0),
    status: cleanText(input.status, "Offline", 30),
    verificationStatus: status,
    photoUrl: cleanText(input.photoUrl, "", 240),
    idUrl: cleanText(input.idUrl, "", 240),
    lat: Number(input.lat || (23.1226 + Math.random() / 30)),
    lng: Number(input.lng || (83.1956 + Math.random() / 30))
  };
}

function makeWorkerApplication(input = {}, email) {
  if (!input.photo?.dataUrl || !input.idProof?.dataUrl) throw new Error("Worker photo and ID proof are required");
  return {
    ...sanitizeWorkerInput({ ...input, email }, "pending"),
    status: "Pending",
    photoUrl: saveUpload(input.photo, "worker-photo"),
    idUrl: saveUpload(input.idProof, "worker-id"),
    steps: {
      personalDetails: true,
      documents: true,
      training: false,
      bankDetails: Boolean(input.bankName || input.upiId)
    },
    bankName: cleanText(input.bankName, "", 80),
    upiId: cleanText(input.upiId, "", 80),
    appliedAt: new Date().toISOString(),
    reviewedAt: "",
    rejectionReason: ""
  };
}

function haversineKm(a, b) {
  if (!a || !b || !Number.isFinite(Number(a.lat)) || !Number.isFinite(Number(b.lat))) return null;
  const R = 6371;
  const dLat = (Number(b.lat) - Number(a.lat)) * Math.PI / 180;
  const dLng = (Number(b.lng) - Number(a.lng)) * Math.PI / 180;
  const lat1 = Number(a.lat) * Math.PI / 180, lat2 = Number(b.lat) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 10) / 10;
}

function makeBooking(worker, customer = {}, payment = {}) {
  const base = Number(worker.charge || 0);
  const commission = Math.round(base * COMMISSION_RATE);
  const total = base + commission;
  const now = new Date();
  const custLat = Number(customer.lat), custLng = Number(customer.lng);
  return {
    id: Date.now(),
    workerId: worker.id,
    workerName: worker.name,
    workerPhone: worker.phone,
    workerEmail: worker.email,
    service: worker.service,
    workerLocation: { lat: worker.lat, lng: worker.lng, area: worker.area },
    customerLocation: Number.isFinite(custLat) && Number.isFinite(custLng) ? { lat: custLat, lng: custLng } : null,
    base,
    commission,
    total,
    customerName: customer.name,
    customerPhone: customer.phone,
    customerEmail: customer.email,
    customerAddress: customer.address,
    customerCity: customer.city || "Ambikapur",
    note: cleanText(customer.note, "", 160),
    paymentMethod: payment.method || "cash",
    paymentStatus: payment.status || "pending",
    razorpayOrderId: payment.razorpayOrderId || "",
    razorpayPaymentId: payment.razorpayPaymentId || "",
    status: "requested",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    time: now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) +
      " . " + now.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }),
    timeline: [
      { label: "Booking requested", at: now.toISOString() }
    ]
  };
}

function publicWorker(worker) {
  return {
    id: worker.id,
    service: worker.service,
    charge: worker.charge,
    rating: worker.rating,
    area: worker.area,
    status: worker.status,
    verificationStatus: worker.verificationStatus,
    lat: worker.lat,
    lng: worker.lng,
    radiusKm: MAX_SERVICE_RADIUS_KM
  };
}

function reviewUrl(req, bookingId) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}/?review=${bookingId}`;
}

function whatsappReviewLink(req, booking) {
  const text = [
    `Hi ${booking.customerName}, your Episkevi ${booking.service} service is marked completed.`,
    `Please review ${booking.workerName}: ${reviewUrl(req, booking.id)}`,
    "Options: Good behaviour, Excellent service, 1 to 5 star rating."
  ].join("\n");
  return `https://wa.me/91${booking.customerPhone}?text=${encodeURIComponent(text)}`;
}

class RazorpayHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function requestJson({ method = "GET", hostname, path: requestPath, auth, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = https.request({
      method,
      hostname,
      path: requestPath,
      auth,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    }, res => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        const parsed = raw ? JSON.parse(raw) : {};
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new RazorpayHttpError(res.statusCode, parsed.error?.description || parsed.error || "Razorpay request failed"));
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function verifyRazorpaySignature(orderId, paymentId, signature) {
  if (!RAZORPAY_KEY_SECRET) return false;
  const expected = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
  const actual = Buffer.from(String(signature || ""));
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

async function createRazorpayOrder(amount, receipt) {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) throw new Error("Razorpay keys are not configured");
  if (!Number.isFinite(Number(amount)) || Number(amount) < 100) throw new Error("Amount must be at least 100 paise");
  return requestJson({
    method: "POST",
    hostname: "api.razorpay.com",
    path: "/v1/orders",
    auth: `${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`,
    body: { amount: Math.round(Number(amount)), currency: "INR", receipt: cleanText(receipt, `fixit_${Date.now()}`, 40) }
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const routePath = url.pathname === "/" ? "/index.html" : url.pathname === "/admin" ? "/admin.html" : url.pathname;
  const pathname = decodeURIComponent(routePath);
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, securityHeaders());
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, securityHeaders());
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf", ".svg": "image/svg+xml" };
    res.writeHead(200, { ...securityHeaders(), "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function updateBooking(booking, status, extra = {}) {
  booking.status = status;
  booking.updatedAt = new Date().toISOString();
  booking.timeline = Array.isArray(booking.timeline) ? booking.timeline : [];
  booking.timeline.push({ label: status, at: booking.updatedAt });
  Object.assign(booking, extra);
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const db = readDb();

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, app: "Episkevi Marketplace" });
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    return sendJson(res, 200, {
      services,
      workers: db.workers.filter(w => w.verificationStatus === "verified").map(publicWorker),
      settings: {
        commissionRate: COMMISSION_RATE,
        maxServiceRadiusKm: MAX_SERVICE_RADIUS_KM,
        upiId: process.env.FIXIT_UPI_ID || "test@razorpay",
        merchantName: process.env.FIXIT_MERCHANT_NAME || "Episkevi",
        razorpayKeyId: RAZORPAY_KEY_ID,
        razorpayEnabled: Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
      }
    });
  }

  // ---------------- Customer OTP sign-in (email) ----------------
  if (req.method === "POST" && url.pathname === "/api/customer/otp/request") {
    if (!rateLimit(`otp-ip:${clientIp(req)}`, 20, 15 * 60 * 1000)) return sendError(res, 429, "Too many requests. Try again later.");
    const body = await parseBody(req);
    return requestOtp(res, "customer", body.email);
  }

  if (req.method === "POST" && url.pathname === "/api/customer/otp/verify") {
    if (!rateLimit(`otp-verify-ip:${clientIp(req)}`, 30, 15 * 60 * 1000)) return sendError(res, 429, "Too many attempts. Try again later.");
    const body = await parseBody(req);
    const result = verifyOtpCode("customer", body.email, body.otp);
    if (!result.ok) return sendError(res, 400, result.error);
    const index = db.customers.findIndex(c => c.email === result.email);
    let customer;
    if (index >= 0) customer = db.customers[index];
    else {
      customer = sanitizeCustomer({ name: body.name || "Customer", email: result.email }, result.email);
      db.customers.push(customer);
    }
    const token = createSession(db, "customer", result.email);
    writeDb(db);
    return sendJson(res, 200, { token, customer });
  }

  // ---------------- Worker OTP sign-in (email) ----------------
  if (req.method === "POST" && url.pathname === "/api/worker/otp/request") {
    if (!rateLimit(`otp-ip:${clientIp(req)}`, 20, 15 * 60 * 1000)) return sendError(res, 429, "Too many requests. Try again later.");
    const body = await parseBody(req);
    return requestOtp(res, "worker", body.email);
  }

  if (req.method === "POST" && url.pathname === "/api/worker/otp/verify") {
    if (!rateLimit(`otp-verify-ip:${clientIp(req)}`, 30, 15 * 60 * 1000)) return sendError(res, 429, "Too many attempts. Try again later.");
    const body = await parseBody(req);
    const result = verifyOtpCode("worker", body.email, body.otp);
    if (!result.ok) return sendError(res, 400, result.error);
    const token = createSession(db, "worker", result.email);
    const worker = db.workers.find(w => w.email === result.email);
    const application = db.workerApplications.find(a => a.email === result.email);
    writeDb(db);
    return sendJson(res, 200, { token, worker: worker || null, application: application || null });
  }

  // ---------------- Customer profile + bookings (session required) ----------------
  if (req.method === "POST" && url.pathname === "/api/customer/profile") {
    const session = requireSession(db, req, res, "customer");
    if (!session) return;
    const body = await parseBody(req);
    const customer = sanitizeCustomer({ ...body, email: session.email }, session.email);
    const index = db.customers.findIndex(c => c.email === session.email);
    if (index >= 0) db.customers[index] = { ...db.customers[index], ...customer };
    else db.customers.push(customer);
    writeDb(db);
    return sendJson(res, 200, { customer });
  }

  if (req.method === "GET" && url.pathname === "/api/customer/bookings") {
    const session = requireSession(db, req, res, "customer");
    if (!session) return;
    return sendJson(res, 200, { bookings: db.bookings.filter(b => b.customerEmail === session.email) });
  }

  // ---------------- Worker registration (session required) ----------------
  if (req.method === "POST" && url.pathname === "/api/worker/register") {
    const session = requireSession(db, req, res, "worker");
    if (!session) return;
    const body = await parseBody(req);
    if (db.workerApplications.some(a => a.email === session.email && a.verificationStatus === "pending")) return sendError(res, 409, "Pending application already exists");
    if (db.workers.some(w => w.email === session.email && w.verificationStatus === "verified")) return sendError(res, 409, "Worker already verified. Login with your email.");
    const application = makeWorkerApplication(body, session.email);
    db.workerApplications.push(application);
    writeDb(db);
    return sendJson(res, 201, { application });
  }

  if (req.method === "GET" && url.pathname === "/api/worker/dashboard") {
    const session = requireSession(db, req, res, "worker");
    if (!session) return;
    const worker = db.workers.find(w => w.email === session.email);
    const application = db.workerApplications.find(a => a.email === session.email);
    const bookings = worker ? db.bookings.filter(b => Number(b.workerId) === Number(worker.id)) : [];
    const reviews = worker ? db.reviews.filter(r => Number(r.workerId) === Number(worker.id)) : [];
    return sendJson(res, 200, { worker: worker || null, application: application || null, bookings, reviews });
  }

  if (req.method === "PATCH" && url.pathname === "/api/worker/profile") {
    const session = requireSession(db, req, res, "worker");
    if (!session) return;
    const body = await parseBody(req);
    const worker = db.workers.find(w => w.email === session.email);
    if (!worker) return sendError(res, 404, "Verified worker not found");
    if (body.status) worker.status = ["Online", "Offline", "Busy"].includes(body.status) ? body.status : worker.status;
    if (body.lat !== undefined && body.lng !== undefined) {
      worker.lat = Number(body.lat);
      worker.lng = Number(body.lng);
    }
    if (body.area) worker.area = cleanText(body.area, worker.area, 80);
    if (body.charge) worker.charge = Math.max(50, Math.round(Number(body.charge)));
    writeDb(db);
    return sendJson(res, 200, { worker });
  }

  // ---------------- Bookings ----------------
  if (req.method === "POST" && url.pathname === "/api/bookings") {
    const session = requireSession(db, req, res, "customer");
    if (!session) return;
    const body = await parseBody(req);
    const worker = db.workers.find(w => Number(w.id) === Number(body.workerId) && w.verificationStatus === "verified");
    if (!worker) return sendError(res, 404, "Verified worker not found");
    const customer = sanitizeCustomer({ ...(body.customer || {}), email: session.email }, session.email);
    if (customer.phone.length !== 10) return sendError(res, 400, "A valid 10 digit phone number is required so the worker can contact you");
    const customerLocation = body.customer?.lat !== undefined && body.customer?.lng !== undefined
      ? { lat: Number(body.customer.lat), lng: Number(body.customer.lng) }
      : null;
    const bookingDistanceKm = haversineKm({ lat: worker.lat, lng: worker.lng }, customerLocation);
    if (bookingDistanceKm !== null && bookingDistanceKm > MAX_SERVICE_RADIUS_KM) {
      return sendError(res, 400, `No ${worker.service} worker is within ${MAX_SERVICE_RADIUS_KM} km of this customer location`);
    }
    const existingCustomer = db.customers.findIndex(c => c.email === customer.email);
    if (existingCustomer >= 0) db.customers[existingCustomer] = { ...db.customers[existingCustomer], ...customer };
    else db.customers.push(customer);
    const booking = makeBooking(worker, { ...customer, lat: customerLocation?.lat, lng: customerLocation?.lng }, {
      method: body.paymentMethod === "upi" ? "upi" : body.paymentMethod === "razorpay" ? "razorpay" : "cash",
      status: body.paymentMethod === "razorpay" ? "paid" : "pending"
    });
    db.bookings.push(booking);
    worker.status = "Busy";
    writeDb(db);
    return sendJson(res, 201, { booking });
  }

  const bookingAction = url.pathname.match(/^\/api\/bookings\/(\d+)\/(accept|start|complete|cancel)$/);
  if (req.method === "POST" && bookingAction) {
    const session = requireSession(db, req, res, "worker");
    if (!session) return;
    const id = Number(bookingAction[1]);
    const action = bookingAction[2];
    const booking = db.bookings.find(b => Number(b.id) === id);
    if (!booking) return sendError(res, 404, "Booking not found");
    if (booking.workerEmail !== session.email) return sendError(res, 403, "This booking is assigned to another worker");
    const worker = db.workers.find(w => Number(w.id) === Number(booking.workerId));
    if (action === "accept") {
      const acceptDistanceKm = haversineKm(worker ? { lat: worker.lat, lng: worker.lng } : booking.workerLocation, booking.customerLocation);
      if (acceptDistanceKm !== null && acceptDistanceKm > MAX_SERVICE_RADIUS_KM) {
        return sendError(res, 400, `Worker must be within ${MAX_SERVICE_RADIUS_KM} km to accept this booking`);
      }
      updateBooking(booking, "accepted");
    }
    if (action === "start") updateBooking(booking, "on_the_way");
    if (action === "cancel") updateBooking(booking, "cancelled");
    if (action === "complete") {
      updateBooking(booking, "completed", { completedAt: new Date().toISOString() });
      if (worker) worker.status = "Online";
      booking.whatsappReviewLink = whatsappReviewLink(req, booking);
    }
    writeDb(db);
    return sendJson(res, 200, { booking, whatsappReviewLink: booking.whatsappReviewLink || "" });
  }

  const trackMatch = url.pathname.match(/^\/api\/bookings\/(\d+)\/track$/);
  if (req.method === "GET" && trackMatch) {
    const booking = db.bookings.find(b => Number(b.id) === Number(trackMatch[1]));
    if (!booking) return sendError(res, 404, "Booking not found");
    const worker = db.workers.find(w => Number(w.id) === Number(booking.workerId));
    const workerLocation = worker ? { lat: worker.lat, lng: worker.lng, status: worker.status } : booking.workerLocation;
    const distanceKm = haversineKm(workerLocation, booking.customerLocation);
    return sendJson(res, 200, {
      status: booking.status,
      service: booking.service,
      workerName: booking.workerName,
      workerPhone: booking.workerPhone,
      customerName: booking.customerName,
      customerAddress: booking.customerAddress,
      workerLocation,
      customerLocation: booking.customerLocation,
      distanceKm,
      maxServiceRadiusKm: MAX_SERVICE_RADIUS_KM,
      etaMinutes: distanceKm === null ? null : Math.max(2, Math.round((distanceKm / 22) * 60))
    });
  }

  if (req.method === "POST" && url.pathname === "/api/reviews") {
    const session = requireSession(db, req, res, "customer");
    if (!session) return;
    const body = await parseBody(req);
    const booking = db.bookings.find(b => Number(b.id) === Number(body.bookingId));
    if (!booking) return sendError(res, 404, "Booking not found");
    if (booking.customerEmail !== session.email) return sendError(res, 403, "This booking does not belong to you");
    const rating = Math.min(5, Math.max(1, Number(body.rating || 5)));
    const tags = Array.isArray(body.tags) ? body.tags.map(tag => cleanText(tag, "", 40)).filter(Boolean).slice(0, 6) : [];
    const review = {
      id: Date.now(),
      bookingId: booking.id,
      workerId: booking.workerId,
      workerName: booking.workerName,
      customerPhone: booking.customerPhone,
      rating,
      tags,
      comment: cleanText(body.comment, "", 240),
      createdAt: new Date().toISOString()
    };
    db.reviews.push(review);
    booking.reviewId = review.id;
    const workerReviews = db.reviews.filter(r => Number(r.workerId) === Number(booking.workerId));
    const worker = db.workers.find(w => Number(w.id) === Number(booking.workerId));
    if (worker) worker.rating = Math.round((workerReviews.reduce((sum, r) => sum + Number(r.rating), 0) / workerReviews.length) * 10) / 10;
    writeDb(db);
    return sendJson(res, 201, { review });
  }

  if (req.method === "POST" && url.pathname === "/api/help/chat") {
    const session = requireSession(db, req, res, "customer");
    if (!session) return;
    const body = await parseBody(req);
    const message = cleanText(body.message, "", 280);
    const reply = message.toLowerCase().includes("refund")
      ? "Refund ya payment issue ke liye booking ID bhejiye. Admin panel me payment status check karke support karega."
      : message.toLowerCase().includes("worker")
        ? "Worker late hai to booking status open kijiye. Worker location aur call option customer booking card par dikh raha hai."
        : "Episkevi support: booking, worker verification, payment, address, ya review ke liye apna phone aur booking detail bhejiye.";
    const ticket = { id: Date.now(), email: session.email, message, reply, createdAt: new Date().toISOString() };
    db.helpTickets.push(ticket);
    writeDb(db);
    return sendJson(res, 200, { reply, ticket });
  }

  if (req.method === "POST" && url.pathname === "/api/create-order") {
    const session = requireSession(db, req, res, "customer");
    if (!session) return;
    const body = await parseBody(req);
    try {
      const order = await createRazorpayOrder(Number(body.amount), body.receipt);
      return sendJson(res, 201, { order_id: order.id, amount: order.amount, currency: order.currency, key_id: RAZORPAY_KEY_ID });
    } catch (error) {
      const status = error instanceof RazorpayHttpError && error.statusCode === 401 ? 401 : error instanceof RazorpayHttpError ? 500 : 400;
      return sendError(res, status, error.message);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/verify-payment") {
    const session = requireSession(db, req, res, "customer");
    if (!session) return;
    const body = await parseBody(req);
    const orderId = body.razorpay_order_id || body.order_id;
    const paymentId = body.razorpay_payment_id || body.payment_id;
    const signature = body.razorpay_signature || body.signature;
    if (!orderId || !paymentId || !signature) return sendError(res, 400, "Payment fields are required");
    if (!verifyRazorpaySignature(orderId, paymentId, signature)) return sendError(res, 400, "Payment verification failed");
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    return requireAdmin(req, res) ? sendJson(res, 200, { ok: true }) : undefined;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/dashboard") {
    if (!requireAdmin(req, res)) return;
    return sendJson(res, 200, { customers: db.customers, workers: db.workers, workerApplications: db.workerApplications, bookings: db.bookings, reviews: db.reviews, helpTickets: db.helpTickets });
  }

  const applicationReview = url.pathname.match(/^\/api\/admin\/worker-applications\/(\d+)\/(verify|reject)$/);
  if (req.method === "POST" && applicationReview) {
    if (!requireAdmin(req, res)) return;
    const id = Number(applicationReview[1]);
    const action = applicationReview[2];
    const application = db.workerApplications.find(app => Number(app.id) === id);
    if (!application) return sendError(res, 404, "Worker application not found");
    if (application.verificationStatus !== "pending") return sendError(res, 400, "Application is already reviewed");
    if (action === "verify") {
      application.verificationStatus = "verified";
      application.status = "Verified";
      application.reviewedAt = new Date().toISOString();
      const worker = sanitizeWorkerInput({ ...application, id: Date.now(), status: "Online" }, "verified");
      db.workers.push(worker);
      writeDb(db);
      return sendJson(res, 200, { worker, application });
    }
    const body = await parseBody(req);
    application.verificationStatus = "rejected";
    application.status = "Rejected";
    application.reviewedAt = new Date().toISOString();
    application.rejectionReason = cleanText(body.reason, "Documents could not be verified", 160);
    writeDb(db);
    return sendJson(res, 200, { application });
  }

  sendError(res, 404, "API route not found");
}

const server = http.createServer(async (req, res) => {
  try {
    if (!rateLimit(`global:${clientIp(req)}`, 600, 60 * 1000)) {
      return sendError(res, 429, "Too many requests. Please slow down.");
    }
    if (req.url.startsWith("/api/")) await handleApi(req, res);
    else serveStatic(req, res);
  } catch (error) {
    sendError(res, 400, error.message || "Request failed");
  }
});

ensureDb();
server.listen(PORT, () => {
  console.log(`Episkevi Marketplace is running at http://localhost:${PORT}`);
  if (adminKeyWasGenerated) {
    console.log("\n============================================================");
    console.log(" No FIXIT_API_KEY was set in .env — a random admin key was");
    console.log(" generated for this session only (it will change on restart):");
    console.log(`   ${ADMIN_API_KEY}`);
    console.log(" Set FIXIT_API_KEY in your .env file to keep a stable admin key.");
    console.log("============================================================\n");
  }
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log("No SMTP provider configured (SMTP_HOST / SMTP_USER / SMTP_PASS env vars).");
    console.log("OTP codes will be printed here in the console for local testing only.\n");
  }
});
