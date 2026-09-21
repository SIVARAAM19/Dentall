// ============================================================
//  DENTALL — server.js  (Production-Ready, Fully Secured)
//  ─────────────────────────────────────────────────────────
//  SWITCHING FROM TEST → PRODUCTION:
//    1. In .env set:  USE_MOCK_SHIPROCKET=false
//    2. In .env set:  NODE_ENV=production
//    3. Replace Razorpay test keys with live keys in .env
//    4. Update CORS origin to your real domain in .env:
//       ALLOWED_ORIGIN=https://yourdomain.com
//    5. Run:  npm install  (all deps already listed below)
//    That's it. Zero code changes needed.
//
//  REQUIRED ENV VARS (all must be set — server won't start without them):
//    RAZORPAY_KEY_ID          — from Razorpay dashboard
//    RAZORPAY_KEY_SECRET      — from Razorpay dashboard
//    RAZORPAY_WEBHOOK_SECRET  — from Razorpay dashboard → Webhooks
//    DB_HOST                  — MySQL host (e.g. localhost)
//    DB_USER                  — MySQL username
//    DB_PASS                  — MySQL password
//    DB_NAME                  — MySQL database name
//    EMAIL_FROM               — Gmail address for sending receipts
//    EMAIL_PASS               — Gmail app password (not your login password)
//    NODE_ENV                 — 'development' or 'production'
//    USE_MOCK_SHIPROCKET       — 'true' for testing, 'false' for real shipping
//    ALLOWED_ORIGIN            — your frontend URL e.g. https://yourdomain.com
//    YOUR_PINCODE              — your warehouse/pickup pincode
//    SHIPROCKET_EMAIL          — (required only when USE_MOCK_SHIPROCKET=false)
//    SHIPROCKET_PASSWORD       — (required only when USE_MOCK_SHIPROCKET=false)
//    SHIPROCKET_PASSWORD_B64   — optional: base64 of the password, used instead of SHIPROCKET_PASSWORD
//                                when the password has special characters ($ # & ! ^)
//    SITE_URL                  — your public site URL for email links
//    DENTALL_ADMIN_SECRET      — secret for the /admin panel (x-admin-token header)
//
//  DEPENDENCIES:
//    npm install express razorpay crypto nodemailer mysql2 axios
//                cors dotenv helmet express-rate-limit pdfkit
// ============================================================

'use strict';

const express    = require('express');
const Razorpay   = require('razorpay');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const mysql      = require('mysql2/promise');
const axios      = require('axios');
const cors       = require('cors');
const path       = require('path');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const PDFDocument = require('pdfkit');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// ============================================================
//  STEP 1 — FAIL FAST: validate all required env vars on boot
//  Server will refuse to start if anything critical is missing.
// ============================================================
const ALWAYS_REQUIRED = [
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME',
  'EMAIL_FROM', 'EMAIL_PASS',
  'NODE_ENV',
  'USE_MOCK_SHIPROCKET',
  'ALLOWED_ORIGIN',
  'YOUR_PINCODE',
  'SITE_URL',
  'DENTALL_ADMIN_SECRET',
];

// Shiprocket creds only needed in real mode. The password may be supplied either
// as SHIPROCKET_PASSWORD or, when it contains characters hosting panels mangle
// ($ # & ! ^ ...), base64-encoded as SHIPROCKET_PASSWORD_B64.
const USE_MOCK = process.env.USE_MOCK_SHIPROCKET === 'true';
if (!USE_MOCK) {
  ALWAYS_REQUIRED.push('SHIPROCKET_EMAIL');
  if (!process.env.SHIPROCKET_PASSWORD_B64) ALWAYS_REQUIRED.push('SHIPROCKET_PASSWORD');
}

function getShiprocketCredentials() {
  const b64 = (process.env.SHIPROCKET_PASSWORD_B64 || '').trim();
  return {
    email:    (process.env.SHIPROCKET_EMAIL || '').trim(),
    password: b64
      ? Buffer.from(b64, 'base64').toString('utf8')
      : (process.env.SHIPROCKET_PASSWORD || '').trim(),
    source:   b64 ? 'SHIPROCKET_PASSWORD_B64' : 'SHIPROCKET_PASSWORD',
  };
}

const missingEnv = ALWAYS_REQUIRED.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error('\n❌ FATAL — Missing required environment variables:');
  missingEnv.forEach(k => console.error(`   • ${k}`));
  console.error('\nServer will NOT start until these are set in .env\n');
  process.exit(1);
}

const IS_PROD = process.env.NODE_ENV === 'production';

console.log(`\n🚀 DENTALL server booting...`);
console.log(`   Mode:     ${IS_PROD ? '🔴 PRODUCTION' : '🟡 DEVELOPMENT'}`);
console.log(`   Shipping: ${USE_MOCK ? '🧪 MOCK Shiprocket' : '✅ REAL Shiprocket'}`);
if (!USE_MOCK) {
  // Length only — never log the password itself. Helps spot values that a
  // hosting panel truncated or altered (e.g. cut at a "#").
  const c = getShiprocketCredentials();
  console.log(`   Shiprocket login: ${c.email.replace(/(.{2}).+(@.+)/, '$1****$2')} | password from ${c.source}, ${c.password.length} chars`);
}
console.log(`   Origin:   ${process.env.ALLOWED_ORIGIN}\n`);

// ============================================================
//  STEP 2 — CATALOGUE: product price truth (backend is master)
//  Frontend prices are NEVER trusted for charge amounts.
//  These starting values are just a seed/fallback — once the server boots
//  and connects to MySQL, live prices are loaded from the `pricing` table
//  and kept in sync from there (see STEP 6 and /api/admin/pricing).
//  Edit prices via the /admin panel, not by changing this file.
// ============================================================
const PRODUCT_CATALOGUE = {
  'family-pack':  { name: 'Family Pack (12 brushes)', price: 599, mrp: null, maxQty: 10 },
};

// ============================================================
//  STEP 3 — INPUT SANITIZATION helpers
// ============================================================
function sanitizeStr(val, maxLen = 255) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen).replace(/[<>"'`]/g, '');
}

function sanitizePhone(val) {
  return String(val || '').replace(/[^\d+\-\s()]/g, '').trim().slice(0, 20);
}

function sanitizePincode(val) {
  return String(val || '').replace(/\D/g, '').slice(0, 6);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function isValidPincode(pin) {
  return /^\d{6}$/.test(pin);
}

function isValidPhone(phone) {
  // 10-digit Indian mobile, must start with 6–9
  return /^[6-9]\d{9}$/.test(String(phone).replace(/[\s\-()]/g, ''));
}

// Safe integer — prevents NaN and float abuse
function safeInt(val, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return min;
  return Math.min(Math.max(n, min), max);
}

// Validate and compute trusted total from server-side catalogue
function validateCartItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('Cart is empty or invalid');
  }
  return rawItems.map(item => {
    const ref = PRODUCT_CATALOGUE[item.id];
    if (!ref) throw new Error(`Unknown product: ${item.id}`);
    const qty = safeInt(item.qty, 1, ref.maxQty);
    return {
      id:    item.id,
      name:  ref.name,           // use server name, not client name
      price: ref.price,          // use server price, not client price
      qty,
      icon:  item.id === 'family-pack' ? '🦷' : '🪥',
    };
  });
}

// ============================================================
//  COUPONS — live-loaded from the `coupons` table (see STEP 6).
//  Keyed by uppercased code. Managed via /api/admin/coupons.
// ============================================================
const COUPONS = {};

function getCouponDiscount(code) {
  if (!code) return { code: null, discountPercent: 0 };
  const key = String(code).trim().toUpperCase();
  const c   = COUPONS[key];
  if (!c || !c.active) return { code: null, discountPercent: 0 };
  return { code: key, discountPercent: c.discountPercent };
}

// Single source of truth for cart math — used by BOTH /api/create-order and
// /api/verify-payment so the two totals always agree (Razorpay amount must
// exactly match what verify-payment recomputes, or the payment is rejected).
function computeCartTotal(cartItems, shippingCharge, couponCode) {
  const subtotal = cartItems.reduce((sum, i) => sum + i.price * i.qty, 0);
  const { code, discountPercent } = getCouponDiscount(couponCode);
  const discountAmount = Math.round(subtotal * discountPercent) / 100;
  const total = Math.round((subtotal - discountAmount + shippingCharge) * 100) / 100;
  return { subtotal, couponCode: code, discountPercent, discountAmount, total };
}

// ============================================================
//  STEP 4 — EXPRESS APP + SECURITY MIDDLEWARE
// ============================================================
const app = express();

// Trust proxy if behind nginx/load balancer (for rate limiter IP detection)
if (IS_PROD) app.set('trust proxy', 1);

// Helmet — sets secure HTTP headers
app.use(helmet({
  contentSecurityPolicy: IS_PROD ? undefined : false, // relax CSP in dev
}));

// CORS — strict origin whitelist (supports comma-separated ALLOWED_ORIGIN)
const allowedOrigins = IS_PROD
  ? process.env.ALLOWED_ORIGIN.split(',').map(o => o.trim())
  : [
      ...process.env.ALLOWED_ORIGIN.split(',').map(o => o.trim()),
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:5174',
    ];

if (!IS_PROD) {
  // Development: allow requests from any origin (simpler for LAN/dev testing)
  app.use((req, res, next) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-admin-token');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });
} else {
  app.use(cors({
    origin: (origin, cb) => {
      // Production: allow same-origin requests (no Origin header) and listed origins
      try { console.log('CORS origin check:', origin); console.log('Allowed origins:', allowedOrigins.join(',')); } catch (e) {}
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      console.warn(`⛔ CORS blocked origin: ${origin}`);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
  }));
}

// ── Webhook route MUST receive raw body before JSON middleware ──
app.post(
  '/api/razorpay-webhook',
  express.raw({ type: 'application/json' }),
  handleWebhook
);

// JSON body parser for all other routes (4KB limit — prevents payload bombs)
app.use(express.json({ limit: '4kb' }));

// Serve React build in production
app.use(express.static(path.join(__dirname, 'dist')));

// ============================================================
//  STEP 5 — RATE LIMITERS
// ============================================================

// General API limiter — 120 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

// Payment limiter — 10 attempts per 15 minutes per IP (prevents brute force)
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment attempts. Please wait 15 minutes.' },
  skipSuccessfulRequests: false,
});

// Lead capture limiter — 5 per hour per IP (prevents spam)
const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many submissions. Try again in an hour.' },
});

