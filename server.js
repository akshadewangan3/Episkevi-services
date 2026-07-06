const http = require("http");
const https = require("https");
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
const ADMIN_API_KEY = process.env.FIXIT_API_KEY || "change-this-secret";
const COMMISSION_RATE = 0.1;
const MAX_SERVICE_RADIUS_KM = 50;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const OTP_TTL_MS = 5 * 60 * 1000;
const SMS_WEBHOOK_URL = process.env.FIXIT_SMS_WEBHOOK_URL || "";
const SMS_API_KEY = process.env.FIXIT_SMS_API_KEY || "";
const SMS_SENDER_ID = process.env.FIXIT_SMS_SENDER_ID || "FIXIT";

const services = ["Electrician", "Plumber", "Carpenter", "AC Repair", "Cleaning"];
const otpRequests = new Map();
const otpTokens = new Map();

const defaultWorkers = [
  { id: 1, name: "Ramesh Kumar", service: "Electrician", charge: 300, phone: "9876543210", rating: 4.8, exp: "7 yrs, wiring, fuse and switchboard work", area: "Ambikapur", status: "Online", verificationStatus: "verified", photoUrl: "", idUrl: "", lat: 23.1226, lng: 83.1956 },
  { id: 2, name: "Suresh Patel", service: "Plumber", charge: 250, phone: "9123456780", rating: 4.5, exp: "5 yrs, leakage and bathroom fittings", area: "Ambikapur", status: "Online", verificationStatus: "verified", photoUrl: "", idUrl: "", lat: 23.1268, lng: 83.1814 },
  { id: 3, name: "Mohan Verma", service: "Electrician", charge: 350, phone: "9988776655", rating: 4.7, exp: "10 yrs, commercial and home wiring", area: "Darima", status: "Busy", verificationStatus: "verified", photoUrl: "", idUrl: "", lat: 23.1841, lng: 83.2425 },
  { id: 4, name: "Lakshmi Devi", service: "Cleaning", charge: 400, phone: "9871234560", rating: 4.9, exp: "3 yrs, deep cleaning and kitchen cleaning", area: "Ambikapur", status: "Online", verificationStatus: "verified", photoUrl: "", idUrl: "", lat: 23.1162, lng: 83.2051 },
  { id: 5, name: "Rajesh Singh", service: "Carpenter", charge: 500, phone: "9765432100", rating: 4.6, exp: "8 yrs, furniture, doors and fittings", area: "Ambikapur", status: "Online", verificationStatus: "verified", photoUrl: "", idUrl: "", lat: 23.1329, lng: 83.1993 },
  { id: 6, name: "Dinesh Gupta", service: "AC Repair", charge: 600, phone: "9654321098", rating: 4.4, exp: "6 yrs, all AC brands and gas refill", area: "Ambikapur", status: "Busy", verificationStatus: "verified", photoUrl: "", idUrl: "", lat: 23.1084, lng: 83.1882 }
];

const defaultDb = {
  customers: [],
  workers: defaultWorkers,
  workerApplications: [],
  bookings: [],
  reviews: [],
  helpTickets: []
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
  return db;
}

