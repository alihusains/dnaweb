-- Test user for spreadsheet editor (Password: test@123)
-- Hash = SHA-256("test@123")
INSERT OR IGNORE INTO users (email, password_hash, role)
VALUES ('test@local.com', '8622f0f69c91819119a8acf60a248d7b36fdb7ccf857ba8f85cf7f2767ff8265', 'admin');
