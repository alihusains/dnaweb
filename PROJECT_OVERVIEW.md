# ShiaEssentials CMS - Project Overview

## Project Purpose
A robust Content Management System (CMS) designed to manage hierarchical categories and multi-language translations for the ShiaEssentials platform. It allows editors to manage media links, metadata, and detailed content (Arabic, Transliteration, Translation) for religious texts and media.

## Architecture
- **Frontend**: Vue 3 (Composition API) + Tailwind CSS (Single Page Application).
- **Backend/Database**: Turso (libSQL/SQLite) accessed via a custom HTTP pipeline wrapper (`dbRequest`, `dbExecute`, `dbBatch`).
- **Authentication**: Client-side authentication using SHA-256 hashed passwords and Turso-backed user management.
- **State Management**: Reactive Vue state (`ref`, `reactive`) for real-time UI updates and unsaved changes tracking.

## Core Features

### 1. Category Management
- **Hierarchical Structure**: Infinite nesting of categories (Folders) and Leaf nodes (Content items).
- **Drag-and-Drop Reordering**: Visual reordering of categories with automatic sequence persistence.
- **Metadata Management**:
    - Lang Name & English Name.
    - Remote & Local Media URLs (Audio/Video).
    - Related Content IDs (Related 1/2).
    - Custom Labels & Hijri Date notifications.
    - Leaf Node Toggling (`is_last_level`).

### 2. Content & Translation Management
- **Multi-language Support**: Switch between languages (e.g., Gujarati, English) to manage specific translations.
- **Bulk Edit Mode**:
    - Triple-textarea interface for Arabic, Transliteration, and Translation.
    - **Replace Mode**: Overwrites existing content with new line-by-line mapping.
    - **Append Mode**: Adds new lines to existing content.
    - **NULL Mapping**: Blank lines are treated as `NULL` in the database to maintain alignment.
- **Granular Grid Editing**: Edit, delete, or reorder individual translation rows.
- **Visibility Control**: Toggle individual translation rows as visible/hidden.

### 3. User & Language Administration
- **User Management**: Admin-only view to create, edit, or delete users with `admin` or `editor` roles.
- **Language Management**: Manage global language settings (Name, Code).
- **Database Backup**: Integrated tool to generate Turso DB dump commands.

## Implementation Details

### Database Interaction
The app uses a custom `v2/pipeline` Turso wrapper. SQL arguments are mapped to Turso's specific JSON format (`text`, `integer`, `null`).
```javascript
// Example of dbBatch for atomic operations
await dbBatch([
    { sql: "DELETE ...", args: [...] },
    { sql: "INSERT ...", args: [...] }
]);
```

### Safety Features
- **Unsaved Changes Flag**: Tracks modifications in both category metadata and translation grids. Warns users before navigating away.
- **Confirmation Dialogs**: Required for destructive actions (Delete Category, Delete Translation, Discard Changes).

## Database Schema Highlights
- `categories`: Stores the hierarchy, names, and metadata. `is_trans` flag indicates if transliteration is available.
- `item_translations`: Stores the actual content linked by `category_id`. Includes `sequence` for ordering and `language_title`.
- `users`: Stores credentials (`email`, `password_hash`) and `role`.
- `languages`: Stores available translation target languages.

## Getting Started for Developers
1. **Database Config**: Enter Turso DB URL and Auth Token on the initial screen.
2. **Admin Setup**: Use `setup_admin.sql` to initialize the database with a default admin account.
3. **Environment**: The project runs as a static file (can be served via any simple HTTP server or opened directly in a browser).
