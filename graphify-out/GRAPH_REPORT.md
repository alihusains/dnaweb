# Graph Report - .  (2026-06-26)

## Corpus Check
- Corpus is ~21,992 words - fits in a single context window. You may not need a graph.

## Summary
- 62 nodes · 63 edges · 16 communities (9 shown, 7 thin omitted)
- Extraction: 70% EXTRACTED · 30% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.91)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Database Operations & Categories|Database Operations & Categories]]
- [[_COMMUNITY_Connection & Config|Connection & Config]]
- [[_COMMUNITY_Turso Test Suite|Turso Test Suite]]
- [[_COMMUNITY_Schema & Data Model|Schema & Data Model]]
- [[_COMMUNITY_Translation CRUD|Translation CRUD]]
- [[_COMMUNITY_PWA Icons|PWA Icons]]
- [[_COMMUNITY_Branch Switching|Branch Switching]]
- [[_COMMUNITY_DB Sharing & Publishing|DB Sharing & Publishing]]
- [[_COMMUNITY_App v2 (Main)|App v2 (Main)]]
- [[_COMMUNITY_App v1 (Legacy)|App v1 (Legacy)]]
- [[_COMMUNITY_CSV Import|CSV Import]]
- [[_COMMUNITY_Dev Config|Dev Config]]
- [[_COMMUNITY_Legacy Auth|Legacy Auth]]
- [[_COMMUNITY_HTML Entry Point|HTML Entry Point]]
- [[_COMMUNITY_Code Review Rules|Code Review Rules]]

## God Nodes (most connected - your core abstractions)
1. `connectDb` - 6 edges
2. `ShiaEssentials CMS Overview` - 6 edges
3. `Categories Table (hierarchical)` - 6 edges
4. `userLogin` - 5 edges
5. `saveTranslations` - 4 edges
6. `syncRoute` - 4 edges
7. `switchBranch` - 4 edges
8. `CMS Finalization Design Spec` - 4 edges
9. `Turso (libSQL) Database` - 4 edges
10. `Hybrid Configuration Pattern` - 4 edges

## Surprising Connections (you probably didn't know these)
- `connectDb` --semantically_similar_to--> `connectDb (v1)`  [INFERRED] [semantically similar]
  app.js → app-v1.js
- `triggerPublishWorkflow` --conceptually_related_to--> `GitHub Pages Deployment`  [INFERRED]
  app.js → PROJECT_REVIEW.md
- `ShiaEssentials CMS Overview` --references--> `Initial Admin User Seed`  [EXTRACTED]
  PROJECT_OVERVIEW.md → setup_admin.sql
- `connectDb` --implements--> `48-Hour Session Management`  [INFERRED]
  app.js → docs/plans/2026-03-13-cms-finalization-spec.md
- `connectDb` --implements--> `Hybrid Configuration Pattern`  [INFERRED]
  app.js → docs/plans/2026-03-13-cms-finalization-spec.md

## Hyperedges (group relationships)
- **Category-to-Translation Content Pipeline** — app_fetchcategories, app_fetchtranslationsforcategoryandlanguage, app_savetranslations, categories_table, item_translations_table [INFERRED 0.85]
- **Authentication and Session Flow** — app_userlogin, app_hashpassword, app_connectdb, setup_admin_users_table, session_management_48h [INFERRED 0.85]
- **Deployment and Configuration Flow** — config_branches, app_switchbranch, hybrid_config_pattern, gh_pages_deployment, app_triggerpublishworkflow [INFERRED 0.75]
- **PWA Icon Set** — favicon_png, icon_192_png, icon_maskable_192_png, icon_maskable_512_png, icon_512_png [INFERRED 0.95]

## Communities (16 total, 7 thin omitted)

### Community 0 - "Database Operations & Categories"
Cohesion: 0.21
Nodes (12): dbExecute, drag-and-drop reorder, fetchCategories, fetchLanguages, hashPassword, saveCategory, saveCategoryMeta, syncRoute (+4 more)

### Community 1 - "Connection & Config"
Cohesion: 0.31
Nodes (10): connectDb, connectDb (v1), CMS Finalization Design Spec, Turso Production Branch Config, GitHub Pages Deployment, Hybrid Configuration Pattern, CMS Finalization Plan, Project Review: Deployment Ready (+2 more)

### Community 2 - "Turso Test Suite"
Cohesion: 0.33
Nodes (4): client, configContent, tokenMatch, urlMatch

### Community 3 - "Schema & Data Model"
Cohesion: 0.4
Nodes (6): Hierarchical Category Structure, Multi-Language Content Model, ShiaEssentials CMS Overview, Initial Admin User Seed, Users Table Schema, Turso (libSQL) Database

### Community 4 - "Translation CRUD"
Cohesion: 0.5
Nodes (5): dbBatch, fetchTranslationsForCategoryAndLanguage, saveTranslations, saveTranslations (v1), Item Translations Table

### Community 5 - "PWA Icons"
Cohesion: 0.4
Nodes (5): Favicon, PWA Icon 192px, PWA Icon 512px, PWA Maskable Icon 192px, PWA Maskable Icon 512px

### Community 6 - "Branch Switching"
Cohesion: 0.5
Nodes (4): logout, switchBranch, Multi-Branch Configuration, Branch Selector UI

### Community 7 - "DB Sharing & Publishing"
Cohesion: 0.67
Nodes (3): triggerPublishWorkflow, triggerViaCommit, Database Sharing View

## Knowledge Gaps
- **31 isolated node(s):** `configContent`, `urlMatch`, `tokenMatch`, `client`, `app` (+26 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Turso (libSQL) Database` connect `Schema & Data Model` to `Connection & Config`?**
  _High betweenness centrality (0.213) - this node is a cross-community bridge._
- **Why does `connectDb` connect `Connection & Config` to `Schema & Data Model`, `Branch Switching`?**
  _High betweenness centrality (0.204) - this node is a cross-community bridge._
- **Why does `ShiaEssentials CMS Overview` connect `Schema & Data Model` to `Database Operations & Categories`, `Translation CRUD`?**
  _High betweenness centrality (0.192) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `connectDb` (e.g. with `connectDb (v1)` and `48-Hour Session Management`) actually correct?**
  _`connectDb` has 3 INFERRED edges - model-reasoned connections that need verification._
- **Are the 5 inferred relationships involving `Categories Table (hierarchical)` (e.g. with `fetchCategories` and `saveCategoryMeta`) actually correct?**
  _`Categories Table (hierarchical)` has 5 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `saveTranslations` (e.g. with `saveTranslations (v1)` and `Item Translations Table`) actually correct?**
  _`saveTranslations` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `configContent`, `urlMatch`, `tokenMatch` to the rest of the system?**
  _31 weakly-connected nodes found - possible documentation gaps or missing edges._