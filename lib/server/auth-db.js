const { dbQuery } = require('./db');
const { hashPassword, verifyPasswordAsync } = require('./password');

class AuthInputError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

class AuthConflictError extends Error {
  constructor(message) {
    super(message);
    this.status = 409;
  }
}

let schemaReadyPromise = null;

async function ensureAuthSchema() {
  if (schemaReadyPromise) {
    return schemaReadyPromise;
  }

  schemaReadyPromise = (async () => {
    const result = await dbQuery(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'accounts'
      );`
    );

    if (!result.rows[0].exists) {
      throw new Error('Accounts table does not exist. Please create it manually.');
    }
  })();

  return schemaReadyPromise;
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function normalizeUsername(username) {
  return username.trim();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeRegisterInput(input) {
  const username = normalizeUsername(input.username ?? '');
  const email = normalizeEmail(input.email ?? '');
  const password = input.password ?? '';

  if (!username || !email || !password) {
    throw new AuthInputError('Username, email, and password are required.');
  }

  if (username.length < 3) {
    throw new AuthInputError('Username must be at least 3 characters.');
  }

  if (!validateEmail(email)) {
    throw new AuthInputError('Invalid email format.');
  }

  return { username, email, password };
}

async function createAccount(input) {
  await ensureAuthSchema();

  const sanitized = sanitizeRegisterInput(input);
  const password_hash = hashPassword(sanitized.password);

  try {
    const result = await dbQuery(
      `INSERT INTO accounts (username, email, password_hash, display_name, role, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING username, email, display_name`,
      [sanitized.username, sanitized.email, password_hash, sanitized.username, 'user', true]
    );

    return result.rows[0];
  } catch (error) {
    const pgCode = error.code;
    if (pgCode === '23505') {
      throw new AuthConflictError('Username or email already exists.');
    }

    throw error;
  }
}

async function loginWithPassword(input) {
  await ensureAuthSchema();

  const identifier = (input.identifier ?? '').trim().toLowerCase();
  const password = input.password ?? '';

  if (!identifier || !password) {
    throw new AuthInputError('Username/email and password are required.');
  }

  const result = await dbQuery(
    `SELECT username, email, display_name, password_hash
     FROM accounts
     WHERE LOWER(username) = $1 OR LOWER(email) = $1
     LIMIT 1`,
    [identifier]
  );

  const account = result.rows[0];

  if (!account) {
    throw new AuthInputError('Invalid username/email or password.');
  }

  const validPassword = await verifyPasswordAsync(password, account.password_hash);

  if (!validPassword) {
    throw new AuthInputError('Invalid username/email or password.');
  }

  const { password_hash: _, ...publicAccount } = account;
  return publicAccount;
}

module.exports = {
  AuthInputError,
  AuthConflictError,
  createAccount,
  loginWithPassword,
};