// Shipping check limiter — 30 per minute per IP
const shippingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many shipping checks. Please wait.' },
});

// Apply general limiter to all /api/ routes
app.use('/api/', generalLimiter);

// ============================================================
//  STEP 6 — DATABASE
// ============================================================
const db = mysql.createPool({
  host:               process.env.DB_HOST,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  database:           process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         30,
  // Prevent SQL injection via type coercion
  typeCast: (field, next) => {
    if (field.type === 'TINY' && field.length === 1) return field.string() === '1';
    return next();
  },
});

db.getConnection()
  .then(async conn => {
    console.log('✅ MySQL connected');
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS reviews (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL,
        email         VARCHAR(255) NOT NULL,
        rating        TINYINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
        review_text   TEXT NOT NULL,
        approved      BOOLEAN DEFAULT FALSE,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_email    (email),
        INDEX idx_approved (approved),
        INDEX idx_created  (created_at)
      )
    `);
    console.log('✅ reviews table ready');
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS wholesale_enquiries (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        full_name      VARCHAR(150) NOT NULL,
        business_name  VARCHAR(180) NOT NULL,
        email          VARCHAR(150) NOT NULL,
        phone          VARCHAR(20)  NOT NULL,
        city           VARCHAR(100) NOT NULL,
        state          VARCHAR(100) NOT NULL,
        quantity_range VARCHAR(30)  NOT NULL,
        business_type  VARCHAR(60),
        message        TEXT,
        status         VARCHAR(40) DEFAULT 'new',
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_email   (email),
        INDEX idx_status  (status),
        INDEX idx_created (created_at)
      )
    `);
    console.log('wholesale_enquiries table ready');

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS pricing (
        product_id VARCHAR(50) PRIMARY KEY,
        price      DECIMAL(10,2) NOT NULL,
        mrp        DECIMAL(10,2) NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    // Seed with the hardcoded fallback prices the first time this table is empty
    for (const [id, ref] of Object.entries(PRODUCT_CATALOGUE)) {
      await conn.execute(
        'INSERT IGNORE INTO pricing (product_id, price, mrp) VALUES (?, ?, ?)',
        [id, ref.price, ref.mrp]
      );
    }
    // Load live prices from DB — this is what actually governs checkout amounts from here on
    const [priceRows] = await conn.execute('SELECT product_id, price, mrp FROM pricing');
    for (const row of priceRows) {
      if (PRODUCT_CATALOGUE[row.product_id]) {
        PRODUCT_CATALOGUE[row.product_id].price = Number(row.price);
        PRODUCT_CATALOGUE[row.product_id].mrp   = row.mrp === null ? null : Number(row.mrp);
      }
    }
    console.log('✅ pricing table ready, live prices loaded:',
      Object.fromEntries(Object.entries(PRODUCT_CATALOGUE).map(([id, r]) => [id, r.price])));

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS coupons (
        code             VARCHAR(30) PRIMARY KEY,
        discount_percent DECIMAL(5,2) NOT NULL,
        active           BOOLEAN DEFAULT TRUE,
        created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    const [couponRows] = await conn.execute('SELECT code, discount_percent, active FROM coupons');
    for (const row of couponRows) {
      COUPONS[row.code] = { discountPercent: Number(row.discount_percent), active: !!row.active };
    }
    console.log(`✅ coupons table ready, ${couponRows.length} coupon(s) loaded`);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS dealer_enquiries (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        contact_name  VARCHAR(150) NOT NULL,
        shop_name     VARCHAR(180) NOT NULL,
        gstin         VARCHAR(15)  NOT NULL,
        email         VARCHAR(150) NOT NULL,
        phone         VARCHAR(20)  NOT NULL,
        address       TEXT         NOT NULL,
        city          VARCHAR(100) NOT NULL,
        state         VARCHAR(100) NOT NULL,
        pincode       VARCHAR(6)   NOT NULL,
        quantity      INT          NOT NULL,
        message       TEXT,
        status        VARCHAR(30)  DEFAULT 'new',
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_dealer_email   (email),
        INDEX idx_dealer_status  (status),
        INDEX idx_dealer_created (created_at)
      )
    `);
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS dealer_quotes (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        enquiry_id      INT           NOT NULL,
        token           CHAR(64)      NOT NULL,
        quantity        INT           NOT NULL,
        goods_total     DECIMAL(12,2) NOT NULL,
        gst_percent     DECIMAL(5,2)  NOT NULL DEFAULT 0,
        freight         DECIMAL(10,2) NOT NULL DEFAULT 0,
        advance_percent DECIMAL(5,2)  NOT NULL DEFAULT 0,
        notes           TEXT,
        valid_until     DATE          NOT NULL,
        status          VARCHAR(20)   NOT NULL DEFAULT 'sent',
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_quote_token (token),
        INDEX idx_quote_enquiry (enquiry_id)
      )
    `);
    console.log('✅ dealer_enquiries + dealer_quotes tables ready');

    // Older installs may not have these columns yet — add them defensively
    for (const stmt of [
      'ALTER TABLE orders ADD COLUMN coupon_code VARCHAR(30) NULL',
      'ALTER TABLE orders ADD COLUMN discount_amount DECIMAL(10,2) DEFAULT 0',
    ]) {
      await conn.execute(stmt).catch(() => {}); // ignore "duplicate column" if it already exists
    }

    conn.release();
  })
  .catch(err  => {
    console.error('❌ MySQL connection failed:', err.message);
    if (IS_PROD) process.exit(1);
  });

// ============================================================
//  STEP 7 — RAZORPAY
// ============================================================
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ============================================================
//  STEP 8 — SHIPROCKET (token cache + helpers)
// ============================================================
let shiprocketToken  = null;
let tokenExpiry      = 0;

async function getShiprocketToken() {
  if (shiprocketToken && Date.now() < tokenExpiry) return shiprocketToken;
  const { email, password } = getShiprocketCredentials();
  let data;
  try {
    ({ data } = await axios.post(
      'https://apiv2.shiprocket.in/v1/external/auth/login',
      { email, password },
      { timeout: 10000 }
    ));
  } catch (e) {
    if (e.response?.status === 403 || e.response?.status === 401) {
      console.error('❌ Shiprocket login rejected — check SHIPROCKET_EMAIL and the API user password ' +
        '(if it has special characters, set SHIPROCKET_PASSWORD_B64 instead)');
    }
    throw e;
  }
  shiprocketToken = data.token;
  tokenExpiry     = Date.now() + 9 * 24 * 60 * 60 * 1000; // 9 days (token lasts 10)
  return shiprocketToken;
}

// ── MOCK helpers (only active when USE_MOCK_SHIPROCKET=true) ──
function mockShippingCost() {
  return { shipping_charge: 50, courier_name: 'DTDC Express (TEST)', estimated_delivery: '3-5' };
}

function mockShiprocketOrder(orderId) {
  return { awb_code: `TEST-AWB-${orderId}-${Date.now()}`, shipment_id: `SHIP-${orderId}` };
}

function mockTrackingData(awbNumber, orderId) {
  return {
    shipment_status: 'IN TRANSIT',
    awb_code:        awbNumber,
    order_id:        orderId,
    etd:             'Within 3-5 business days',
    tracking_data: [
      { activity: 'Shipment picked up from seller',  date: new Date().toLocaleDateString('en-IN'), location: 'Puducherry Facility' },
      { activity: 'In transit to Chennai hub',       date: new Date().toLocaleDateString('en-IN'), location: 'Chennai Hub'         },
      { activity: 'Out for delivery',               date: new Date().toLocaleDateString('en-IN'), location: 'Local Delivery Centre' },
    ],
  };
}

// Single source of truth for the delivery charge — used by /api/shipping-cost
// (display) AND /api/create-order (the amount actually charged).
async function getShippingQuote(pincode, weight) {
  if (USE_MOCK) {
    console.log(`[MOCK] Shipping cost → pincode ${pincode}, weight ${weight}kg`);
    return mockShippingCost();
  }

  try {
    const token    = await getShiprocketToken();
    const { data } = await axios.get(
      'https://apiv2.shiprocket.in/v1/external/courier/serviceability/',
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          pickup_postcode:   process.env.YOUR_PINCODE,
          delivery_postcode: pincode,
          weight,
          cod:               0,
        },
        timeout: 10000,
      }
    );

    const companies = data.data?.available_courier_companies || [];
    companies.sort((a, b) => (a.rate || 0) - (b.rate || 0));
    const cheapest = companies[0];

    return {
      shipping_charge:    cheapest?.rate                    ?? 0,
      courier_name:       cheapest?.courier_name            ?? 'Standard Delivery',
      estimated_delivery: cheapest?.estimated_delivery_days ?? '5-7',
    };
  } catch (e) {
    console.error('Shiprocket serviceability error:', e.response?.data || e.message);
    // Safe fallback rather than exposing internal errors
    return { shipping_charge: 99, courier_name: 'Standard Delivery', estimated_delivery: '5-7' };
  }
}

// Shipping weight — ⚠️ keep in sync with UNIT_WEIGHT_KG / MIN_SHIPMENT_WEIGHT_KG in
// frontend/src/data/dentallData.js so the quote shown equals the amount charged.
// One family pack ≈ 0.25 kg (2 packs = 0.5 kg); Shiprocket minimum is 0.5 kg.
const UNIT_WEIGHT_KG         = 0.25;
const MIN_SHIPMENT_WEIGHT_KG = 0.5;
const cartWeight = cartItems =>
  Math.max(MIN_SHIPMENT_WEIGHT_KG, cartItems.reduce((s, i) => s + i.qty * UNIT_WEIGHT_KG, 0));