function writeDb(db) {
  fs.mkdirSync(dataDir, { recursive: true });
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

function phone10(value) {
  return String(value || "").replace(/[^\d]/g, "").slice(-10);
}

function aadhaar12(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function validateAadhaar(value) {
  const aadhaar = aadhaar12(value);
  if (aadhaar.length !== 12) throw new Error("Aadhaar number must be exactly 12 digits");
  if (/^(\d)\1{11}$/.test(aadhaar)) throw new Error("Aadhaar number is not valid");
  return aadhaar;
}

function otpKey(scope, phone) {
  return `${scope}:${phone}`;
}

function pruneOtps() {
  const now = Date.now();
  for (const [key, value] of otpRequests) if (value.expiresAt <= now) otpRequests.delete(key);
  for (const [key, value] of otpTokens) if (value.expiresAt <= now) otpTokens.delete(key);
}

function createOtp(scope, phone) {
  pruneOtps();
  if (!["customer", "worker"].includes(scope)) throw new Error("Invalid OTP scope");
  if (phone.length !== 10) throw new Error("Valid 10 digit phone is required for OTP");
  const code = String(crypto.randomInt(100000, 999999));
  otpRequests.set(otpKey(scope, phone), { code, attempts: 0, expiresAt: Date.now() + OTP_TTL_MS });
  return code;
}

function verifyOtp(scope, phone, otp) {
  pruneOtps();
  const key = otpKey(scope, phone);
  const record = otpRequests.get(key);
  if (!record) throw new Error("OTP expired. Please request a new OTP.");
  record.attempts += 1;
  if (record.attempts > 5) {
    otpRequests.delete(key);
    throw new Error("Too many wrong OTP attempts. Please request a new OTP.");
  }
  if (String(otp || "").replace(/[^\d]/g, "") !== record.code) throw new Error("Wrong OTP. Please check and try again.");
  otpRequests.delete(key);
  const token = crypto.randomBytes(24).toString("hex");
  otpTokens.set(token, { scope, phone, expiresAt: Date.now() + OTP_TTL_MS });
  return token;
}

function requireOtpToken(scope, phone, token) {
  pruneOtps();
  const record = otpTokens.get(String(token || ""));
  if (!record || record.scope !== scope || record.phone !== phone) throw new Error("OTP verification required before login");
  otpTokens.delete(String(token));
}

function postJsonUrl(targetUrl, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const payload = JSON.stringify(body);
    const req = transport.request({
      method: "POST",
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || undefined,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...extraHeaders
      }
    }, res => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(parsed.error || parsed.message || `SMS gateway failed with status ${res.statusCode}`));
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function sendOtpSms(phone, otp) {
  if (!SMS_WEBHOOK_URL) {
    throw new Error("SMS gateway not configured. Add FIXIT_SMS_WEBHOOK_URL in .env to send OTP by SMS.");
  }
  const message = `Your FixIt OTP is ${otp}. It is valid for 5 minutes.`;
  const headers = SMS_API_KEY ? { Authorization: `Bearer ${SMS_API_KEY}` } : {};
  await postJsonUrl(SMS_WEBHOOK_URL, {
    phone: `91${phone}`,
    otp,
    message,
    senderId: SMS_SENDER_ID
  }, headers);
}

function cleanText(value, fallback = "", limit = 120) {
  return String(value || fallback).trim().slice(0, limit);
}

function saveUpload(file, prefix) {
  if (!file || !file.dataUrl) return "";
  const match = String(file.dataUrl).match(/^data:(image\/png|image\/jpeg|image\/webp|application\/pdf);base64,(.+)$/);
  if (!match) throw new Error(`${prefix} must be PNG, JPG, WEBP, or PDF`);
  const extByType = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "application/pdf": ".pdf" };
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 2_500_000) throw new Error(`${prefix} file must be under 2.5 MB`);
  fs.mkdirSync(uploadDir, { recursive: true });
  const fileName = `${prefix.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extByType[match[1]]}`;
  fs.writeFileSync(path.join(uploadDir, fileName), bytes);
  return `/uploads/${fileName}`;
}

function sanitizeCustomer(input = {}) {
  const phone = phone10(input.phone);
  if (!input.name || phone.length !== 10) throw new Error("Customer name and 10 digit phone are required");
  return {
    id: Number(input.id) || Date.now(),
    name: cleanText(input.name, "", 80),
    phone,
    address: cleanText(input.address, "", 200),
    city: cleanText(input.city, "Ambikapur", 80),
    notification: input.notification === false ? false : true,
    createdAt: input.createdAt || new Date().toISOString()
  };
}

function sanitizeWorkerInput(input = {}, status = "pending") {
  const phone = phone10(input.phone);
  const charge = Number(input.charge);
  if (!input.name || phone.length !== 10 || !services.includes(input.service) || !Number.isFinite(charge) || charge < 50) {
    throw new Error("Worker name, phone, service, and valid charge are required");
  }
  return {
    id: Number(input.id) || Date.now(),
    name: cleanText(input.name, "", 80),
    phone,
    service: input.service,
    area: cleanText(input.area, "Ambikapur", 80),
    charge: Math.round(charge),
    exp: cleanText(input.exp, "Experienced worker", 180),
    rating: Number(input.rating || 4.5),
    status: cleanText(input.status, "Offline", 30),
    verificationStatus: status,
    photoUrl: cleanText(input.photoUrl, "", 240),
    idUrl: cleanText(input.idUrl, "", 240),
    aadhaar: input.aadhaar ? validateAadhaar(input.aadhaar) : "",
    lat: Number(input.lat || (23.1226 + Math.random() / 30)),
    lng: Number(input.lng || (83.1956 + Math.random() / 30))
  };
}

