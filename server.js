const express = require('express');
const path = require('path');
const session = require('express-session');
require('dotenv').config();

const { createAccount, loginWithPassword, AuthInputError, AuthConflictError } = require('./lib/server/auth-db');
const { dbQuery } = require('./lib/server/db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fluency-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Serve static files
app.use(express.static(path.join(__dirname)));

// Auth endpoints
app.post('/api/login', async (req, res) => {
  try {
    const account = await loginWithPassword({
      identifier: req.body.identifier,
      password: req.body.password
    });

    req.session.userId = account.email;
    req.session.username = account.name || account.email;
    res.json({ success: true, username: account.name || account.email });
  } catch (err) {
    if (err instanceof AuthInputError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/signup', async (req, res) => {
  try {
    const account = await createAccount({
      username: req.body.username,
      email: req.body.email,
      password: req.body.password
    });

    req.session.userId = account.email;
    req.session.username = account.name || account.email;
    res.json({ success: true, username: account.name || account.email });
  } catch (err) {
    if (err instanceof AuthInputError || err instanceof AuthConflictError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  if (req.session.userId) {
    res.json({ username: req.session.username });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Main app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'speech-trainer.html'));
});

// Initialize and start
async function start() {
  try {
    // Verify database connection
    await dbQuery('SELECT 1');
    console.log('Database connected');

    app.listen(PORT, () => {
      console.log(`Fluency is running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

start();