// ── REAL Shiprocket order creation (3-step: create → courier → AWB) ──
async function createShiprocketOrder({ orderId, customer, cartItems, totalAmount }) {
  const token   = await getShiprocketToken();
  const headers = { Authorization: `Bearer ${token}` };

  const totalQty    = cartItems.reduce((s, i) => s + i.qty, 0);
  const totalWeight = cartWeight(cartItems);

  const items = cartItems.map(i => ({
    name:          i.name,
    sku:           i.id,
    units:         i.qty,
    selling_price: i.price,
    discount: 0, tax: 0, hsn: 96190,  // HSN code for toothbrushes
  }));

  // ── Step 1: Create order in Shiprocket ──
  const { data: orderResp } = await axios.post(
    'https://apiv2.shiprocket.in/v1/external/orders/create/adhoc',
    {
      order_id:              `DNT-${orderId}`,
      order_date:            new Date().toISOString().slice(0, 19).replace('T', ' '),
      pickup_location:       'Home',
      billing_customer_name: customer.name,
      billing_last_name:     '',
      billing_address:       customer.address,
      billing_address_2:     '',
      billing_city:          customer.city,
      billing_pincode:       customer.pincode,
      billing_state:         customer.state,
      billing_country:       'India',
      billing_email:         customer.email,
      billing_phone:         customer.phone,
      shipping_is_billing:   true,
      order_items:           items,
      payment_method:        'Prepaid',
      sub_total:             totalAmount,
      length:  20,
      breadth: 15,
      height:  Math.min(30, 5 * totalQty),
      weight:  totalWeight,
    },
    { headers, timeout: 15000 }
  );

  const shipmentId = orderResp.shipment_id;
  if (!shipmentId) {
    throw new Error('Shiprocket order creation failed: ' + JSON.stringify(orderResp));
  }
  console.log(`   Shiprocket shipment created: id=${shipmentId}`);

  // ── Step 2: Find cheapest available courier ──
  const { data: serviceResp } = await axios.get(
    'https://apiv2.shiprocket.in/v1/external/courier/serviceability/',
    {
      headers,
      params: {
        pickup_postcode:   process.env.YOUR_PINCODE,
        delivery_postcode: customer.pincode,
        weight:            totalWeight,
        cod:               0,
      },
      timeout: 10000,
    }
  );

  const couriers  = serviceResp.data?.available_courier_companies || [];
  couriers.sort((a, b) => (a.rate || 0) - (b.rate || 0));
  const courierId = couriers[0]?.courier_company_id;
  if (!courierId) {
    throw new Error(`No courier available from ${process.env.YOUR_PINCODE} to ${customer.pincode}`);
  }
  console.log(`   Courier: ${couriers[0].courier_name} (id=${courierId})`);

  // ── Step 3: Assign courier and generate AWB ──
  const { data: awbResp } = await axios.post(
    'https://apiv2.shiprocket.in/v1/external/courier/assign/awb',
    { shipment_id: String(shipmentId), courier_id: String(courierId) },
    { headers, timeout: 15000 }
  );

  const awbCode = awbResp.response?.data?.awb_code || awbResp.awb_code;
  if (!awbCode) {
    throw new Error('Shiprocket AWB assignment failed: ' + JSON.stringify(awbResp));
  }

  return {
    awb_code:            awbCode,
    shipment_id:         String(shipmentId),
    shiprocket_order_id: String(orderResp.order_id),
  };
}

// ============================================================
//  STEP 9 — PDF RECEIPT GENERATOR
// ============================================================
async function generateReceiptPDF(customer, orderData) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data',  c  => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Header bar — sage green ──
    doc.rect(0, 0, 612, 100).fill('#5F7D65');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(28).text('DENTALL', 50, 30);
    doc.font('Helvetica').fontSize(10).text('Professional Dental Care', 50, 65);
    doc.fillColor('rgba(255,255,255,0.8)').fontSize(10).text('RECEIPT', 490, 45, { align: 'right' });

    // ── Order info box — pale green ──
    doc.rect(50, 120, 512, 80).fill('#F2F6EC');
    doc.fillColor('#5F7D65').font('Helvetica-Bold').fontSize(11)
       .text(`Order ID: DNT-${orderData.orderId}`, 65, 135);
    doc.fillColor('#2D3B34').font('Helvetica').fontSize(10)
       .text(`Payment: ${orderData.razorpay_payment_id.slice(0, 8)}****`, 65, 153)
       .text(`Date: ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}`, 65, 170)
       .text(`AWB: ${orderData.awb?.awb_code || 'Processing'}`, 300, 153);

    // ── Customer section ──
    doc.fillColor('#2D3B34').font('Helvetica-Bold').fontSize(12).text('Bill To:', 50, 220);
    doc.font('Helvetica').fontSize(10).fillColor('#5F6F63')
       .text(customer.name,    50, 238)
       .text(customer.email,   50, 253)
       .text(customer.phone,   50, 268)
       .text(customer.address, 50, 283)
       .text(`${customer.city} - ${customer.pincode}`, 50, 298)
       .text(`${customer.state}, India`, 50, 313);

    // ── Table header — dark secondary ──
    doc.rect(50, 340, 512, 25).fill('#435563');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10)
       .text('Item', 65, 349).text('Qty', 380, 349).text('Price', 430, 349).text('Total', 490, 349);

    // ── Items ──
    let y = 375;
    orderData.cartItems.forEach((item, i) => {
      if (i % 2 === 0) doc.rect(50, y - 5, 512, 22).fill('#F8FAF4');
      doc.fillColor('#2D3B34').font('Helvetica').fontSize(10)
         .text(item.name, 65, y)
         .text(String(item.qty), 385, y)
         .text(`Rs.${item.price.toLocaleString('en-IN')}`, 430, y)
         .text(`Rs.${(item.price * item.qty).toLocaleString('en-IN')}`, 485, y);
      y += 25;
    });

    // ── Totals ──
    y += 10;
    doc.moveTo(50, y).lineTo(562, y).strokeColor('#C8D6BE').lineWidth(1).stroke();
    y += 15;
    if (orderData.discountAmount > 0) {
      doc.fillColor('#5F6F63').font('Helvetica').fontSize(10)
         .text(`Discount${orderData.couponCode ? ` (${orderData.couponCode})` : ''}:`, 380, y)
         .text(`-Rs.${orderData.discountAmount.toLocaleString('en-IN')}`, 490, y);
      y += 20;
    }
    doc.fillColor('#5F6F63').font('Helvetica').fontSize(10)
       .text('Shipping:', 400, y)
       .text(orderData.shippingCharge === 0 ? 'FREE' : `Rs.${orderData.shippingCharge}`, 490, y);
    y += 20;
    doc.rect(380, y - 5, 182, 28).fill('#90AB8B');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(13)
       .text('TOTAL:', 390, y + 2)
       .text(`Rs.${orderData.totalAmount.toLocaleString('en-IN')}`, 455, y + 2);

    // ── Footer ──
    doc.rect(0, 750, 612, 92).fill('#F2F6EC');
    doc.fillColor('#5F6F63').font('Helvetica').fontSize(9)
       .text('Thank you for choosing DENTALL!', 50, 762, { align: 'center', width: 512 })
       .text('Replace your brush every 4 months for best results.', 50, 777, { align: 'center', width: 512 })
       .text('Questions? support@dentall.in', 50, 792, { align: 'center', width: 512 })
       .text('© 2025 DENTALL. All rights reserved.', 50, 807, { align: 'center', width: 512 });

    doc.end();
  });
}

// ============================================================
//  STEP 10 — EMAIL RECEIPT SENDER
// ============================================================
function createMailTransport({ allowExpiredCerts = false } = {}) {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || 'true') !== 'false',
    family: Number(process.env.SMTP_FAMILY || 4),
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT || 15000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || 15000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 30000),
    auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_PASS },
    tls: {
      servername: process.env.SMTP_HOST || 'smtp.gmail.com',
      minVersion: 'TLSv1.2',
      rejectUnauthorized: !allowExpiredCerts,
    },
  });
}

async function sendDentallMail(mailOptions) {
  try {
    return await createMailTransport().sendMail(mailOptions);
  } catch (err) {
    const errText = `${err.message || ''} ${err.code || ''}`;
    const certExpired = /certificate has expired|CERT_HAS_EXPIRED/i.test(errText);
    const ipv6Unreachable = /ENETUNREACH.*:465|network is unreachable/i.test(errText);
    const allowFallback = !IS_PROD || process.env.SMTP_ALLOW_EXPIRED_CERTS === 'true';

    if (ipv6Unreachable && process.env.SMTP_FAMILY !== '6') {
      console.warn('SMTP IPv6 route unreachable; retrying Gmail SMTP over IPv4.');
      return createMailTransport().sendMail(mailOptions);
    }

    if (!certExpired || !allowFallback) throw err;

    console.warn('SMTP certificate expired; retrying with TLS certificate verification disabled for this email.');
    return createMailTransport({ allowExpiredCerts: true }).sendMail(mailOptions);
  }
}

async function sendReceiptEmail(customer, orderData) {
  if (!isValidEmail(customer.email)) {
    console.log('⚠️  Skipping email — invalid recipient');
    return;
  }

  const pdfBuffer = await generateReceiptPDF(customer, orderData);

  const trackUrl = `${process.env.SITE_URL}/#shipment?order=${orderData.orderId}`;

  await sendDentallMail({
    from:    `DENTALL 🦷 <${process.env.EMAIL_FROM}>`,
    to:      customer.email,
    subject: `✅ Your DENTALL Order #DNT-${orderData.orderId} — Receipt Enclosed`,
    html: `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#3B1A08,#C8102E);padding:2rem;text-align:center;border-radius:12px 12px 0 0">
        <h1 style="color:#fff;margin:0;font-size:1.8rem">DENTALL 🦷</h1>
        <p style="color:rgba(255,255,255,.8);margin:.3rem 0 0">Order Confirmed!</p>
      </div>
      <div style="padding:2rem;background:#FFFBF5;border:1px solid #E8D5B0">
        <h2 style="color:#C8102E">Hi ${sanitizeStr(customer.name)}! 🎉</h2>
        <p style="color:#4A2C10;line-height:1.7">
          Your payment of <strong>₹${orderData.totalAmount.toLocaleString('en-IN')}</strong>
          was successful. Your DENTALL brushes will be shipped within 24 hours.
        </p>
        <div style="background:#FFF3E8;border-left:4px solid #C8102E;padding:1rem;margin:1.5rem 0;border-radius:4px">
          <p style="margin:0;color:#C8102E;font-weight:700">Order ID: DNT-${orderData.orderId}</p>
          <p style="margin:.3rem 0 0;color:#4A2C10;font-size:.9rem">AWB: ${orderData.awb?.awb_code || 'Will be updated soon'}</p>
        </div>
        <div style="text-align:center;margin:1.5rem 0">
          <a href="${trackUrl}" style="background:linear-gradient(135deg,#C8102E,#1a2642);color:#fff;text-decoration:none;padding:.9rem 2.5rem;border-radius:30px;font-weight:700;font-size:.85rem;display:inline-block">
            📦 Track My Order →
          </a>
        </div>
        <p style="color:#8A6040;font-size:.78rem;text-align:center;line-height:1.7">
          📎 Your PDF receipt is attached to this email.<br>
          Questions? Reply to this email or contact support@dentall.in
        </p>
      </div>
      <div style="background:#F5EDDC;padding:1rem;text-align:center;border-radius:0 0 12px 12px;font-size:.72rem;color:#8A6040">
        © 2025 DENTALL — support@dentall.in
      </div>
    </div>`,
    attachments: [{
      filename:    `DENTALL-Receipt-DNT-${orderData.orderId}.pdf`,
      content:     pdfBuffer,
      contentType: 'application/pdf',
    }],
  });

  console.log(`✅ PDF receipt emailed to ${customer.email.replace(/(.{2}).+(@.+)/, '$1****$2')}`);
}

