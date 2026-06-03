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
    // The users table already exists, just verify it
    const result = await dbQuery(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'users'
      );`
    );

    if (!result.rows[0].exists) {
      throw new Error('Users table does not exist. Please create it manually.');
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
      `INSERT INTO users (name, email, password, max_allowed_days)
       VALUES ($1, $2, $3, $4)
       RETURNING name, email`,
      [sanitized.username, sanitized.email, password_hash, 30]
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
    `SELECT name, email, password
     FROM users
     WHERE LOWER(name) = $1 OR LOWER(email) = $1
     LIMIT 1`,
    [identifier]
  );

  const account = result.rows[0];

  if (!account) {
    throw new AuthInputError('Invalid username/email or password.');
  }

  const validPassword = await verifyPasswordAsync(password, account.password);

  if (!validPassword) {
    throw new AuthInputError('Invalid username/email or password.');
  }

  const { password: _, ...publicAccount } = account;
  return publicAccount;
}

module.exports = {
  AuthInputError,
  AuthConflictError,
  createAccount,
  loginWithPassword,
};
