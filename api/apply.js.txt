const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db");

const router = express.Router();

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

function clean(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// SSN Validation Function
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

router.post("/apply", async (req, res) => {
  const { data, errors } = validate(req.body || {});

  if (Object.keys(errors).length) {
    return res.status(400).json({ error: "Please