async function generateWholesalePricingPDF(enquiry) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, 612, 96).fill('#C8102E');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(28).text('DENTALL', 50, 28);
    doc.font('Helvetica').fontSize(11).text('Wholesale Pricing Proposal', 50, 62);

    doc.fillColor('#1f2933').font('Helvetica-Bold').fontSize(16).text('Thank you for your enquiry', 50, 125);
    doc.font('Helvetica').fontSize(10).fillColor('#4b5563')
      .text(`Prepared for: ${enquiry.name}`, 50, 152)
      .text(`Business: ${enquiry.business}`, 50, 168)
      .text(`Quantity range: ${enquiry.qty}`, 50, 184)
      .text(`Location: ${enquiry.city}, ${enquiry.state}`, 50, 200);

    doc.rect(50, 238, 512, 28).fill('#1f2933');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10)
      .text('Order Slab', 66, 248)
      .text('Indicative Unit Price', 240, 248)
      .text('Notes', 390, 248);

    const rows = [
      ['100 - 499 brushes', 'Rs. 185 - 210', 'Starter wholesale slab'],
      ['500 - 999 brushes', 'Rs. 160 - 184', 'Better retailer margin'],
      ['1,000 - 4,999 brushes', 'Rs. 135 - 159', 'Distributor pricing'],
      ['5,000+ brushes', 'Custom quote', 'Best landed pricing'],
    ];

    let y = 280;
    rows.forEach((row, index) => {
      if (index % 2 === 0) doc.rect(50, y - 8, 512, 32).fill('#fff5f7');
      doc.fillColor('#1f2933').font('Helvetica').fontSize(10)
        .text(row[0], 66, y)
        .text(row[1], 240, y)
        .text(row[2], 390, y, { width: 150 });
      y += 36;
    });

    y += 16;
    doc.fillColor('#C8102E').font('Helvetica-Bold').fontSize(13).text('Included benefits', 50, y);
    y += 24;
    [
      'MOQ starts at 100 brushes.',
      'Custom branding and packaging available for qualifying orders.',
      'Final quote depends on quantity, branding, delivery location, and tax invoice details.',
      'Sales team will contact you within 24 hours with a confirmed quotation.',
    ].forEach(item => {
      doc.fillColor('#4b5563').font('Helvetica').fontSize(10).text(`- ${item}`, 62, y);
      y += 18;
    });

    doc.rect(50, 640, 512, 72).fill('#f3f4f6');
    doc.fillColor('#1f2933').font('Helvetica-Bold').fontSize(11).text('Next step', 68, 658);
    doc.font('Helvetica').fontSize(10).fillColor('#4b5563')
      .text('Reply to this email with GST details, delivery pincode, and preferred quantity for a formal invoice-ready quote.', 68, 678, { width: 470 });

    doc.fillColor('#6b7280').fontSize(8)
      .text('This PDF contains indicative wholesale pricing only. Taxes, freight, and branding charges may vary.', 50, 762, { align: 'center', width: 512 })
      .text('DENTALL - support@dentall.in', 50, 778, { align: 'center', width: 512 });

    doc.end();
  });
}

