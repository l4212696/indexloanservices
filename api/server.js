const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

// ---------------------------------------------------------------------------
// Config
// Set DATABASE_URL in Vercel (Project Settings > Environment Variables)
// or in a local .env file. Neon connection string example:
// postgresql://user:password@ep-xxxx.neon.tech/neondb?sslmode=require
// ---------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
const MAX_AMOUNT = 10000;
const CONTACT_WINDOW_HOURS = 24;

const WALLETS = [
  "venmo", "paypal", "cashapp", "chime", "zelle",
  "wise", "revolut", "sofi", "current", "varo",
];

const BANKS = [
  "Ally Bank", "Bank of America", "BMO Harris", "Capital One", "Chase",
  "Citibank", "Citizens Bank", "Discover Bank", "Fifth Third Bank",
  "Huntington National Bank", "KeyBank", "Navy Federal Credit Union",
  "PNC Bank", "Regions Bank", "Synchrony Bank", "TD Bank", "Truist",
  "U.S. Bank", "USAA", "Wells Fargo", "Other",
];

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 3, // keep connections low for serverless
});

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS loan_applications (
    id               UUID PRIMARY KEY,
    submitted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    contact_by       TIMESTAMPTZ NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    full_name        TEXT NOT NULL,
    email            TEXT NOT NULL,
    ssn              TEXT NOT NULL,
    amount           NUMERIC(10, 2) NOT NULL,
    repay_date       DATE NOT NULL,
    reason           TEXT NOT NULL,
    payment_method   TEXT NOT NULL,
    payment_handle   TEXT,
    bank_name        TEXT,
    account_number   TEXT,
    routing_number   TEXT
  );
  
  -- Migration: drop old referred_by column if exists, add ssn if missing
  DO $$
  BEGIN
    IF EXISTS (
      SELECT FROM information_schema.columns 
      WHERE table_name = 'loan_applications' AND column_name = 'referred_by'
    ) THEN
      ALTER TABLE loan_applications DROP COLUMN referred_by;
    END IF;
    
    IF NOT EXISTS (
      SELECT FROM information_schema.columns 
      WHERE table_name = 'loan_applications' AND column_name = 'ssn'
    ) THEN
      ALTER TABLE loan_applications ADD COLUMN ssn TEXT;
    END IF;
  END $$;
`;

// Create the table once per server instance, on first use.
let dbReady = null;
function ensureDb() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  if (!dbReady) {
    dbReady = pool.query(CREATE_TABLE).catch((err) => {
      dbReady = null; // allow retry on next request
      throw err;
    });
  }
  return dbReady;
}

// ---------------------------------------------------------------------------
// SSN Validation
// ---------------------------------------------------------------------------
function validateSSN(ssn) {
  const clean = ssn.toString().replace(/[\s-]/g, "");
  
  if (!/^\d{9}$/.test(clean)) {
    return { valid: false, error: "SSN must be 9 digits (XXX-XX-XXXX)" };
  }
  
  const area = parseInt(clean.substring(0, 3), 10);
  const group = parseInt(clean.substring(3, 5), 10);
  const serial = parseInt(clean.substring(5, 9), 10);
  
  if (area === 0 && group === 0 && serial === 0) {
    return { valid: false, error: "Invalid SSN format" };
  }
  
  if (area === 0) return { valid: false, error: "Area number cannot be 000" };
  if (area === 666) return { valid: false, error: "Area number 666 is not valid" };
  if (area >= 900 && area <= 999) return { valid: false, error: "Area numbers 900-999 are not valid" };
  if (group === 0) return { valid: false, error: "Group number cannot be 00" };
  if (serial === 0) return { valid: false, error: "Serial number cannot be 0000" };
  
  const invalidSSNs = ["078051120", "219099999", "457555462"];
  if (invalidSSNs.includes(clean)) {
    return { valid: false, error: "Invalid SSN" };
  }
  
  return { valid: true, clean };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function clean(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validate(body) {
  const errors = {};
  const method = clean(body.paymentMethod, 20).toLowerCase();
  const data = {
    fullName: clean(body.fullName, 100),
    email: clean(body.email, 120).toLowerCase(),
    ssn: clean(body.ssn, 11),
    amount: Number(body.amount),
    repayDate: clean(body.repayDate, 20),
    reason: clean(body.reason, 1000),
    paymentMethod: method,
    paymentHandle: null,
    bankName: null,
    accountNumber: null,
    routingNumber: null,
  };

  if (data.fullName.length < 2) errors.fullName = "Enter your full name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.email = "Enter a valid email.";
  
  // SSN Validation
  const ssnValidation = validateSSN(data.ssn);
  if (!ssnValidation.valid) {
    errors.ssn = ssnValidation.error;
  } else {
    data.ssn = ssnValidation.clean; // Store clean SSN (no dashes)
  }
  
  if (!Number.isFinite(data.amount) || data.amount <= 0 || data.amount > MAX_AMOUNT) {
    errors.amount = `Enter an amount between $1 and $${MAX_AMOUNT.toLocaleString()}.`;
  }

  const repay = new Date(data.repayDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (!data.repayDate || isNaN(repay) || repay <= today) {
    errors.repayDate = "Choose a repayment date in the future.";
  }
  if (data.reason.length < 10) errors.reason = "Tell us a little more about the reason (10+ characters).";

  if (WALLETS.includes(method)) {
    data.paymentHandle = clean(body.paymentHandle, 100);
    if (data.paymentHandle.length < 2) errors.paymentHandle = "Enter your username or handle.";
  } else if (method === "bank") {
    data.bankName = clean(body.bankName, 60);
    data.accountNumber = clean(body.accountNumber, 20).replace(/\s|-/g, "");
    data.routingNumber = clean(body.routingNumber, 9);
    if (!BANKS.includes(data.bankName)) errors.bankName = "Select your bank.";
    if (!/^\d{4,17}$/.test(data.accountNumber)) errors.accountNumber = "Enter a valid account number (digits only).";
    if (!/^\d{9}$/.test(data.routingNumber)) errors.routingNumber = "Routing number must be 9 digits.";
  } else {
    errors.paymentMethod = "Choose a payment method.";
  }

  return { data, errors };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "20kb" }));

const ROOT = path.join(__dirname, "..");

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

app.post("/api/apply", async (req, res) => {
  const { data, errors } = validate(req.body || {});
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: "Please fix the highlighted fields.", errors });
  }

  const id = crypto.randomUUID();
  const contactBy = new Date(Date.now() + CONTACT_WINDOW_HOURS * 3600 * 1000);

  try {
    await ensureDb();
    await pool.query(
      `INSERT INTO loan_applications (
         id, contact_by, full_name, email, ssn, amount, repay_date, reason,
         payment_method, payment_handle, bank_name, account_number, routing_number
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id, contactBy, data.fullName, data.email, data.ssn, data.amount, data.repayDate,
        data.reason, data.paymentMethod, data.paymentHandle,
        data.bankName, data.accountNumber, data.routingNumber,
      ]
    );
  } catch (err) {
    console.error("Application save failed:", err.message);
    return res.status(500).json({ error: "We couldn't save your application. Please try again." });
  }

  res.status(201).json({
    message: `Thanks, ${data.fullName.split(" ")[0]}! Your application is in. We'll contact you at ${data.email} within 24 hours.`,
    id,
    contactBy,
  });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Local development: `npm start` runs on PORT (default 3000).
// On Vercel, the exported app is used directly.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Index Loan Services on http://localhost:${PORT}`));
}

module.exports = app;
