-- SQL to setup the users table and initial admin account
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Initial admin user (Password: admin123)
-- Hash generated via SHA-256 to match app.js logic
INSERT INTO users (email, password_hash, role)
VALUES ('admin@shiaessentials.com', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9', 'admin');