function makeWorkerApplication(input = {}) {
  if (!input.photo?.dataUrl || !input.idProof?.dataUrl) throw new Error("Worker photo and ID proof are required");
  return {
    ...sanitizeWorkerInput(input, "pending"),
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
    service: worker.service,
    workerLocation: { lat: worker.lat, lng: worker.lng, area: worker.area },
    customerLocation: Number.isFinite(custLat) && Number.isFinite(custLng) ? { lat: custLat, lng: custLng } : null,
    base,
    commission,
    total,
    customerName: customer.name,
    customerPhone: customer.phone,
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
    `Hi ${booking.customerName}, your FixIt ${booking.service} service is marked completed.`,
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
  if (!filePath.startsWith(publicDir)) return sendError(res, 403, "Forbidden");
  fs.readFile(filePath, (err, data) => {
    if (err) return sendError(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
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
    return sendJson(res, 200, { ok: true, app: "FixIt Marketplace" });
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    return sendJson(res, 200, {
      services,
      workers: db.workers.filter(w => w.verificationStatus === "verified").map(publicWorker),
      settings: {
        commissionRate: COMMISSION_RATE,
        maxServiceRadiusKm: MAX_SERVICE_RADIUS_KM,
        upiId: process.env.FIXIT_UPI_ID || "test@razorpay",
        merchantName: process.env.FIXIT_MERCHANT_NAME || "FixIt",
        razorpayKeyId: RAZORPAY_KEY_ID,
        razorpayEnabled: Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/api/otp/request") {
    const body = await parseBody(req);
    const scope = cleanText(body.scope, "", 20);
    const phone = phone10(body.phone);
    try {
      const otp = createOtp(scope, phone);
      await sendOtpSms(phone, otp);
      return sendJson(res, 200, {
        ok: true,
        message: "OTP sent by SMS.",
        expiresInSeconds: OTP_TTL_MS / 1000
      });
    } catch (error) {
      otpRequests.delete(otpKey(scope, phone));
      return sendError(res, 400, error.message);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/otp/verify") {
    const body = await parseBody(req);
    const scope = cleanText(body.scope, "", 20);
    const phone = phone10(body.phone);
    try {
      const otpToken = verifyOtp(scope, phone, body.otp);
      return sendJson(res, 200, { ok: true, otpToken });
    } catch (error) {
      return sendError(res, 400, error.message);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/customer/login") {
    const body = await parseBody(req);
    const customer = sanitizeCustomer(body);
    requireOtpToken("customer", customer.phone, body.otpToken);
    const index = db.customers.findIndex(c => c.phone === customer.phone);
    if (index >= 0) db.customers[index] = { ...db.customers[index], ...customer };
    else db.customers.push(customer);
    writeDb(db);
    return sendJson(res, 200, { customer });
  }

  if (req.method === "GET" && url.pathname === "/api/customer/bookings") {
    const phone = phone10(url.searchParams.get("phone"));
    if (phone.length !== 10) return sendError(res, 400, "Valid customer phone is required");
    return sendJson(res, 200, { bookings: db.bookings.filter(b => b.customerPhone === phone) });
  }

  if (req.method === "POST" && url.pathname === "/api/worker/register") {
    const body = await parseBody(req);
    const phone = phone10(body.phone);
    if (db.workerApplications.some(a => a.phone === phone && a.verificationStatus === "pending")) return sendError(res, 409, "Pending application already exists");
    if (db.workers.some(w => w.phone === phone && w.verificationStatus === "verified")) return sendError(res, 409, "Worker already verified. Login with phone.");
    const application = makeWorkerApplication(body);
    db.workerApplications.push(application);
    writeDb(db);
    return sendJson(res, 201, { application });
  }

  if (req.method === "POST" && url.pathname === "/api/worker/login") {
    const body = await parseBody(req);
    const phone = phone10(body.phone);
    requireOtpToken("worker", phone, body.otpToken);
    const worker = db.workers.find(w => w.phone === phone);
    const application = db.workerApplications.find(a => a.phone === phone);
    if (!worker && !application) return sendError(res, 404, "No worker account or application found");
    return sendJson(res, 200, { worker, application });
  }

  if (req.method === "GET" && url.pathname === "/api/worker/dashboard") {
    const phone = phone10(url.searchParams.get("phone"));
    const worker = db.workers.find(w => w.phone === phone);
    const application = db.workerApplications.find(a => a.phone === phone);
    const bookings = worker ? db.bookings.filter(b => Number(b.workerId) === Number(worker.id)) : [];
    const reviews = worker ? db.reviews.filter(r => Number(r.workerId) === Number(worker.id)) : [];
    return sendJson(res, 200, { worker, application, bookings, reviews });
  }

  if (req.method === "PATCH" && url.pathname === "/api/worker/profile") {
    const body = await parseBody(req);
    const phone = phone10(body.phone);
    const worker = db.workers.find(w => w.phone === phone);
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

  if (req.method === "POST" && url.pathname === "/api/bookings") {
    const body = await parseBody(req);
    const worker = db.workers.find(w => Number(w.id) === Number(body.workerId) && w.verificationStatus === "verified");
    if (!worker) return sendError(res, 404, "Verified worker not found");
    const customer = sanitizeCustomer(body.customer || {});
    const customerLocation = body.customer?.lat !== undefined && body.customer?.lng !== undefined
      ? { lat: Number(body.customer.lat), lng: Number(body.customer.lng) }
      : null;
    const bookingDistanceKm = haversineKm({ lat: worker.lat, lng: worker.lng }, customerLocation);
    if (bookingDistanceKm !== null && bookingDistanceKm > MAX_SERVICE_RADIUS_KM) {
      return sendError(res, 400, `No ${worker.service} worker is within ${MAX_SERVICE_RADIUS_KM} km of this customer location`);
    }
    const existingCustomer = db.customers.findIndex(c => c.phone === customer.phone);
    if (existingCustomer >= 0) db.customers[existingCustomer] = { ...db.customers[existingCustomer], ...customer };
    else db.customers.push(customer);
    const booking = makeBooking(worker, { ...customer, lat: body.customer?.lat, lng: body.customer?.lng }, {
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
    const id = Number(bookingAction[1]);
    const action = bookingAction[2];
    const body = await parseBody(req);
    const booking = db.bookings.find(b => Number(b.id) === id);
    if (!booking) return sendError(res, 404, "Booking not found");
    const worker = db.workers.find(w => Number(w.id) === Number(booking.workerId));
    if (body.workerPhone && worker && worker.phone !== phone10(body.workerPhone)) return sendError(res, 403, "This booking is assigned to another worker");
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
    const body = await parseBody(req);
    const booking = db.bookings.find(b => Number(b.id) === Number(body.bookingId));
    if (!booking) return sendError(res, 404, "Booking not found");
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
    const body = await parseBody(req);
    const message = cleanText(body.message, "", 280);
    const reply = message.toLowerCase().includes("refund")
      ? "Refund ya payment issue ke liye booking ID bhejiye. Admin panel me payment status check karke support karega."
      : message.toLowerCase().includes("worker")
        ? "Worker late hai to booking status open kijiye. Worker location aur call option customer booking card par dikh raha hai."
        : "FixIt support: booking, worker verification, payment, address, ya review ke liye apna phone aur booking detail bhejiye.";
    const ticket = { id: Date.now(), phone: phone10(body.phone), message, reply, createdAt: new Date().toISOString() };
    db.helpTickets.push(ticket);
    writeDb(db);
    return sendJson(res, 200, { reply, ticket });
  }

  if (req.method === "POST" && url.pathname === "/api/create-order") {
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
    if (req.url.startsWith("/api/")) await handleApi(req, res);
    else serveStatic(req, res);
  } catch (error) {
    sendError(res, 400, error.message || "Request failed");
  }
});

ensureDb();
server.listen(PORT, () => {
  console.log(`FixIt Marketplace is running at http://localhost:${PORT}`);
});