async function sendWholesalePricingEmail(enquiry) {
  if (!isValidEmail(enquiry.email)) return;

  const pdfBuffer = await generateWholesalePricingPDF(enquiry);
  await sendDentallMail({
    from: `DENTALL Wholesale <${process.env.EMAIL_FROM}>`,
    to: enquiry.email,
    subject: 'DENTALL Wholesale Pricing PDF',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#C8102E;color:#fff;padding:24px;border-radius:10px 10px 0 0">
          <h1 style="margin:0;font-size:24px">DENTALL Wholesale</h1>
          <p style="margin:6px 0 0">Your pricing PDF is attached.</p>
        </div>
        <div style="border:1px solid #eee;border-top:0;padding:24px;color:#333;line-height:1.7">
          <p>Hi ${sanitizeStr(enquiry.name)},</p>
          <p>Thanks for your wholesale enquiry for <strong>${sanitizeStr(enquiry.business)}</strong>. We have received your requirement for <strong>${sanitizeStr(enquiry.qty)}</strong> brushes.</p>
          <p>Our sales team will contact you within 24 hours with confirmed pricing, delivery options, and any custom branding details.</p>
          <p style="font-size:12px;color:#777">The attached PDF contains indicative slabs for quick planning.</p>
        </div>
      </div>`,
    attachments: [{
      filename: 'DENTALL-Wholesale-Pricing.pdf',
      content: pdfBuffer,
      contentType: 'application/pdf',
    }],
  });
}

// ============================================================
//  ROUTE: POST /api/razorpay-webhook
//  Receives Razorpay server-to-server payment events.
//  Raw body must be verified before any processing.
// ============================================================
async function handleWebhook(req, res) {
  const signature    = req.headers['x-razorpay-signature'];
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!signature) {
    console.warn('⚠️  Webhook received with no signature — rejected');
    return res.status(400).json({ error: 'Missing signature' });
  }

  const expectedSig = crypto
    .createHmac('sha256', webhookSecret)
    .update(req.body)
    .digest('hex');

  // Constant-time comparison — prevents timing attacks
  const sigBuffer      = Buffer.from(signature,    'hex');
  const expectedBuffer = Buffer.from(expectedSig,  'hex');
  const isValid = sigBuffer.length === expectedBuffer.length &&
                  crypto.timingSafeEqual(sigBuffer, expectedBuffer);

  if (!isValid) {
    console.error('❌ Webhook signature mismatch — possible forgery attempt');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  console.log(`✅ Webhook event: ${event.event}`);

  // Handle payment captured (safety net — primary flow is /verify-payment)
  if (event.event === 'payment.captured') {
    const payment = event.payload?.payment?.entity;
    if (payment) {
      try {
        await db.execute(
          `UPDATE orders SET status = 'paid_webhook_confirmed' WHERE razorpay_order_id = ? AND status = 'paid'`,
          [payment.order_id]
        );
        console.log(`✅ Webhook confirmed payment for order: ${payment.order_id}`);
      } catch (dbErr) {
        console.error('⚠️  Webhook DB update failed:', dbErr.message);
      }
    }
  }

  if (event.event === 'payment.failed') {
    const payment = event.payload?.payment?.entity;
    if (payment?.order_id) {
      try {
        await db.execute(
          `UPDATE orders SET status = 'payment_failed' WHERE razorpay_order_id = ? AND status = 'pending'`,
          [payment.order_id]
        );
      } catch { /* non-fatal */ }
    }
  }

  res.json({ received: true });
}

// ============================================================
//  ROUTE: POST /api/shipping-cost
//  Returns shipping cost for a given delivery pincode.
//  No authentication needed but rate-limited.
// ============================================================
app.post('/api/shipping-cost', shippingLimiter, async (req, res) => {
  const pincode = sanitizePincode(req.body.pincode);
  const weight = parseFloat(req.body.weight) || 0.5; // Default to 0.5kg if not provided

  if (!isValidPincode(pincode)) {
    return res.status(400).json({ error: 'Valid 6-digit Indian pincode required' });
  }

  if (weight <= 0 || weight > 50) { // Reasonable limits: 0-50kg
    return res.status(400).json({ error: 'Invalid weight. Must be between 0.1 and 50kg' });
  }

  res.json(await getShippingQuote(pincode, weight));
});

// ============================================================
//  ROUTE: POST /api/create-order
//  Creates a Razorpay order. Amount is computed server-side
//  from the cart — the client amount is NEVER trusted.
// ============================================================
app.post('/api/create-order', paymentLimiter, async (req, res) => {
  let cartItems;
  try {
    cartItems = validateCartItems(req.body.cartItems);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // ── Shipping is quoted SERVER-SIDE from the delivery pincode — the client's
  //    shippingCharge is never trusted. ──
  const pincode = sanitizePincode(req.body.pincode);
  if (!isValidPincode(pincode)) {
    return res.status(400).json({ error: 'Valid 6-digit delivery pincode required' });
  }
  const quote = await getShippingQuote(pincode, cartWeight(cartItems));
  const shippingCharge = Math.round(safeInt(quote.shipping_charge, 0, 1000));

  // ── Compute total SERVER-SIDE using catalogue prices + live coupon ──
  const { subtotal, couponCode, discountPercent, discountAmount, total } =
    computeCartTotal(cartItems, shippingCharge, req.body.couponCode);
  const totalPaise = total * 100; // convert to paise

  if (totalPaise < 100) {
    return res.status(400).json({ error: 'Order amount too small' });
  }

  try {
    const order = await razorpay.orders.create({
      amount:   Math.round(totalPaise),
      currency: 'INR',
      receipt:  `dnt_${Date.now()}`,
      notes: {
        source:         'dentall-web',
        item_count:     cartItems.length,
        shipping_charge: shippingCharge,
        pincode,
        coupon_code:    couponCode || '',
      },
    });

    console.log(`✅ Razorpay order: ${order.id} | ₹${order.amount / 100}${couponCode ? ` (coupon ${couponCode}, -₹${discountAmount})` : ''}`);

    res.json({
      orderId:        order.id,
      amount:         order.amount,
      keyId:          process.env.RAZORPAY_KEY_ID, // safe to expose public key
      computedTotal:  order.amount / 100,           // let client display correct amount
      shippingCharge,
      couponCode,
      discountPercent,
      discountAmount,
    });
  } catch (e) {
    console.error('Razorpay order creation failed:', e);
    res.status(500).json({ error: 'Could not create payment order. Please try again.' });
  }
});

// ============================================================
//  ROUTE: POST /api/verify-payment
//  The most security-critical endpoint:
//  1. Verify HMAC signature (authenticity)
//  2. Fetch order from Razorpay and verify amount (anti-tamper)
//  3. Check payment status is 'captured' (anti-fraud)
//  4. Prevent replay attacks (idempotency check)
//  5. Save to DB, create shipment, send email
// ============================================================
app.post('/api/verify-payment', paymentLimiter, async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    customerDetails,
    cartItems: rawCartItems,
    couponCode: rawCouponCode,
  } = req.body;

  // ── Basic field presence check ──
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment fields' });
  }

  // ── 1. Verify HMAC-SHA256 signature ──
  const hmacBody   = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(hmacBody)
    .digest('hex');

  // Constant-time comparison — prevents timing attacks
  let sigValid = false;
  try {
    const a = Buffer.from(expectedSig, 'hex');
    const b = Buffer.from(razorpay_signature, 'hex');
    sigValid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    sigValid = false;
  }

  if (!sigValid) {
    console.error(`❌ Signature mismatch for order ${razorpay_order_id} — possible tampering`);
    return res.status(400).json({ error: 'Payment verification failed — invalid signature' });
  }
  console.log(`✅ Signature verified: ${razorpay_order_id}`);

  // ── 2. Fetch order from Razorpay & verify amount (anti-price-tamper) ──
  let rzpOrder, rzpPayment;
  try {
    rzpOrder   = await razorpay.orders.fetch(razorpay_order_id);
    rzpPayment = await razorpay.payments.fetch(razorpay_payment_id);
  } catch (e) {
    console.error('Failed to fetch Razorpay order/payment:', e.message);
    return res.status(502).json({ error: 'Could not verify payment with Razorpay' });
  }

  // ── 3. Verify payment is actually captured (not just authorized) ──
  if (rzpPayment.status !== 'captured') {
    console.error(`❌ Payment ${razorpay_payment_id} status: ${rzpPayment.status} — not captured`);
    return res.status(400).json({ error: `Payment not captured (status: ${rzpPayment.status})` });
  }

  // ── 4. Validate cart server-side and compute trusted total ──
  let cartItems;
  try {
    cartItems = validateCartItems(rawCartItems);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Shipping comes from the Razorpay order notes written by /api/create-order
  // (server-quoted), never from the request body.
  const shippingCharge = safeInt(rzpOrder.notes?.shipping_charge, 0, 1000);
  const { subtotal, couponCode, discountPercent, discountAmount, total } =
    computeCartTotal(cartItems, shippingCharge, rawCouponCode);
  const expectedPaise = Math.round(total * 100);

  // ── 5. Amount integrity check: server total must match Razorpay order amount ──
  if (rzpOrder.amount !== expectedPaise) {
    console.error(`❌ Amount mismatch! Razorpay: ${rzpOrder.amount} paise, Expected: ${expectedPaise} paise`);
    return res.status(400).json({ error: 'Payment amount mismatch — transaction rejected' });
  }
  console.log(`✅ Amount verified: ₹${expectedPaise / 100}`);

  // ── 6. Sanitize and validate customer details ──
  const customer = {
    name:    sanitizeStr(customerDetails?.name),
    email:   sanitizeStr(customerDetails?.email, 100).toLowerCase(),
    phone:   sanitizePhone(customerDetails?.phone),
    address: sanitizeStr(customerDetails?.address, 500),
    city:    sanitizeStr(customerDetails?.city),
    state:   sanitizeStr(customerDetails?.state),
    pincode: sanitizePincode(customerDetails?.pincode),
  };

  if (!customer.name)               return res.status(400).json({ error: 'Customer name required' });
  if (!isValidEmail(customer.email)) return res.status(400).json({ error: 'Valid email required' });
  if (!isValidPhone(customer.phone)) return res.status(400).json({ error: 'Valid phone required' });
  if (!isValidPincode(customer.pincode)) return res.status(400).json({ error: 'Valid pincode required' });
  if (String(rzpOrder.notes?.pincode) !== customer.pincode) {
    console.error(`❌ Pincode mismatch: quoted ${rzpOrder.notes?.pincode}, submitted ${customer.pincode}`);
    return res.status(400).json({ error: 'Delivery pincode does not match the one used for shipping quote' });
  }

  // ── 7. Idempotency / replay attack prevention ──
  try {
    const [existing] = await db.execute(
      'SELECT id FROM orders WHERE razorpay_payment_id = ? LIMIT 1',
      [razorpay_payment_id]
    );
    if (existing.length > 0) {
      console.warn(`⚠️  Duplicate payment submission: ${razorpay_payment_id}`);
      return res.status(409).json({ error: 'Payment already processed', orderId: existing[0].id });
    }
  } catch (dbErr) {
    console.error('DB idempotency check failed:', dbErr.message);
    return res.status(500).json({ error: 'Database error during verification' });
  }

  // ── 8. Save order to MySQL ──
  let orderId;
  const totalAmount = expectedPaise / 100; // use server-computed amount
  try {
    const [result] = await db.execute(
      `INSERT INTO orders
       (razorpay_order_id, razorpay_payment_id,
        customer_name, customer_email, customer_phone,
        customer_address, customer_city, customer_state, customer_pincode,
        items_json, subtotal, shipping_charge, coupon_code, discount_amount, total, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        razorpay_order_id,
        razorpay_payment_id,
        customer.name, customer.email, customer.phone,
        customer.address, customer.city, customer.state, customer.pincode,
        JSON.stringify(cartItems),
        subtotal, shippingCharge, couponCode, discountAmount, totalAmount,
        'paid',
      ]
    );
    orderId = result.insertId;
    console.log(`✅ Order saved to DB: ID ${orderId}`);
  } catch (dbErr) {
    console.error('❌ DB insert failed:', dbErr.message);
    return res.status(500).json({ error: 'Order save failed — contact support with payment ID: ' + razorpay_payment_id });
  }

  // ── 9. Create shipment (non-blocking — order is already confirmed) ──
  let awb;
  try {
    awb = USE_MOCK
      ? mockShiprocketOrder(orderId)
      : await createShiprocketOrder({ orderId, customer, cartItems, totalAmount });

    await db.execute(
      `UPDATE orders SET awb_number = ?, shiprocket_order_id = ? WHERE id = ?`,
      [awb.awb_code, awb.shiprocket_order_id || awb.shipment_id, orderId]
    );
    console.log(`✅ Shipment created, AWB: ${awb.awb_code}`);
  } catch (shipErr) {
    console.error('⚠️  Shiprocket failed (order still confirmed):', shipErr.message);
    awb = { awb_code: `PENDING-${orderId}`, shipment_id: null };
    // Log for manual fulfilment
    await db.execute(
      `UPDATE orders SET status = 'paid_ship_pending' WHERE id = ?`,
      [orderId]
    ).catch(() => {});
  }

  // ── 10. Send receipt email (non-blocking — don't fail the response) ──
  sendReceiptEmail(customer, {
    orderId, razorpay_payment_id, cartItems, totalAmount, shippingCharge, awb,
    discountAmount, couponCode,
  }).catch(mailErr => console.error('⚠️  Email failed:', mailErr.message));

  res.json({ success: true, orderId, awb: awb.awb_code });
});

// ============================================================
//  TRACKING helpers
//  Shiprocket's track response is nested (numeric shipment_status, courier and
//  AWB inside shipment_track[0], events in shipment_track_activities). The
//  storefront expects one flat shape, so every tracking route goes through
//  normalizeTracking() — real and mock data alike.
// ============================================================
function normalizeTracking(raw, { awb = null } = {}) {
  const t          = raw || {};
  const trk        = Array.isArray(t.shipment_track) ? t.shipment_track[0] : null;
  const activities = Array.isArray(t.shipment_track_activities) ? t.shipment_track_activities
                   : Array.isArray(t.tracking_data)             ? t.tracking_data
                   : [];
  const statusText = trk?.current_status
                  || (typeof t.shipment_status === 'string' ? t.shipment_status : '');
  return {
    shipment_status: String(statusText || (awb ? 'AWB ASSIGNED' : 'PROCESSING')).toUpperCase(),
    awb_code:        trk?.awb_code || t.awb_code || awb || null,
    courier_name:    trk?.courier_name || t.courier_name || null,
    etd:             t.etd || trk?.edd || null,
    track_url:       t.track_url || null,
    tracking_data:   activities.map(a => ({
      activity: a.activity || a.status || a['sr-status-label'] || '',
      date:     a.date || '',
      location: a.location || '',
    })),
  };
}

// Shipment that has not been booked with a courier yet (e.g. Shiprocket was down at checkout)
function pendingShipmentTracking() {
  return {
    shipment_status: 'PROCESSING',
    awb_code:        null,
    courier_name:    null,
    etd:             null,
    track_url:       null,
    tracking_data:   [],
    message:         'Your order is confirmed and your shipment is being prepared. Tracking will appear here once the courier picks it up.',
  };
}

