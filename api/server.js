const express = require('express');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize PostgreSQL Pool using Neon Database connection string
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

// Ensure schema table exists in Neon PostgreSQL
async function initDatabase() {
  const query = `
    CREATE TABLE IF NOT EXISTS loan_applications (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      referred_by VARCHAR(255),
      amount NUMERIC(12, 2) NOT NULL,
      repay_date DATE NOT NULL,
      reason TEXT,
      payment_method VARCHAR(100) NOT NULL,
      payment_handle VARCHAR(255),
      bank_name VARCHAR(255),
      account_number VARCHAR(100),
      routing_number VARCHAR(100),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    await pool.query(query);
    console.log('[DB] Loan applications table initialized.');
  } catch (err) {
    console.error('[DB Error] Failed to initialize table:', err.message);
  }
}

initDatabase();

app.post('/api/apply', async (req, res) => {
  const {
    fullName,
    email,
    amount,
    repayDate,
    referredBy,
    reason,
    paymentMethod,
    paymentHandle,
    bankName,
    accountNumber,
    routingNumber
  } = req.body;

  const errors = {};

  if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
    errors.fullName = 'Full legal name is required.';
  }

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'A valid email address is required.';
  }

  const numericAmount = parseFloat(amount);
  if (isNaN(numericAmount) || numericAmount <= 0 || numericAmount > 10000) {
    errors.amount = 'Please specify a valid loan amount up to $10,000.';
  }

  if (!repayDate) {
    errors.repayDate = 'Maturity date is required.';
  }

  if (!paymentMethod) {
    errors.paymentMethod = 'Disbursement method selection is required.';
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({
      error: 'Validation failed. Please correct the highlighted fields.',
      errors
    });
  }

  try {
    const insertQuery = `
      INSERT INTO loan_applications (
        full_name,
        email,
        referred_by,
        amount,
        repay_date,
        reason,
        payment_method,
        payment_handle,
        bank_name,
        account_number,
        routing_number
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, created_at;
    `;

    const values = [
      fullName.trim(),
      email.trim(),
      referredBy ? referredBy.trim() : null,
      numericAmount,
      repayDate,
      reason ? reason.trim() : null,
      paymentMethod,
      paymentHandle ? paymentHandle.trim() : null,
      bankName ? bankName.trim() : null,
      accountNumber ? accountNumber.trim() : null,
      routingNumber ? routingNumber.trim() : null
    ];

    const result = await pool.query(insertQuery, values);

    return res.status(201).json({
      message: 'Application submitted successfully. Reference ID: ' + result.rows[0].id,
      id: result.rows[0].id
    });
  } catch (err) {
    console.error('[DB Insert Error]:', err);
    return res.status(500).json({
      error: 'An unexpected database error occurred while recording your application.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});