# ShiaEssentials CMS - Finalization Design Spec

**Date**: 2026-03-13
**Status**: Pending Review

## 1. Architectural Overview
The CMS will transition to a "Hybrid Configuration" model to support both seamless GitHub Pages deployment and zero-config local development.

## 2. Session Management (48-Hour Persistence)
- **Mechanism**: `localStorage` using two keys: `cms_session` (user data) and `cms_session_expiry` (ISO timestamp).
- **Validation Logic**:
  - On app load: If `Date.now() > cms_session_expiry`, session is cleared.
  - On login: `cms_session_expiry` set to `Date.now() + (48 * 60 * 60 * 1000)`.
- **Logout Behavior**:
  - `logout()`: Clears `cms_session` and `cms_session_expiry`. Preserves `turso_db_url` and `turso_auth_token`.
  - `disconnectDb()`: Clears all storage keys.

## 3. Hybrid Configuration Pattern
- **Production**: `index.html` attempts to load `<script src="config.js"></script>`. GitHub Actions will generate this file dynamically.
- **Local Dev**: If `window.CONFIG` is undefined, `app.js` falls back to `localStorage.getItem('tursoDbUrl')`.

## 4. Security Alignment
- **Password Storage**: SHA-256 hashing (Web Crypto API) verified against `users.password_hash`.
- **Admin Access**: Role-based access control (RBAC) in the UI for the "Users" view.

## 5. Deployment Strategy (GitHub Actions)
- **Workflow**: `.github/workflows/deploy-cms.yml`
- **Steps**:
  1. Checkout code.
  2. Create `web/config.js` with content: `window.CONFIG = { url: "${{ secrets.TURSO_URL }}", token: "${{ secrets.TURSO_TOKEN }}" };`.
  3. Deploy `web/` to `gh-pages` branch.

## 6. Acceptance Criteria
- [ ] Session remains active after tab closure/refresh for 48 hours.
- [ ] Logout returns to login screen but remembers Turso credentials.
- [ ] Initial admin user can be created via `setup_admin.sql`.