// Fetch + normalise live tracking for an AWB. A courier that has no scans yet
// makes Shiprocket answer with an empty/error body — that is "AWB ASSIGNED", not a failure.
async function fetchShiprocketTracking(awb) {
  try {
    const token    = await getShiprocketToken();
    const { data } = await axios.get(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    return normalizeTracking(data?.tracking_data, { awb });
  } catch (e) {
    if (e.response?.status === 404 || e.response?.status === 400) {
      return normalizeTracking({}, { awb });
    }
    throw e;
  }
}

// ============================================================
//  ROUTE: GET /api/track/:orderId
//  Returns live shipment tracking for an order.
// ============================================================
app.get('/api/track/:orderId', async (req, res) => {
  const orderId = safeInt(req.params.orderId, 1);
  if (!orderId) return res.status(400).json({ error: 'Invalid order ID' });

  try {
    const [rows] = await db.execute(
      'SELECT awb_number, status, customer_name, created_at FROM orders WHERE id = ? LIMIT 1',
      [orderId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const { awb_number, customer_name, created_at } = rows[0];
    const base = {
      order_id:      orderId,
      // first name only — order IDs are sequential, so don't expose full names
      customer_name: String(customer_name || '').trim().split(/\s+/)[0] || null,
      order_date:    created_at,
    };

    if (USE_MOCK || (awb_number && awb_number.startsWith('TEST-'))) {
      return res.json({
        ...normalizeTracking(mockTrackingData(awb_number || String(orderId), orderId), { awb: awb_number }),
        ...base,
      });
    }

    if (!awb_number || awb_number.startsWith('PENDING-')) {
      return res.json({ ...pendingShipmentTracking(), ...base });
    }

    res.json({ ...(await fetchShiprocketTracking(awb_number)), ...base });
  } catch (e) {
    console.error('Tracking error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not fetch tracking information. Please try again shortly.' });
  }
});

// ============================================================
//  ROUTE: GET /api/shipment/awb/:awbNumber
//  Track directly by AWB number.
// ============================================================
app.get('/api/shipment/awb/:awbNumber', async (req, res) => {
  const awb = sanitizeStr(req.params.awbNumber, 50).replace(/[^a-zA-Z0-9\-]/g, '');
  if (!awb) return res.status(400).json({ error: 'Invalid AWB number' });

  if (USE_MOCK) {
    return res.json(normalizeTracking(mockTrackingData(awb, 'N/A'), { awb }));
  }

  if (awb.startsWith('PENDING-')) {
    return res.json(pendingShipmentTracking());
  }

  try {
    res.json(await fetchShiprocketTracking(awb));
  } catch (e) {
    console.error('AWB tracking error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Could not fetch tracking info for this AWB' });
  }
});

// ============================================================
//  ROUTE: GET /api/orders
//  Simple order list — MUST be protected by auth in production.
//  Add your admin auth middleware before going live.
// ============================================================

// Shared-secret auth for admin routes. Enforced in every environment
// (DENTALL_ADMIN_SECRET is required at boot) with a constant-time compare.
function adminAuthMiddleware(req, res, next) {
  const token  = String(req.headers['x-admin-token'] || '');
  const secret = process.env.DENTALL_ADMIN_SECRET;
  const digest = s => crypto.createHash('sha256').update(s).digest();
  if (!secret || !token || !crypto.timingSafeEqual(digest(token), digest(secret))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ============================================================
//  ROUTE: GET /api/pricing  (public)
//  Live price/MRP for the storefront — always reflects the latest
//  admin-set values, no rebuild/redeploy needed.
// ============================================================
app.get('/api/pricing', (req, res) => {
  const out = {};
  for (const [id, ref] of Object.entries(PRODUCT_CATALOGUE)) {
    out[id] = { price: ref.price, mrp: ref.mrp };
  }
  res.json(out);
});

// Lets the admin page verify a token without side effects
app.get('/api/admin/ping', adminAuthMiddleware, (req, res) => res.json({ ok: true }));

// ============================================================
//  ROUTE: POST /api/admin/pricing
//  Updates the price/MRP for a product — both in MySQL (persisted)
//  and in the live in-memory catalogue (takes effect immediately).
// ============================================================
app.post('/api/admin/pricing', adminAuthMiddleware, async (req, res) => {
  const { productId, price, mrp } = req.body || {};

  if (!PRODUCT_CATALOGUE[productId]) {
    return res.status(400).json({ error: 'Unknown product' });
  }

  const newPrice = Number(price);
  if (!Number.isFinite(newPrice) || newPrice <= 0 || newPrice > 100000) {
    return res.status(400).json({ error: 'Price must be a number between 1 and 100000' });
  }

  let newMrp = null;
  if (mrp !== null && mrp !== undefined && mrp !== '') {
    newMrp = Number(mrp);
    if (!Number.isFinite(newMrp) || newMrp < newPrice || newMrp > 100000) {
      return res.status(400).json({ error: 'MRP must be a number ≥ price (or leave blank to hide the offer badge)' });
    }
  }

  try {
    await db.execute(
      `INSERT INTO pricing (product_id, price, mrp) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE price = VALUES(price), mrp = VALUES(mrp)`,
      [productId, newPrice, newMrp]
    );
    PRODUCT_CATALOGUE[productId].price = newPrice;
    PRODUCT_CATALOGUE[productId].mrp   = newMrp;
    console.log(`✅ Admin updated pricing: ${productId} → ₹${newPrice}${newMrp ? ` (MRP ₹${newMrp})` : ''}`);
    res.json({ success: true, productId, price: newPrice, mrp: newMrp });
  } catch (e) {
    console.error('Pricing update failed:', e.message);
    res.status(500).json({ error: 'Could not update pricing.' });
  }
});

// ============================================================
//  ROUTE: POST /api/validate-coupon  (public)
//  Lets the checkout UI show "Coupon applied" before payment.
//  This is a convenience check only — /api/create-order and
//  /api/verify-payment always re-validate the coupon themselves.
// ============================================================
app.post('/api/validate-coupon', shippingLimiter, (req, res) => {
  const { code, discountPercent } = getCouponDiscount(req.body?.code);
  if (!code) {
    return res.status(404).json({ valid: false, error: 'Invalid or expired coupon code.' });
  }
  res.json({ valid: true, code, discountPercent });
});

// ============================================================
//  ROUTE: GET/POST /api/admin/coupons, DELETE /api/admin/coupons/:code
//  Manage discount codes — changes take effect immediately (in-memory
//  cache is updated alongside the DB write, same pattern as pricing).
// ============================================================
app.get('/api/admin/coupons', adminAuthMiddleware, (req, res) => {
  const out = Object.entries(COUPONS).map(([code, c]) => ({
    code, discountPercent: c.discountPercent, active: c.active,
  }));
  res.json(out);
});

app.post('/api/admin/coupons', adminAuthMiddleware, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const discountPercent = Number(req.body?.discountPercent);
  const active = req.body?.active !== false;

  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) {
    return res.status(400).json({ error: 'Code must be 3-30 characters: letters, numbers, - or _' });
  }
  if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 90) {
    return res.status(400).json({ error: 'Discount percent must be a number between 1 and 90' });
  }

  try {
    const isNew = !COUPONS[code];
    await db.execute(
      `INSERT INTO coupons (code, discount_percent, active) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE discount_percent = VALUES(discount_percent), active = VALUES(active)`,
      [code, discountPercent, active]
    );
    COUPONS[code] = { discountPercent, active };
    console.log(`✅ Admin ${isNew ? 'created' : 'updated'} coupon: ${code} → ${discountPercent}% (${active ? 'active' : 'inactive'})`);
    res.json({ success: true, code, discountPercent, active });
  } catch (e) {
    console.error('Coupon update failed:', e.message);
    res.status(500).json({ error: 'Could not save coupon.' });
  }
});

app.delete('/api/admin/coupons/:code', adminAuthMiddleware, async (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  try {
    await db.execute('DELETE FROM coupons WHERE code = ?', [code]);
    delete COUPONS[code];
    res.json({ success: true });
  } catch (e) {
    console.error('Coupon delete failed:', e.message);
    res.status(500).json({ error: 'Could not delete coupon.' });
  }
});

