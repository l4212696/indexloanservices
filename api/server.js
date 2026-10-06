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

// SSN Validation Function (same rules as client)
function validateSSN(ssn) {
  if (!ssn) return { valid: false, error: 'SSN is required' };
  
  const clean = ssn.toString().replace(/[\s-]/g, '');
  
  if (!/^\d{9}$/.test(clean)) {
    return { valid: false, error: 'SSN must be 9 digits' };
  }
  
  const area = parseInt(clean.substring(0, 3), 10);
  const group = parseInt(clean.substring(3, 5), 10);
  const serial = parseInt(clean.substring(5, 9), 10);
  
  if (area === 0 && group === 0 && serial === 0) {
    return { valid: false, error: 'Invalid SSN format' };
  }
  
  if (area === 0) return { valid: false, error: 'Area number cannot be 000' };
  if (area === 666) return { valid: false, error: 'Area number 666 is not valid' };
  if (area >= 900 && area <= 999) return { valid: false, error: 'Area numbers 900-999 are not valid' };
  if (group === 0) return { valid: false, error: 'Group number cannot be 00' };
  if (serial === 0) return { valid: false, error: 'Serial number cannot be 0000' };
  
  const invalidSSNs = ['078051120', '219099999', '457555462'];
  if (invalidSSNs.includes(clean)) {
    return { valid: false, error: 'Invalid SSN' };
  }
  
  return { valid: true, error: null };
}

// API Routes (MUST be before static middleware)
app.post('/api/apply', async (req, res) => {
  console.log('[API] Received application:', req.body);
  
  const {
    fullName,
    email,
    ssn,
    amount,
    repayDate,
    reason,
    paymentMethod,
    paymentHandle,
    bankName,
    accountNumber,
    routingNumber
  } = req.body;

  const errors = {};

  // Validation
  if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
    errors.fullName = 'Full legal name is required.';
  }

  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'A valid email address is required.';
  }

  // SSN Validation
  const ssnValidation = validateSSN(ssn);
  if (!ssnValidation.valid) {
    errors.ssn = ssnValidation.error;
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
    console.log('[API] Validation errors:', errors);
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
        ssn,
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
      ssn.toString().replace(/-/g, ''), // Store clean SSN
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
    console.log('[API] Application saved:', result.rows[0]);

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

// Static files AFTER API routes
app.use(express.static(path.join(__dirname, '../')));

// Fallback for SPA (if needed)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

// Ensure schema table exists in Neon PostgreSQL
async function initDatabase() {
  const query = `
    CREATE TABLE IF NOT EXISTS loan_applications (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      ssn VARCHAR(11) NOT NULL,
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
    
    -- Add SSN column if table exists but column doesn't (for migration)
    DO $$
    BEGIN
      IF EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'loan_applications'
      ) THEN
        IF NOT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = 'loan_applications' AND column_name = 'ssn'
        ) THEN
          ALTER TABLE loan_applications ADD COLUMN ssn VARCHAR(11);
        END IF;
        
        -- Drop old referred_by column if it exists
        IF EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = 'loan_applications' AND column_name = 'referred_by'
        ) THEN
          ALTER TABLE loan_applications DROP COLUMN referred_by;
        END IF;
      END IF;
    END $$;
  `;
  
  try {
    await pool.query(query);
    console.log('[DB] Loan applications table initialized with SSN column.');
  } catch (err) {
    console.error('[DB Error] Failed to initialize table:', err.message);
  }
}

initDatabase();

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`API endpoint: http://localhost:${PORT}/api/apply`);
});
