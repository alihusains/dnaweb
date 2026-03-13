# ShiaEssentials CMS - Resumed Plan

## Status
- **Project Root**: `/Users/alihusainsorathiya/Desktop/Cafu/dnaweb`
- **Current Goal**: Finalize multi-user persistent login and content alignment.

## Tasks
1. [x] **Fix index.html structural duplication**: Removed redundant main view blocks.
2. [x] **Provide SQL for initial admin user**: Created `setup_admin.sql` with hashed credentials.
3. [x] **Explore project context**: Verified integration in `dnaweb` directory.
4. [x] **Offer visual companion**: Skipped as per user request.
5. [x] **Ask clarifying questions**: 48h session, persistent DB credentials, and GH Actions requested.
6. [x] **Propose approaches**: "Hybrid Config" and Session logic details accepted.
7. [x] **Present design**: Design finalized for 48h session and GH Actions.
8. [x] **Write design doc**: Security and alignment specifics documented in `docs/plans/2026-03-13-cms-finalization-spec.md`.
9. [x] **Spec review loop**: Spec reviewed and accepted via "continue".
10. [x] **User reviews spec**: Final approval received.
11. [x] **Transition to implementation**:
    - [x] Implement 48h session expiry logic in `app.js`.
    - [x] Implement "Hybrid Config" (window.CONFIG) in `app.js` and `index.html`.
    - [x] Update logout to preserve DB credentials.
    - [x] Create GitHub Actions deployment workflow.
    - [x] Verified bulk alignment logic in `app.js`.
    - [x] Update CSS and HTML for custom font mapping (Arabic, Gujarati, Transliteration).
    - [x] Add `.gitignore` to protect `config.js` and local artifacts.
12. [x] **Final Sanity Check**: Verified all flows (Login, Logout, Bulk Alignment, Hybrid Config).

## Context from Previous Session
- **Session**: 48-hour persistence using `localStorage` + timestamp.
- **Logout**: `logout` only clears user session; `disconnectDb` clears Turso credentials.
- **Hybrid Config**: GitHub Secrets inject `config.js` via GHA; Local fallback to `localStorage`.
- **Admin**: `setup_admin.sql` provided for initial setup.
- **Fonts**: Mapped `ShiaEssentials`, `DnaGujarati`, and `DnaQuranTransliteration`.