app.get('/api/orders', adminAuthMiddleware, async (req, res) => {
  try {
    const limit  = safeInt(req.query.limit,  1, 100) || 50;
    const offset = safeInt(req.query.offset, 0)      || 0;

    const [rows] = await db.execute(
      `SELECT id, customer_name, customer_email, total, status, awb_number, created_at
       FROM orders ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Could not fetch orders' });
  }
});

app.post('/api/wholesale-enquiries', leadLimiter, async (req, res) => {
  const enquiry = {
    name: sanitizeStr(req.body?.name, 150),
    business: sanitizeStr(req.body?.business, 180),
    email: sanitizeStr(req.body?.email, 150).toLowerCase(),
    phone: sanitizePhone(req.body?.phone),
    city: sanitizeStr(req.body?.city, 100),
    state: sanitizeStr(req.body?.state, 100),
    qty: sanitizeStr(req.body?.qty, 30),
    type: sanitizeStr(req.body?.type, 60),
    message: sanitizeStr(req.body?.message, 1200),
  };

  const validQtyRanges = new Set(['100-499', '500-999', '1000-4999', '5000+']);
  if (!enquiry.name) return res.status(400).json({ error: 'Full name is required.' });
  if (!enquiry.business) return res.status(400).json({ error: 'Business name is required.' });
  if (!isValidEmail(enquiry.email)) return res.status(400).json({ error: 'Valid email address is required.' });
  if (!isValidPhone(enquiry.phone)) return res.status(400).json({ error: 'Valid phone number is required.' });
  if (!enquiry.city) return res.status(400).json({ error: 'City is required.' });
  if (!enquiry.state) return res.status(400).json({ error: 'State is required.' });
  if (!validQtyRanges.has(enquiry.qty)) return res.status(400).json({ error: 'Valid quantity range is required.' });

  try {
    const [result] = await db.execute(
      `INSERT INTO wholesale_enquiries
       (full_name, business_name, email, phone, city, state, quantity_range, business_type, message, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
      [enquiry.name, enquiry.business, enquiry.email, enquiry.phone, enquiry.city, enquiry.state, enquiry.qty, enquiry.type, enquiry.message]
    );

    try {
      await sendWholesalePricingEmail(enquiry);
    } catch (mailErr) {
      console.error('Wholesale pricing email failed:', mailErr.message);
    }

    res.json({ success: true, enquiryId: result.insertId });
  } catch (e) {
    console.error('Wholesale enquiry failed:', e.message);
    res.status(500).json({ error: 'Could not save wholesale enquiry. Please try again.' });
  }
});

// ============================================================
//  DEALER ENQUIRIES & QUOTES  (Phase 1)
//  Dealer submits an enquiry -> admin creates a custom-priced quote ->
//  dealer receives a private, unguessable link that shows that quote.
//  Quote prices live ONLY in the dealer_quotes table (set by the admin);
//  nothing a dealer's browser sends can change them.
// ============================================================
const GSTIN_RE       = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const DEALER_MIN_QTY = 100;
const round2         = n => Math.round(n * 100) / 100;
const inr            = n => `₹${Number(n).toLocaleString('en-IN')}`;

// All quote money maths in one place (admin preview, DB read-back, emails)
function computeDealerQuote({ quantity, goodsTotal, gstPercent, freight, advancePercent }) {
  const gstAmount     = round2(goodsTotal * gstPercent / 100);
  const total         = round2(goodsTotal + gstAmount + freight);
  const advanceAmount = round2(total * advancePercent / 100);
  return {
    unitPrice: round2(goodsTotal / quantity),
    goodsTotal, gstPercent, gstAmount, freight, total,
    advancePercent, advanceAmount,
    balanceDue: round2(total - advanceAmount),
  };
}

// Columns every quote SELECT needs (valid_until formatted so timezones can't shift the date)
const QUOTE_COLS = `id, enquiry_id, token, quantity, goods_total, gst_percent, freight, advance_percent,
  notes, DATE_FORMAT(valid_until, '%Y-%m-%d') AS valid_until, status, created_at`;

function formatQuoteRow(row) {
  const calc = computeDealerQuote({
    quantity:       Number(row.quantity),
    goodsTotal:     Number(row.goods_total),
    gstPercent:     Number(row.gst_percent),
    freight:        Number(row.freight),
    advancePercent: Number(row.advance_percent),
  });
  const today = new Date().toISOString().slice(0, 10);
  return {
    id:         row.id,
    quantity:   Number(row.quantity),
    ...calc,
    notes:      row.notes || '',
    validUntil: row.valid_until,
    status:     row.status === 'sent' && row.valid_until < today ? 'expired' : row.status,
    createdAt:  row.created_at,
  };
}

const paymentTermsText = q =>
  q.advancePercent > 0
    ? `${q.advancePercent}% advance (${inr(q.advanceAmount)}), balance ${inr(q.balanceDue)} on delivery`
    : `Cash on delivery (${inr(q.total)})`;

async function sendDealerEnquiryEmails(e) {
  const notify = process.env.ADMIN_NOTIFY_EMAIL || process.env.EMAIL_FROM;
  await sendDentallMail({
    from:    `DENTALL Dealers <${process.env.EMAIL_FROM}>`,
    to:      notify,
    subject: `New dealer enquiry — ${e.shop} (${e.quantity} units)`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px">
        <h2 style="color:#C8102E;margin:0 0 12px">New dealer enquiry</h2>
        <p><strong>${e.shop}</strong> — ${e.name}<br>
           GSTIN: ${e.gstin}<br>
           Phone: ${e.phone} · Email: ${e.email}<br>
           ${e.address}, ${e.city}, ${e.state} - ${e.pincode}</p>
        <p>Quantity wanted: <strong>${e.quantity}</strong> units</p>
        ${e.message ? `<p>Message: ${e.message}</p>` : ''}
        <p style="color:#666;font-size:12px">Open /admin to create a quote.</p>
      </div>`,
  });

  if (!isValidEmail(e.email)) return;
  await sendDentallMail({
    from:    `DENTALL Dealers <${process.env.EMAIL_FROM}>`,
    to:      e.email,
    subject: 'We received your DENTALL dealer enquiry',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#C8102E;color:#fff;padding:22px;border-radius:10px 10px 0 0">
          <h1 style="margin:0;font-size:22px">DENTALL Dealers</h1>
          <p style="margin:6px 0 0">Enquiry received</p>
        </div>
        <div style="border:1px solid #eee;border-top:0;padding:22px;color:#333;line-height:1.7">
          <p>Hi ${e.name},</p>
          <p>Thanks for your enquiry for <strong>${e.quantity}</strong> units for <strong>${e.shop}</strong>.
             Our team will send you a price quote by email within 24 hours.</p>
          <p style="font-size:12px;color:#777">Questions? Reply to this email or write to support@dentall.in</p>
        </div>
      </div>`,
  });
}

async function sendDealerQuoteEmail(enquiry, quote, link) {
  if (!isValidEmail(enquiry.email)) return;
  await sendDentallMail({
    from:    `DENTALL Dealers <${process.env.EMAIL_FROM}>`,
    to:      enquiry.email,
    subject: `Your DENTALL quote — ${quote.quantity} units (${inr(quote.total)})`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#C8102E;color:#fff;padding:22px;border-radius:10px 10px 0 0">
          <h1 style="margin:0;font-size:22px">DENTALL Dealers</h1>
          <p style="margin:6px 0 0">Your price quote is ready</p>
        </div>
        <div style="border:1px solid #eee;border-top:0;padding:22px;color:#333;line-height:1.7">
          <p>Hi ${enquiry.contact_name},</p>
          <p>Here is your quote for <strong>${enquiry.shop_name}</strong>:</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td>Quantity</td><td style="text-align:right">${quote.quantity} units</td></tr>
            <tr><td>Price per unit</td><td style="text-align:right">${inr(quote.unitPrice)}</td></tr>
            <tr><td>Goods total</td><td style="text-align:right">${inr(quote.goodsTotal)}</td></tr>
            ${quote.gstPercent > 0 ? `<tr><td>GST (${quote.gstPercent}%)</td><td style="text-align:right">${inr(quote.gstAmount)}</td></tr>` : ''}
            <tr><td>Freight</td><td style="text-align:right">${quote.freight > 0 ? inr(quote.freight) : 'Included / as agreed'}</td></tr>
            <tr style="font-weight:bold;border-top:2px solid #C8102E"><td style="padding-top:8px">Total</td><td style="text-align:right;padding-top:8px">${inr(quote.total)}</td></tr>
          </table>
          <p><strong>Payment:</strong> ${paymentTermsText(quote)}<br>
             <strong>Valid until:</strong> ${quote.validUntil}</p>
          ${quote.notes ? `<p><strong>Notes:</strong> ${quote.notes}</p>` : ''}
          <p style="text-align:center;margin:22px 0">
            <a href="${link}" style="background:#C8102E;color:#fff;text-decoration:none;padding:12px 28px;border-radius:24px;font-weight:bold;display:inline-block">View your quote →</a>
          </p>
          <p style="font-size:12px;color:#777">To confirm this order, reply to this email or call us. This link is private — please don't share it.</p>
        </div>
      </div>`,
  });
}

// ── Public: dealer submits an enquiry ──
app.post('/api/dealer-enquiries', leadLimiter, async (req, res) => {
  const b = req.body || {};
  const e = {
    name:     sanitizeStr(b.name, 150),
    shop:     sanitizeStr(b.shop, 180),
    gstin:    sanitizeStr(b.gstin, 15).toUpperCase(),
    email:    sanitizeStr(b.email, 150).toLowerCase(),
    phone:    sanitizePhone(b.phone),
    address:  sanitizeStr(b.address, 500),
    city:     sanitizeStr(b.city, 100),
    state:    sanitizeStr(b.state, 100),
    pincode:  sanitizePincode(b.pincode),
    quantity: safeInt(b.quantity, 0, 1000000),
    message:  sanitizeStr(b.message, 1000),
  };

  if (!e.name)                       return res.status(400).json({ error: 'Contact name is required.' });
  if (!e.shop)                       return res.status(400).json({ error: 'Shop / business name is required.' });
  if (!GSTIN_RE.test(e.gstin))       return res.status(400).json({ error: 'Enter a valid 15-character GSTIN.' });
  if (!isValidEmail(e.email))        return res.status(400).json({ error: 'Valid email address is required.' });
  if (!isValidPhone(e.phone))        return res.status(400).json({ error: 'Valid 10-digit mobile number is required.' });
  if (!e.address)                    return res.status(400).json({ error: 'Shop address is required.' });
  if (!e.city || !e.state)           return res.status(400).json({ error: 'City and state are required.' });
  if (!isValidPincode(e.pincode))    return res.status(400).json({ error: 'Valid 6-digit pincode is required.' });
  if (e.quantity < DEALER_MIN_QTY)   return res.status(400).json({ error: `Minimum dealer quantity is ${DEALER_MIN_QTY} units.` });

  try {
    const [result] = await db.execute(
      `INSERT INTO dealer_enquiries
       (contact_name, shop_name, gstin, email, phone, address, city, state, pincode, quantity, message)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [e.name, e.shop, e.gstin, e.email, e.phone, e.address, e.city, e.state, e.pincode, e.quantity, e.message]
    );
    console.log(`✅ Dealer enquiry saved: id=${result.insertId} (${e.quantity} units)`);
    sendDealerEnquiryEmails(e).catch(err => console.error('⚠️  Dealer enquiry email failed:', err.message));
    res.json({ success: true, enquiryId: result.insertId });
  } catch (err) {
    console.error('Dealer enquiry failed:', err.message);
    res.status(500).json({ error: 'Could not save your enquiry. Please try again.' });
  }
});

// ── Admin: list enquiries with their quotes ──
app.get('/api/admin/dealer-enquiries', adminAuthMiddleware, async (req, res) => {
  try {
    const [enquiries] = await db.execute(
      `SELECT id, contact_name, shop_name, gstin, email, phone, address, city, state, pincode,
              quantity, message, status, created_at
       FROM dealer_enquiries ORDER BY created_at DESC LIMIT 200`
    );
    const [quotes] = await db.execute(
      `SELECT ${QUOTE_COLS} FROM dealer_quotes ORDER BY created_at DESC`
    );
    const byEnquiry = {};
    for (const row of quotes) {
      (byEnquiry[row.enquiry_id] ||= []).push({
        ...formatQuoteRow(row),
        link: `${process.env.SITE_URL}/dealer-quote/${row.token}`,
      });
    }
    res.json(enquiries.map(e => ({ ...e, quotes: byEnquiry[e.id] || [] })));
  } catch (err) {
    console.error('Dealer enquiries list failed:', err.message);
    res.status(500).json({ error: 'Could not load dealer enquiries.' });
  }
});

