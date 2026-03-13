-- SQL to setup the users table and initial admin account
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