// ── Admin: create a custom-priced quote and email the private link ──
app.post('/api/admin/dealer-quotes', adminAuthMiddleware, async (req, res) => {
  const b = req.body || {};
  const enquiryId      = safeInt(b.enquiryId, 0);
  const quantity       = safeInt(b.quantity, 0, 1000000);
  // The admin enters the price PER UNIT (each dealer can get a different one);
  // the goods total for the whole order is derived from it.
  const unitPrice      = round2(Number(b.unitPrice));
  const goodsTotal     = round2(unitPrice * quantity);
  const gstPercent     = round2(Number(b.gstPercent || 0));
  const freight        = round2(Number(b.freight || 0));
  const advancePercent = round2(Number(b.advancePercent || 0));
  const validDays      = safeInt(b.validDays || 7, 1, 60);
  const notes          = sanitizeStr(b.notes, 1000);

  if (!enquiryId)                                           return res.status(400).json({ error: 'Unknown enquiry.' });
  if (quantity < 1)                                         return res.status(400).json({ error: 'Quantity must be at least 1.' });
  if (!Number.isFinite(unitPrice) || unitPrice <= 0 || unitPrice > 100000)
                                                            return res.status(400).json({ error: 'Price per unit must be between ₹0.01 and ₹1,00,000.' });
  if (goodsTotal > 10000000)                                return res.status(400).json({ error: 'Goods total cannot exceed ₹1,00,00,000 — check the quantity and price per unit.' });
  if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 28)
                                                            return res.status(400).json({ error: 'GST % must be between 0 and 28.' });
  if (!Number.isFinite(freight) || freight < 0 || freight > 1000000)
                                                            return res.status(400).json({ error: 'Freight must be between ₹0 and ₹10,00,000.' });
  if (!Number.isFinite(advancePercent) || advancePercent < 0 || advancePercent > 100)
                                                            return res.status(400).json({ error: 'Advance % must be between 0 and 100.' });

  try {
    const [found] = await db.execute(
      'SELECT id, contact_name, shop_name, email FROM dealer_enquiries WHERE id = ? LIMIT 1', [enquiryId]
    );
    if (!found.length) return res.status(404).json({ error: 'Enquiry not found.' });
    const enquiry = found[0];

    const token = crypto.randomBytes(32).toString('hex'); // 256-bit, unguessable
    const [result] = await db.execute(
      `INSERT INTO dealer_quotes
       (enquiry_id, token, quantity, goods_total, gst_percent, freight, advance_percent, notes, valid_until, status)
       VALUES (?,?,?,?,?,?,?,?, DATE_ADD(CURDATE(), INTERVAL ? DAY), 'sent')`,
      [enquiryId, token, quantity, goodsTotal, gstPercent, freight, advancePercent, notes, validDays]
    );
    await db.execute(`UPDATE dealer_enquiries SET status = 'quoted' WHERE id = ? AND status = 'new'`, [enquiryId]);

    const [rows] = await db.execute(`SELECT ${QUOTE_COLS} FROM dealer_quotes WHERE id = ?`, [result.insertId]);
    const quote  = formatQuoteRow(rows[0]);
    const link   = `${process.env.SITE_URL}/dealer-quote/${token}`;

    let emailed = true;
    try { await sendDealerQuoteEmail(enquiry, quote, link); }
    catch (mailErr) { emailed = false; console.error('⚠️  Dealer quote email failed:', mailErr.message); }

    console.log(`✅ Dealer quote created: id=${result.insertId} enquiry=${enquiryId} total=${inr(quote.total)}`);
    res.json({ success: true, quote: { ...quote, link }, emailed });
  } catch (err) {
    console.error('Dealer quote creation failed:', err.message);
    res.status(500).json({ error: 'Could not create the quote.' });
  }
});

// ── Admin: cancel a quote (its link stops working) / close an enquiry ──
app.post('/api/admin/dealer-quotes/:id/cancel', adminAuthMiddleware, async (req, res) => {
  const id = safeInt(req.params.id, 0);
  if (!id) return res.status(400).json({ error: 'Invalid quote ID' });
  try {
    await db.execute(`UPDATE dealer_quotes SET status = 'cancelled' WHERE id = ?`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not cancel the quote.' });
  }
});

app.post('/api/admin/dealer-enquiries/:id/status', adminAuthMiddleware, async (req, res) => {
  const id     = safeInt(req.params.id, 0);
  const status = String(req.body?.status || '');
  if (!id || !['new', 'quoted', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  try {
    await db.execute('UPDATE dealer_enquiries SET status = ? WHERE id = ?', [status, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not update the enquiry.' });
  }
});

// ── Public: dealer opens their private quote link ──
app.get('/api/dealer-quote/:token', shippingLimiter, async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).json({ error: 'Quote not found.' });

  try {
    const [rows] = await db.execute(
      `SELECT q.id, q.enquiry_id, q.token, q.quantity, q.goods_total, q.gst_percent, q.freight,
              q.advance_percent, q.notes, DATE_FORMAT(q.valid_until, '%Y-%m-%d') AS valid_until,
              q.status, q.created_at, e.shop_name, e.contact_name, e.city, e.state
       FROM dealer_quotes q JOIN dealer_enquiries e ON e.id = q.enquiry_id
       WHERE q.token = ? LIMIT 1`,
      [token]
    );
    if (!rows.length || rows[0].status === 'cancelled') {
      return res.status(404).json({ error: 'This quote is no longer available. Please contact us.' });
    }
    const row = rows[0];
    res.set('Cache-Control', 'no-store');
    res.json({
      shopName:    row.shop_name,
      contactName: row.contact_name,
      city:        row.city,
      state:       row.state,
      quote:       formatQuoteRow(row),
      paymentTerms: paymentTermsText(formatQuoteRow(row)),
    });
  } catch (err) {
    console.error('Dealer quote fetch failed:', err.message);
    res.status(500).json({ error: 'Could not load this quote.' });
  }
});

// ============================================================
//  ROUTE: POST /api/capture-lead
//  Saves email leads and sends welcome/discount email.
// ============================================================
app.post('/api/capture-lead', leadLimiter, async (req, res) => {
  const email = sanitizeStr(req.body.email, 100).toLowerCase();
  const name  = sanitizeStr(req.body.name);
  const phone = sanitizePhone(req.body.phone);

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  // Save to DB (IGNORE duplicate emails gracefully)
  try {
    await db.execute(
      `INSERT IGNORE INTO leads (name, email, phone, created_at) VALUES (?,?,?,NOW())`,
      [name, email, phone]
    );
  } catch (e) {
    console.error('Lead DB save failed:', e.message);
    // Non-fatal — continue to send email anyway
  }

  // Send offer email (non-blocking)
  try {
    await sendDentallMail({
      from:    `DENTALL 🦷 <${process.env.EMAIL_FROM}>`,
      to:      email,
      subject: '🦷 Special Offer Just for You — 10% Off Your First DENTALL Order!',
      html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#3B1A08,#C8102E,#1a2642);padding:2.5rem;text-align:center;border-radius:12px 12px 0 0">
          <h1 style="color:#fff;margin:0;font-size:2rem">DENTALL 🦷</h1>
          <p style="color:rgba(255,255,255,.85);margin:.5rem 0 0">Professional Dental Care</p>
        </div>
        <div style="padding:2.5rem;background:#FFFBF5;border:1px solid #E8D5B0">
          <h2 style="color:#C8102E;margin-top:0">Hi${name ? ' ' + sanitizeStr(name) : ''}! 👋</h2>
          <p style="color:#4A2C10;line-height:1.8">Thanks for your interest in DENTALL. Here's your exclusive welcome discount:</p>
          <div style="background:linear-gradient(135deg,#C8102E,#1a2642);border-radius:12px;padding:2rem;text-align:center;margin:1.5rem 0">
            <p style="color:rgba(255,255,255,.8);margin:0;font-size:.85rem;text-transform:uppercase;letter-spacing:.1em">Exclusive Welcome Offer</p>
            <h2 style="color:#fff;font-size:3rem;margin:.3rem 0">10% OFF</h2>
            <p style="color:rgba(255,255,255,.9);margin:0 0 1rem">on your first order</p>
            <div style="background:#fff;border-radius:8px;padding:.8rem 1.5rem;display:inline-block">
              <span style="color:#C8102E;font-weight:900;font-size:1.2rem;letter-spacing:.1em">WELCOME10</span>
            </div>
          </div>
          <div style="text-align:center;margin:2rem 0">
            <a href="${process.env.SITE_URL}/#order"
               style="background:linear-gradient(135deg,#C8102E,#1a2642);color:#fff;text-decoration:none;padding:1rem 2.5rem;border-radius:30px;font-weight:700;font-size:.9rem;display:inline-block">
              Shop Now →
            </a>
          </div>
          <p style="color:#8A6040;font-size:.78rem;text-align:center;line-height:1.7">
            ⏰ Offer valid for 48 hours · 🔒 Razorpay secured
          </p>
        </div>
        <div style="background:#F5EDDC;padding:1rem;text-align:center;font-size:.72rem;color:#8A6040;border-radius:0 0 12px 12px">
          © 2025 DENTALL — support@dentall.in
        </div>
      </div>`,
    });

    console.log(`✅ Lead email sent to ${email.replace(/(.{2}).+(@.+)/, '$1****$2')}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Lead email failed:', e.message);
    // Still return success — we saved the lead, email is best-effort
    res.json({ success: true });
  }
});

// ============================================================
//  ROUTE: POST /api/reviews  — customer submits a review
//  ROUTE: GET  /api/reviews  — fetch all approved reviews
//  ROUTE: POST /api/reviews/:id/approve — admin approves a review
// ============================================================
const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many review submissions. Please try again later.' },
});

app.post('/api/reviews', reviewLimiter, async (req, res) => {
  const name  = sanitizeStr(req.body?.name,  100);
  const email  = sanitizeStr(req.body?.email, 150).toLowerCase();
  const rating = Math.round(Number(req.body?.rating));
  const text   = sanitizeStr(req.body?.text,  1000);

  if (!name || name.length < 2)   return res.status(400).json({ error: 'Name must be at least 2 characters.' });
  if (!isValidEmail(email))        return res.status(400).json({ error: 'Invalid email address.' });
  if (!text || text.length < 10)   return res.status(400).json({ error: 'Review must be at least 10 characters.' });
  if (rating < 1 || rating > 5)    return res.status(400).json({ error: 'Rating must be between 1 and 5.' });

  try {
    const [result] = await db.execute(
      'INSERT INTO reviews (customer_name, email, rating, review_text, approved) VALUES (?, ?, ?, ?, TRUE)',
      [name, email, rating, text]
    );
    console.log(`✅ Review saved — id=${result.insertId}`);
    res.json({ success: true });
  } catch (e) {
    console.error('❌ Review insert error:', e.message);
    res.status(500).json({ error: 'Could not save review. Please try again.' });
  }
});

app.get('/api/reviews', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT id, customer_name, rating, review_text, created_at
       FROM reviews WHERE approved = TRUE ORDER BY created_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Could not fetch reviews.' });
  }
});

app.post('/api/reviews/:id/approve', adminAuthMiddleware, async (req, res) => {
  const id = safeInt(req.params.id, 1);
  if (!id) return res.status(400).json({ error: 'Invalid review ID' });
  try {
    await db.execute('UPDATE reviews SET approved = TRUE WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not approve review.' });
  }
});

// ============================================================
//  GLOBAL ERROR HANDLER
//  Catches unhandled errors and never leaks stack traces.
// ============================================================
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.message);
  // Never expose stack traces in production
  res.status(500).json({
    error: IS_PROD ? 'An unexpected error occurred. Please try again.' : err.message,
  });
});

// ── Catch-all: serve React SPA for all non-API routes ──
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ============================================================
//  START SERVER
// ============================================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n✅ DENTALL server running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});

// ── Graceful shutdown — don't drop live requests ──
process.on('SIGTERM', async () => {
  console.log('SIGTERM received — shutting down gracefully...');
  await db.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received — shutting down...');
  await db.end();
  process.exit(0);
});

// ── Catch uncaught errors — log but don't crash ──
process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
  if (IS_PROD) process.exit(1); // let process manager (PM2) restart it
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
