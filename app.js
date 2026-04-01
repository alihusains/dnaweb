import { createClient } from 'https://esm.sh/@libsql/client/web';

const { createApp, ref, reactive, onMounted, computed, watch } = Vue;

const app = createApp({
    setup() {
        // --- State ---
        const dbUrl = ref('');
        const authToken = ref('');
        const isDbConnected = ref(false);
        const isLoggedIn = ref(false);
        const currentUser = ref(null);
        const isLoading = ref(false);
        const error = ref(null);
        let libsqlClient = null;

        // Branch switching
        const currentBranch = ref(localStorage.getItem('cmsBranch') || window.CONFIG?.defaultBranch || 'production');
        const availableBranches = ref(
            window.CONFIG?.branches
                ? Object.entries(window.CONFIG.branches).map(([key, val]) => ({ key, label: val.label || key }))
                : [{ key: 'production', label: 'Production' }]
        );

        // DB Wrappers for consistent error handling and client check
        const dbExecute = async (stmt) => {
            if (!libsqlClient) throw new Error("Database not connected");
            return await libsqlClient.execute(stmt);
        };

        const dbBatch = async (stmts) => {
            if (!libsqlClient) throw new Error("Database not connected");
            return await libsqlClient.batch(stmts);
        };

        // Hashing helper
        const hashPassword = async (password) => {
            const encoder = new TextEncoder();
            const data = encoder.encode(password);
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        };

        // Navigation & UI State
        const currentView = ref('categories');
        const users = ref([]);
        const showUserModal = ref(false);
        const editingUser = ref({ id: null, email: '', password: '', role: 'editor', github_token: '' });
        const categories = ref([]);
        const breadcrumbs = ref([]);
        const currentCategory = ref(null);

        // --- Missing State ---
        const languages = ref([]);
        const selectedLanguageId = ref(null);
        const selectedLanguageCode = computed(() => {
            const lang = languages.value.find(l => l.id === selectedLanguageId.value);
            return lang ? lang.code : 'en';
        });
        const selectedLanguageName = computed(() => {
            const lang = languages.value.find(l => l.id === selectedLanguageId.value);
            return lang ? lang.name : 'English';
        });
        const editingLanguage = ref({ id: null, code: '', name: '', is_rtl: false });
        const showLanguageModal = ref(false);

        const showCategoryModal = ref(false);
        const editingCategory = ref({});
        const mediaTestUrl = ref('');
        const mediaTestType = ref('');
        const showExportModal = ref(false);

        const draggedIndex = ref(null);
        const dropTargetIndex = ref(null);
        const allCategories = ref([]);

        const showTranslationsFor = ref(null);
        const translations = ref([]);
        const unsavedChanges = ref(false);
        const deletedTranslationIds = ref([]);
        const bulkInput = reactive({ arabic: '', transliteration: '', translation: '', english: '' });
        const categoryMeta = ref({
            audio_url: '', video_url: '', duas_url: '', is_trans: false,
            related1: null, related2: null, content_source_id: null, notify_hijri_date: '',
            label1: '', label2: ''
        });

        const availableTables = ref([]);
        const githubToken = ref(localStorage.getItem('githubToken') || '');
        const dbSharingSettings = reactive({
            selectedTables: [],
            configName: 'default',
            autoIncrement: true,
            manualVersion: '',
            triggerMethod: 'api',
            backupMode: false
        });
        const dbSharingPresets = ref(JSON.parse(localStorage.getItem('dbSharingPresets') || '[]'));
        const latestPublishedDb = ref(null);
        const publishedReleases = ref([]);
        const currentDbVersion = ref('1.00');

        const loginForm = reactive({ email: '', password: '' });

        const connectDb = async () => {
            isLoading.value = true;
            error.value = null;
            try {
                libsqlClient = createClient({
                    url: dbUrl.value,
                    authToken: authToken.value
                });
                await libsqlClient.execute('SELECT 1');
                localStorage.setItem('tursoDbUrl', dbUrl.value);
                localStorage.setItem('tursoAuthToken', authToken.value);
                isDbConnected.value = true;
                return true;
            } catch (err) {
                error.value = "Connection failed: " + err.message;
                isDbConnected.value = false;
                return false;
            } finally {
                isLoading.value = false;
            }
        };

        const userLogin = async () => {
            isLoading.value = true;
            error.value = null;
            try {
                const hashedPassword = await hashPassword(loginForm.password);
                const result = await dbExecute({
                    sql: 'SELECT * FROM users WHERE email = ? AND password_hash = ?',
                    args: [loginForm.email, hashedPassword]
                });

                if (result.rows.length > 0) {
                    const user = result.rows[0];
                    currentUser.value = {
                        id: user.id,
                        email: String(user.email),
                        role: String(user.role),
                        github_token: user.github_token ? String(user.github_token) : ''
                    };
                    isLoggedIn.value = true;
                    if (currentUser.value.github_token) githubToken.value = currentUser.value.github_token;

                    const expiry = Date.now() + (48 * 60 * 60 * 1000);
                    localStorage.setItem('cmsUser', JSON.stringify(currentUser.value));
                    localStorage.setItem('cmsSessionExpiry', expiry.toString());
                    loginForm.password = '';

                    await fetchLanguages();
                    await syncRoute();
                } else {
                    error.value = "Invalid email or password.";
                }
            } catch (err) {
                error.value = "Login error: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        const fetchUsers = async () => {
            if (currentUser.value?.role !== 'admin') return;
            try {
                const result = await dbExecute('SELECT id, email, role, github_token, created_at FROM users ORDER BY created_at DESC');
                users.value = result.rows.map(row => ({
                    id: row.id,
                    email: String(row.email),
                    role: String(row.role),
                    github_token: row.github_token ? String(row.github_token) : '',
                    created_at: String(row.created_at)
                }));
            } catch (err) {
                error.value = "Failed to fetch users: " + err.message;
            }
        };

        const openUserModal = (user = null) => {
            if (user) {
                editingUser.value = { id: user.id, email: user.email, password: '', role: user.role, github_token: user.github_token || '' };
            } else {
                editingUser.value = { id: null, email: '', password: '', role: 'editor', github_token: '' };
            }
            showUserModal.value = true;
        };

        const saveUser = async () => {
            isLoading.value = true;
            error.value = null;
            try {
                if (editingUser.value.id) {
                    if (editingUser.value.password) {
                        const hashedPassword = await hashPassword(editingUser.value.password);
                        await dbExecute({
                            sql: 'UPDATE users SET email = ?, password_hash = ?, role = ?, github_token = ? WHERE id = ?',
                            args: [editingUser.value.email, hashedPassword, editingUser.value.role, editingUser.value.github_token, editingUser.value.id]
                        });
                    } else {
                        await dbExecute({
                            sql: 'UPDATE users SET email = ?, role = ?, github_token = ? WHERE id = ?',
                            args: [editingUser.value.email, editingUser.value.role, editingUser.value.github_token, editingUser.value.id]
                        });
                    }
                } else {
                    if (!editingUser.value.password) throw new Error("Password is required for new users.");
                    const hashedPassword = await hashPassword(editingUser.value.password);
                    await dbExecute({
                        sql: 'INSERT INTO users (email, password_hash, role, github_token) VALUES (?, ?, ?, ?)',
                        args: [editingUser.value.email, hashedPassword, editingUser.value.role, editingUser.value.github_token]
                    });
                }
                showUserModal.value = false;
                await fetchUsers();
            } catch (err) {
                error.value = "Failed to save user: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        const deleteUser = async (user) => {
            if (user.id === currentUser.value?.id) {
                alert("You cannot delete yourself.");
                return;
            }
            if (!confirm(`Delete user ${user.email}?`)) return;
            isLoading.value = true;
            try {
                await dbExecute({ sql: 'DELETE FROM users WHERE id = ?', args: [user.id] });
                await fetchUsers();
            } catch (err) {
                error.value = "Failed to delete user: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        const syncRoute = async () => {
            if (!isLoggedIn.value) return;

            const hash = window.location.hash.replace(/^#\/?/, "");
            const parts = hash.split("/");
            const view = parts[0] || "categories";
            const id = parts[1];

            // Migration check: Ensure content_source_id column exists
            try {
                await dbExecute("SELECT content_source_id FROM categories LIMIT 1");
            } catch (e) {
                console.log("Migration: Adding content_source_id column to categories table...");
                try {
                    await dbExecute("ALTER TABLE categories ADD COLUMN content_source_id INTEGER DEFAULT NULL");
                } catch (migrationErr) {
                    console.error("Migration failed:", migrationErr);
                }
            }

            // Ensure categories are loaded for move dropdowns
            fetchAllCategories();

            // Helper to rebuild breadcrumbs and set current category
            const restoreCategoryState = async (catId) => {
                if (!catId) return null;
                try {
                    const res = await dbExecute({
                        sql: "SELECT * FROM categories WHERE id = ?",
                        args: [catId],
                    });
                    if (res.rows.length > 0) {
                        const cat = res.rows[0];
                        currentCategory.value = cat;

                        const crumbs = [];
                        crumbs.unshift({ id: cat.id, english_name: cat.english_name });
                        let parentId = cat.parent_id;

                        while (parentId) {
                            const pRes = await dbExecute({
                                sql: "SELECT id, parent_id, english_name FROM categories WHERE id = ?",
                                args: [parentId],
                            });
                            if (pRes.rows.length > 0) {
                                const p = pRes.rows[0];
                                crumbs.unshift({ id: p.id, english_name: p.english_name });
                                parentId = p.parent_id;
                            } else {
                                parentId = null;
                            }
                        }
                        breadcrumbs.value = crumbs;
                        return cat;
                    }
                } catch (e) {
                    console.error("Failed to restore category state:", e);
                }
                return null;
            };

            // Avoid redundant navigation if state matches hash
            if (currentView.value === view &&
                ((view !== "categories" && view !== "translations") || (currentCategory.value?.id == id && (view !== "translations" || showTranslationsFor.value)))) {
                return;
            }

            currentView.value = view;

            if (view === "categories") {
                showTranslationsFor.value = null;
                if (id) {
                    await restoreCategoryState(id);
                    await fetchCategories(id);
                } else {
                    currentCategory.value = null;
                    breadcrumbs.value = [];
                    await fetchCategories(null);
                }
            } else if (view === "translations" && id) {
                const cat = await restoreCategoryState(id);
                if (cat) {
                    await viewTranslations(cat, false); // false to avoid hash loop
                }
            } else if (view === "users") {
                await fetchUsers();
            } else if (view === "languages") {
                await fetchLanguages();
            } else if (view === "db-sharing") {
                await fetchAvailableTables();
                await fetchCurrentVersion();
                await fetchReleases();
            }
        };

        const updateHash = (view, id = null) => {
            const newHash = id ? `#/${view}/${id}` : `#/${view}`;
            if (window.location.hash !== newHash) {
                window.location.hash = newHash;
            }
        };


        // Branch switching function
        const switchBranch = async (branchKey) => {
            const branchConfig = window.CONFIG?.branches?.[branchKey];
            if (!branchConfig) {
                error.value = 'Unknown branch: ' + branchKey;
                return;
            }
            // Disconnect current
            if (isDbConnected.value) {
                logout();
                isDbConnected.value = false;
            }
            currentBranch.value = branchKey;
            localStorage.setItem('cmsBranch', branchKey);
            dbUrl.value = branchConfig.url;
            authToken.value = branchConfig.token;
            const connected = await connectDb();
            if (connected) {
                // Restore session if valid
                const savedUser = localStorage.getItem('cmsUser');
                const sessionExpiry = localStorage.getItem('cmsSessionExpiry');
                if (savedUser && sessionExpiry && Date.now() < parseInt(sessionExpiry)) {
                    currentUser.value = JSON.parse(savedUser);
                    isLoggedIn.value = true;
                    if (currentUser.value.github_token) githubToken.value = currentUser.value.github_token;
                    await fetchLanguages();
                    await syncRoute();
                }
            }
        };

        // --- Lifecycle ---
        onMounted(async () => {
            // Restore DB config from branch-aware config
            const branch = currentBranch.value;
            const branchConfig = window.CONFIG?.branches?.[branch];
            if (branchConfig) {
                dbUrl.value = branchConfig.url;
                authToken.value = branchConfig.token;
            } else if (window.CONFIG?.url && window.CONFIG?.token) {
                // Legacy single-config fallback
                dbUrl.value = window.CONFIG.url;
                authToken.value = window.CONFIG.token;
            } else {
                dbUrl.value = localStorage.getItem('tursoDbUrl') || 'libsql://duasandaamalapp-alihusains.aws-ap-northeast-1.turso.io';
                authToken.value = localStorage.getItem('tursoAuthToken') || '';
            }

            // Immediate session restoration (smooth UI)
            const savedUser = localStorage.getItem('cmsUser');
            const sessionExpiry = localStorage.getItem('cmsSessionExpiry');
            if (savedUser && sessionExpiry && Date.now() < parseInt(sessionExpiry)) {
                currentUser.value = JSON.parse(savedUser);
                isLoggedIn.value = true;
                if (currentUser.value.github_token) githubToken.value = currentUser.value.github_token;
            } else {
                // Clear stale session
                localStorage.removeItem('cmsUser');
                localStorage.removeItem('cmsSessionExpiry');
                isLoggedIn.value = false;
                currentUser.value = null;
            }

            // Restore language preference
            const savedLang = localStorage.getItem('selectedLanguageId');
            if (savedLang) selectedLanguageId.value = parseInt(savedLang);

            if (dbUrl.value && authToken.value) {
                const connected = await connectDb();
                if (connected && isLoggedIn.value) {
                    await fetchLanguages();
                    // Initial sync handled below
                }
            }

            if (isLoggedIn.value) {
                await syncRoute();
            }

            window.addEventListener('hashchange', syncRoute);
        });

        watch(selectedLanguageId, async (newVal) => {
            if (newVal) {
                localStorage.setItem('selectedLanguageId', newVal);
                if (isLoggedIn.value) {
                    await fetchAllCategories();
                    if (currentView.value === 'translations' || showTranslationsFor.value) {
                        await fetchTranslationsForCategoryAndLanguage();
                    } else if (currentView.value === 'categories') {
                        await fetchCategories(currentCategory.value ? currentCategory.value.id : null);
                    }
                }
            }
        });

        // The hash is now the single source of truth. Side effects are handled in syncRoute.


        const logout = () => {
            isLoggedIn.value = false;
            currentUser.value = null;
            localStorage.removeItem('cmsUser');
            localStorage.removeItem('cmsSessionExpiry');
            window.location.hash = '';
            categories.value = [];
            breadcrumbs.value = [];
            currentCategory.value = null;
            showTranslationsFor.value = null;
        };

        const disconnectDb = () => {
            logout();
            isDbConnected.value = false;
            // Disconnect (no-op now)
            localStorage.removeItem('tursoDbUrl');
            localStorage.removeItem('tursoAuthToken');
        };

        // --- Languages Management ---
        const fetchLanguages = async () => {
            try {
                const result = await dbExecute('SELECT * FROM languages ORDER BY id ASC');
                languages.value = result.rows.map(row => ({
                    id: row.id,
                    code: String(row.code),
                    name: String(row.name),
                    is_rtl: !!row.is_rtl
                }));
                if (languages.value.length > 0 && !selectedLanguageId.value) {
                    selectedLanguageId.value = languages.value[0].id;
                }
            } catch (err) {
                error.value = "Failed to fetch languages: " + err.message;
            }
        };

        const openLanguageModal = (lang = null) => {
            if (lang) {
                editingLanguage.value = { ...lang };
            } else {
                editingLanguage.value = { id: null, code: '', name: '', is_rtl: false };
            }
            showLanguageModal.value = true;
        };

        const closeLanguageModal = () => {
            showLanguageModal.value = false;
        };

        const saveLanguage = async () => {
            isLoading.value = true;
            error.value = null;
            try {
                const isRtl = editingLanguage.value.is_rtl ? 1 : 0;
                if (editingLanguage.value.id) {
                    await dbExecute({
                        sql: `UPDATE languages SET code = ?, name = ?, is_rtl = ? WHERE id = ?`,
                        args: [editingLanguage.value.code, editingLanguage.value.name, isRtl, editingLanguage.value.id]
                    });
                } else {
                    await dbExecute({
                        sql: `INSERT INTO languages (code, name, is_rtl) VALUES (?, ?, ?)`,
                        args: [editingLanguage.value.code, editingLanguage.value.name, isRtl]
                    });
                }
                closeLanguageModal();
                await fetchLanguages();
            } catch (err) {
                error.value = "Failed to save language: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        const deleteLanguage = async (lang) => {
            if (!confirm(`Are you sure you want to delete the language '${lang.name}'?`)) return;
            isLoading.value = true;
            try {
                await dbExecute('PRAGMA foreign_keys = ON');
                await dbExecute({
                    sql: 'DELETE FROM languages WHERE id = ?',
                    args: [lang.id]
                });
                await fetchLanguages();
            } catch (err) {
                error.value = "Failed to delete language: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        // --- Navigation & Category Fetching ---
        const fetchCategories = async (parentId) => {
            isLoading.value = true;
            error.value = null;
            try {
                let result;
                if (parentId === null) {
                    result = await dbExecute({
                        sql: 'SELECT * FROM categories WHERE parent_id IS NULL AND language_code = ? ORDER BY sequence ASC',
                        args: [selectedLanguageCode.value]
                    });
                } else {
                    result = await dbExecute({
                        sql: 'SELECT * FROM categories WHERE parent_id = ? AND language_code = ? ORDER BY sequence ASC',
                        args: [parentId, selectedLanguageCode.value]
                    });
                }

                categories.value = result.rows.map(row => ({
                    id: row.id,
                    parent_id: row.parent_id,
                    sequence: row.sequence,
                    lang_name: row.lang_name == null ? '' : String(row.lang_name),
                    english_name: row.english_name == null ? '' : String(row.english_name),
                    audio_url: row.audio_url == null ? '' : String(row.audio_url),
                    video_url: row.video_url == null ? '' : String(row.video_url),
                    duas_url: row.duas_url == null ? '' : String(row.duas_url),
                    local_audio_url: row.local_audio_url == null ? '' : String(row.local_audio_url),
                    local_video_url: row.local_video_url == null ? '' : String(row.local_video_url),
                    related1: row.related1,
                    related2: row.related2,
                    notify_hijri_date: row.notify_hijri_date == null ? '' : String(row.notify_hijri_date),
                    label1: row.label1 == null ? '' : String(row.label1),
                    label2: row.label2 == null ? '' : String(row.label2),
                    is_trans: Number(row.is_trans) === 1,
                    is_last_level: Number(row.is_last_level) === 1,
                    language_code: row.language_code
                }));
            } catch (err) {
                error.value = "Failed to fetch categories: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        const openCategory = (category) => {
            updateHash('categories', category.id);
        };

        const goToBreadcrumb = (index) => {
            const id = index === -1 ? null : breadcrumbs.value[index].id;
            updateHash('categories', id);
        };

        // --- Category CRUD ---
        const openCategoryModal = async (category = null) => {
            await fetchAllCategories();
            if (category) {
                editingCategory.value = {
                    id: category.id,
                    parent_id: category.parent_id,
                    sequence: category.sequence,
                    lang_name: category.lang_name == null ? '' : String(category.lang_name),
                    english_name: category.english_name == null ? '' : String(category.english_name),
                    audio_url: category.audio_url == null ? '' : String(category.audio_url),
                    video_url: category.video_url == null ? '' : String(category.video_url),
                    duas_url: category.duas_url == null ? '' : String(category.duas_url),
                    local_audio_url: category.local_audio_url == null ? '' : String(category.local_audio_url),
                    local_video_url: category.local_video_url == null ? '' : String(category.local_video_url),
                    related1: category.related1,
                    related2: category.related2,
                    content_source_id: category.content_source_id,
                    notify_hijri_date: category.notify_hijri_date == null ? '' : String(category.notify_hijri_date),
                    label1: category.label1 == null ? '' : String(category.label1),
                    label2: category.label2 == null ? '' : String(category.label2),
                    is_trans: category.is_trans || 0,
                    is_last_level: category.is_last_level,
                    language_code: category.language_code || selectedLanguageCode.value
                };
                // Find parent name for the move dropdown
                const parent = allCategories.value.find(p => p.id === category.parent_id);
                editingCategory.value.parent_name = parent ? parent.english_name : '';
            } else {
                let maxSeq = 0;
                if (categories.value.length > 0) {
                    maxSeq = Math.max(...categories.value.map(c => c.sequence));
                }
                editingCategory.value = {
                    id: null,
                    parent_id: currentCategory.value ? currentCategory.value.id : null,
                    sequence: maxSeq + 1,
                    lang_name: '',
                    english_name: '',
                    audio_url: '', video_url: '', duas_url: '', local_audio_url: '', local_video_url: '',
                    related1: null, related2: null, content_source_id: null, notify_hijri_date: '', label1: '', label2: '',
                    is_trans: 0,
                    is_last_level: false,
                    language_code: selectedLanguageCode.value,
                    parent_name: currentCategory.value ? currentCategory.value.english_name : ''
                };
            }
            showCategoryModal.value = true;
        };

        const closeCategoryModal = () => {
            showCategoryModal.value = false;
        };

        const saveCategory = async () => {
            isLoading.value = true;
            error.value = null;
            try {
                const isLeaf = editingCategory.value.is_last_level ? 1 : 0;

                if (editingCategory.value.id) {
                    await dbExecute({
                        sql: `UPDATE categories SET
                                parent_id = ?, lang_name = ?, english_name = ?,
                                audio_url = ?, video_url = ?, duas_url = ?,
                                local_audio_url = ?, local_video_url = ?,
                                related1 = ?, related2 = ?, content_source_id = ?, notify_hijri_date = ?, label1 = ?, label2 = ?,
                                is_last_level = ?, is_trans = ?, language_code = ?
                              WHERE id = ?`,
                        args: [
                            editingCategory.value.parent_id,
                            editingCategory.value.lang_name,
                            editingCategory.value.english_name,
                            editingCategory.value.audio_url || null,
                            editingCategory.value.video_url || null,
                            editingCategory.value.duas_url || null,
                            editingCategory.value.local_audio_url || null,
                            editingCategory.value.local_video_url || null,
                            editingCategory.value.related1 || null,
                            editingCategory.value.related2 || null,
                            editingCategory.value.content_source_id || null,
                            editingCategory.value.notify_hijri_date || null,
                            editingCategory.value.label1 || null,
                            editingCategory.value.label2 || null,
                            isLeaf,
                            editingCategory.value.is_trans ? 1 : 0,
                            editingCategory.value.language_code,
                            editingCategory.value.id
                        ]
                    });
                } else {
                    await dbExecute({
                        sql: `INSERT INTO categories
                                (parent_id, sequence, lang_name, english_name, audio_url, video_url, duas_url, local_audio_url, local_video_url, related1, related2, content_source_id, notify_hijri_date, label1, label2, is_last_level, is_trans, language_code)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        args: [
                            editingCategory.value.parent_id,
                            editingCategory.value.sequence,
                            editingCategory.value.lang_name,
                            editingCategory.value.english_name,
                            editingCategory.value.audio_url || null,
                            editingCategory.value.video_url || null,
                            editingCategory.value.duas_url || null,
                            editingCategory.value.local_audio_url || null,
                            editingCategory.value.local_video_url || null,
                            editingCategory.value.related1 || null,
                            editingCategory.value.related2 || null,
                            editingCategory.value.content_source_id || null,
                            editingCategory.value.notify_hijri_date || null,
                            editingCategory.value.label1 || null,
                            editingCategory.value.label2 || null,
                            isLeaf,
                            editingCategory.value.is_trans ? 1 : 0,
                            editingCategory.value.language_code
                        ]
                    });
                }

                closeCategoryModal();

                // Sync with translation view if needed
                if (showTranslationsFor.value && showTranslationsFor.value.id === editingCategory.value.id) {
                    categoryMeta.value.is_trans = editingCategory.value.is_trans ? 1 : 0;
                }

                await fetchCategories(currentCategory.value ? currentCategory.value.id : null);
                await fetchAllCategories();
            } catch (err) {
                error.value = "Failed to save category: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        const deleteCategory = async (category) => {
            if (!confirm(`Are you sure you want to delete '${category.english_name}'?\nThis will permanently delete it and all its sub-categories and contents.`)) {
                return;
            }
            isLoading.value = true;
            try {
                await dbExecute('PRAGMA foreign_keys = ON');
                await dbExecute({
                    sql: 'DELETE FROM categories WHERE id = ?',
                    args: [category.id]
                });
                await fetchCategories(currentCategory.value ? currentCategory.value.id : null);
                await fetchAllCategories();
            } catch (err) {
                error.value = "Failed to delete: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        const fetchAllCategories = async () => {
            try {
                const result = await dbExecute({
                    sql: "SELECT id, english_name FROM categories WHERE language_code = ? ORDER BY english_name ASC",
                    args: [selectedLanguageCode.value]
                });
                allCategories.value = result.rows.map(row => ({
                    id: row.id,
                    english_name: row.english_name == null ? '' : String(row.english_name)
                }));
            } catch (err) {
                console.error("Failed to fetch all categories:", err);
            }
        };

        const testMedia = (url, type) => {
            if (!url) return;
            mediaTestUrl.value = url;
            mediaTestType.value = type;
        };

        // --- Drag and Drop Sequencing ---
        const dragStart = (index, event) => {
            draggedIndex.value = index;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', index);
        };

        const dragOver = (index) => {
            if (draggedIndex.value === index) return;
            dropTargetIndex.value = index;
        };

        const drop = async () => {
            const fromIndex = draggedIndex.value;
            const toIndex = dropTargetIndex.value;

            draggedIndex.value = null;
            dropTargetIndex.value = null;

            if (fromIndex === null || toIndex === null || fromIndex === toIndex) return;

            const movedItem = categories.value.splice(fromIndex, 1)[0];
            categories.value.splice(toIndex, 0, movedItem);

            categories.value.forEach((cat, idx) => {
                cat.sequence = idx + 1;
            });

            isLoading.value = true;
            try {
                const stmts = categories.value.map(cat => ({
                    sql: 'UPDATE categories SET sequence = ? WHERE id = ?',
                    args: [cat.sequence, cat.id]
                }));
                await dbBatch(stmts);

                // Sort the categories array based on the new sequence to reflect it instantly
                categories.value.sort((a, b) => a.sequence - b.sequence);
            } catch (err) {
                error.value = "Failed to save sequence: " + err.message;
                await fetchCategories(currentCategory.value ? currentCategory.value.id : null);
            } finally {
                isLoading.value = false;
            }
        };

        // --- Content Management (Translations & Meta) ---
        const viewTranslations = async (category, shouldUpdateHash = true) => {
            await fetchAllCategories();
            showTranslationsFor.value = category;
            unsavedChanges.value = false;
            deletedTranslationIds.value = [];

            if (shouldUpdateHash) {
                updateHash('translations', category.id);
                return; // syncRoute will handle the rest
            }

            bulkInput.arabic = '';
            bulkInput.transliteration = '';
            bulkInput.translation = '';

            // Populate category meta for editing on the content screen
            categoryMeta.value = {
                audio_url: category.audio_url == null ? '' : String(category.audio_url),
                video_url: category.video_url == null ? '' : String(category.video_url),
                duas_url: category.duas_url == null ? '' : String(category.duas_url),
                is_trans: category.is_trans === 1,
                related1: category.related1,
                related2: category.related2,
                notify_hijri_date: category.notify_hijri_date == null ? '' : String(category.notify_hijri_date),
                label1: category.label1 == null ? '' : String(category.label1),
                label2: category.label2 == null ? '' : String(category.label2)
            };

            if (languages.value.length > 0 && !selectedLanguageId.value) {
                selectedLanguageId.value = languages.value[0].id;
            }

            if (selectedLanguageId.value) {
                await fetchTranslationsForCategoryAndLanguage();
            } else {
                translations.value = [];
            }
        };

        const fetchTranslationsForCategoryAndLanguage = async () => {
            if (!showTranslationsFor.value) return;

            isLoading.value = true;
            error.value = null;

            try {
                // Check if this category reuses content from another source
                let sourceId = showTranslationsFor.value.id;
                if (showTranslationsFor.value.content_source_id) {
                    sourceId = showTranslationsFor.value.content_source_id;
                    console.log(`Reusing content from category ID: ${sourceId}`);
                }

                const result = await dbExecute({
                    sql: 'SELECT * FROM item_translations WHERE category_id = ? ORDER BY sequence ASC',
                    args: [sourceId]
                });

                translations.value = result.rows.map(row => {
                    const catMatch = allCategories.value.find(c => c.id === row.category_id);
                    return {
                        id: row.id,
                        sequence: row.sequence,
                        language_title: row.language_title == null ? '' : String(row.language_title),
                        arabic: row.arabic == null ? '' : String(row.arabic),
                        transliteration: row.transliteration == null ? '' : String(row.transliteration),
                        translation: row.translation == null ? '' : String(row.translation),
                        english: row.english == null ? '' : String(row.english),
                        category_name: catMatch ? catMatch.english_name : '',
                        is_visible: row.is_visible === 1,
                        isEditing: false
                    };
                });
            } catch (err) {
                error.value = "Failed to load content: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        const closeTranslations = () => {
            if (unsavedChanges.value) {
                if (!confirm("You have unsaved changes. Discard them?")) {
                    return;
                }
            }
            showTranslationsFor.value = null;
            updateHash('categories', currentCategory.value ? currentCategory.value.id : null);
        };

        const saveCategoryMeta = async () => {
            if (!showTranslationsFor.value) return;
            isLoading.value = true;
            error.value = null;
            try {
                await dbExecute({
                    sql: `UPDATE categories SET
                            audio_url = ?, video_url = ?, duas_url = ?,
                            related1 = ?, related2 = ?, content_source_id = ?, notify_hijri_date = ?, label1 = ?, label2 = ?,
                            is_trans = ?
                          WHERE id = ?`,
                    args: [
                        categoryMeta.value.audio_url || null,
                        categoryMeta.value.video_url || null,
                        categoryMeta.value.duas_url || null,
                        categoryMeta.value.related1 || null,
                        categoryMeta.value.related2 || null,
                        categoryMeta.value.content_source_id || null,
                        categoryMeta.value.notify_hijri_date || null,
                        categoryMeta.value.label1 || null,
                        categoryMeta.value.label2 || null,
                        categoryMeta.value.is_trans ? 1 : 0,
                        showTranslationsFor.value.id
                    ]
                });
                alert("Category properties saved successfully!");
            } catch (err) {
                error.value = "Failed to save category properties: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        // --- Database Sharing Logic ---
        const fetchAvailableTables = async () => {
            try {
                const result = await dbExecute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
                availableTables.value = result.rows.map(r => r.name);
            } catch (err) {
                console.error("Failed to fetch tables:", err);
            }
        };

        const fetchCurrentVersion = async () => {
            try {
                const response = await fetch('version.json');
                if (response.ok) {
                    const data = await response.json();
                    currentDbVersion.value = data.version;
                }
            } catch (err) {
                console.error("Failed to fetch version:", err);
            }
        };

        const fetchReleases = async () => {
            if (!githubToken.value) return;
            try {
                // Detect repo from URL (works for GitHub Pages: /owner/repo/)
                const owner = 'alihusains';
                const repo = 'dnaweb';

                const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
                    headers: { 'Authorization': `token ${githubToken.value}` }
                });
                if (response.ok) {
                    const data = await response.json();
                    publishedReleases.value = data.map(r => ({
                        version: r.tag_name.replace('v', ''),
                        date: new Date(r.published_at).toLocaleString(),
                        url: r.assets.find(a => a.name.endsWith('.sqlite'))?.browser_download_url || ''
                    }));
                    if (publishedReleases.value.length > 0) {
                        latestPublishedDb.value = publishedReleases.value[0];
                    }
                }
            } catch (err) {
                console.error("Failed to fetch releases:", err);
            }
        };

        const triggerPublishWorkflow = async () => {
            if (!githubToken.value) {
                alert("Please enter a GitHub Personal Access Token first.");
                return;
            }

            const methodLabel = dbSharingSettings.triggerMethod === 'commit' ? 'File Commit (Auto-trigger)' : 'API Dispatch (Manual)';
            if (!confirm(`Are you sure you want to trigger the database publish using the ${methodLabel} method?`)) {
                return;
            }

            if (dbSharingSettings.triggerMethod === 'commit') {
                return triggerViaCommit();
            }

            isLoading.value = true;
            try {
                const owner = 'alihusains';
                const repo = 'dnaweb';

                const nextVersion = dbSharingSettings.autoIncrement
                    ? (parseFloat(currentDbVersion.value) + 0.01).toFixed(2)
                    : dbSharingSettings.manualVersion;

                const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/publish-db.yml/dispatches`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `token ${githubToken.value}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        ref: 'main',
                        inputs: {
                            version: String(nextVersion),
                            tables: dbSharingSettings.selectedTables.join(','),
                            config_name: dbSharingSettings.configName
                        }
                    })
                });

                if (response.ok) {
                    alert(`Workflow triggered via API! Version ${nextVersion} will be published shortly.`);
                    localStorage.setItem('githubToken', githubToken.value);
                } else {
                    const errData = await response.json();
                    throw new Error(errData.message || 'Failed to trigger workflow');
                }
            } catch (err) {
                alert("Error: " + err.message);
            } finally {
                isLoading.value = false;
            }
        };

        const triggerViaCommit = async () => {
            isLoading.value = true;
            try {
                const owner = 'alihusains';
                const repo = 'dnaweb';

                const nextVersion = dbSharingSettings.autoIncrement
                    ? (parseFloat(currentDbVersion.value) + 0.01).toFixed(2)
                    : dbSharingSettings.manualVersion;

                const configContent = JSON.stringify({
                    version: String(nextVersion),
                    tables: dbSharingSettings.selectedTables,
                    config_name: dbSharingSettings.configName,
                    updated_at: new Date().toISOString()
                }, null, 2);

                // Get current file SHA if it exists
                let sha = null;
                try {
                    const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/db_sharing_config.json`, {
                        headers: { 'Authorization': `token ${githubToken.value}` }
                    });
                    if (getRes.ok) {
                        const fileData = await getRes.json();
                        sha = fileData.sha;
                    }
                } catch (e) {
                    console.log("Config file doesn't exist yet.");
                }

                const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/db_sharing_config.json`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `token ${githubToken.value}`,
                        'Accept': 'application/vnd.github.v3+json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        message: `chore: trigger database publish v${nextVersion} [bot]`,
                        content: btoa(configContent),
                        branch: 'main',
                        sha: sha,
                        committer: {
                            name: "github-actions[bot]",
                            email: "github-actions[bot]@users.noreply.github.com"
                        },
                        author: {
                            name: "github-actions[bot]",
                            email: "github-actions[bot]@users.noreply.github.com"
                        }
                    })
                });

                if (response.ok) {
                    alert(`Config committed! Workflow will trigger automatically. Version ${nextVersion}.`);
                    localStorage.setItem('githubToken', githubToken.value);
                } else {
                    const errData = await response.json();
                    throw new Error(errData.message || 'Failed to commit config');
                }
            } catch (err) {
                alert("Error: " + err.message);
            } finally {
                isLoading.value = false;
            }
        };

        const savePreset = () => {
            const name = prompt("Enter a name for this preset:");
            if (!name) return;
            const preset = {
                name,
                tables: [...dbSharingSettings.selectedTables],
                configName: dbSharingSettings.configName
            };
            dbSharingPresets.value.push(preset);
            localStorage.setItem('dbSharingPresets', JSON.stringify(dbSharingPresets.value));
        };

        const loadPreset = (preset) => {
            dbSharingSettings.selectedTables = [...preset.tables];
            dbSharingSettings.configName = preset.configName;
        };

        const deletePreset = (index) => {
            if (confirm("Delete this preset?")) {
                dbSharingPresets.value.splice(index, 1);
                localStorage.setItem('dbSharingPresets', JSON.stringify(dbSharingPresets.value));
            }
        };

        watch(() => dbSharingSettings.backupMode, (val) => {
            if (!val && publishedReleases.value.length > 0) {
                latestPublishedDb.value = publishedReleases.value[0];
            }
        });

        const getLineNumbers = (text) => {
            const linesCount = (text || '').split('\n').length;
            return Array.from({length: linesCount}, (_, i) => i + 1).join('\n');
        };

        const importFromCsv = async () => {
            const csvUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRRY1f7ZXQDFDuI3ski7y0XK5atAbFmL24jIf_CL8_Vl2EOxE3TyVrZ4gllmMk8Ly8XKblaDIm3kW8X/pub?gid=2082459828&single=true&output=csv';

            try {
                isLoading.value = true;
                const response = await fetch(csvUrl);
                if (!response.ok) throw new Error('Failed to fetch CSV');
                const csvText = await response.text();

                // Simple CSV parser that handles quotes
                const lines = csvText.split(/\r?\n/);
                if (lines.length <= 1) return;

                const parseLine = (line) => {
                    const parts = [];
                    let current = '';
                    let inQuotes = false;
                    for (let i = 0; i < line.length; i++) {
                        const char = line[i];
                        if (char === '"') {
                            if (inQuotes && line[i+1] === '"') { // escaped quote
                                current += '"';
                                i++;
                            } else {
                                inQuotes = !inQuotes;
                            }
                        } else if (char === ',' && !inQuotes) {
                            parts.push(current);
                            current = '';
                        } else {
                            current += char;
                        }
                    }
                    parts.push(current);
                    return parts.map(p => p.trim().replace(/^"(.*)"$/, '$1'));
                };

                const arabic = [];
                const transliteration = [];
                const translation = [];
                const english = [];

                // Skip header line
                for (let i = 1; i < lines.length; i++) {
                    if (!lines[i].trim()) continue;
                    const [ar, tr, tl, en] = parseLine(lines[i]);
                    arabic.push(ar || '');
                    transliteration.push(tr || '');
                    translation.push(tl || '');
                    english.push(en || '');
                }

                bulkInput.arabic = arabic.join('\n');
                bulkInput.transliteration = transliteration.join('\n');
                bulkInput.translation = translation.join('\n');
                bulkInput.english = english.join('\n');

                alert(`Successfully imported ${arabic.length} rows from CSV! Review and click "Process & Align Grid" below.`);
            } catch (err) {
                console.error(err);
                alert('Error importing CSV: ' + err.message);
            } finally {
                isLoading.value = false;
            }
        };

        const processBulkTranslations = () => {
            const arEmpty = bulkInput.arabic.trim() === '';
            const trEmpty = bulkInput.transliteration.trim() === '';
            const tlEmpty = bulkInput.translation.trim() === '';
            const enEmpty = bulkInput.english.trim() === '';

            if (arEmpty && trEmpty && tlEmpty && enEmpty) {
                alert("Please paste some text first.");
                return;
            }

            const arLines = arEmpty ? [] : bulkInput.arabic.split('\n');
            const trLines = trEmpty ? [] : bulkInput.transliteration.split('\n');
            const tlLines = tlEmpty ? [] : bulkInput.translation.split('\n');
            const enLines = enEmpty ? [] : bulkInput.english.split('\n');

            const maxLines = Math.max(arLines.length, trLines.length, tlLines.length, enLines.length);

            let currentSeq = translations.value.length > 0 ? Math.max(...translations.value.map(t => t.sequence)) : 0;
            const langTitle = showTranslationsFor.value.english_name;

            const newTranslations = [];
            for (let i = 0; i < maxLines; i++) {
                const ar = arEmpty ? null : (arLines[i] || '').trim();
                const tr = trEmpty ? null : (trLines[i] || '').trim();
                const tl = tlEmpty ? null : (tlLines[i] || '').trim();
                const en = enEmpty ? null : (enLines[i] || '').trim();

                // Only skip if we are at the very end and all are empty
                // (prevents trailing empty rows from extra newlines)
                if (i >= arLines.length && i >= trLines.length && i >= tlLines.length && i >= enLines.length) continue;
                if (!ar && !tr && !tl && !en && i === maxLines - 1) continue;

                currentSeq++;
                newTranslations.push({
                    id: null, // New record
                    sequence: currentSeq,
                    language_title: langTitle,
                    arabic: ar,
                    transliteration: tr,
                    translation: tl,
                    english: en,
                    is_visible: true,
                    isEditing: false
                });
            }

            translations.value = [...translations.value, ...newTranslations];
            unsavedChanges.value = true;

            bulkInput.arabic = '';
            bulkInput.transliteration = '';
            bulkInput.translation = '';
            bulkInput.english = '';
        };

        const addTranslationRow = () => {
            const currentSeq = translations.value.length > 0 ? Math.max(...translations.value.map(t => t.sequence)) : 0;
            translations.value.push({
                id: null,
                sequence: currentSeq + 1,
                language_title: showTranslationsFor.value.english_name,
                arabic: '',
                transliteration: '',
                translation: '',
                english: '',
                is_visible: true,
                isEditing: true // Auto edit mode for new row
            });
            unsavedChanges.value = true;
        };

        const removeTranslationRow = (index) => {
            const row = translations.value[index];
            if (row.id) {
                deletedTranslationIds.value.push(row.id);
            }
            translations.value.splice(index, 1);
            unsavedChanges.value = true;
        };

        const toggleEditTranslation = (index) => {
            fetchAllCategories();
            const row = translations.value[index];
            row.isEditing = !row.isEditing;
            if (row.isEditing) {
                // Initialize category name for the move dropdown
                const cat = allCategories.value.find(c => c.id === showTranslationsFor.value.id);
                row.category_name = cat ? cat.english_name : '';
            }
            unsavedChanges.value = true;
        };

        const copySql = async (id) => {
            if (!id) return;
            const sql = `select * from item_translations where id = ${id}`;
            try {
                await navigator.clipboard.writeText(sql);
                alert("SQL Copied to clipboard!");
            } catch (err) {
                console.error('Failed to copy text: ', err);
            }
        };

        const copyToClipboard = async (text) => {
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                alert("Copied to clipboard!");
            } catch (err) {
                console.error('Failed to copy text: ', err);
            }
        };

        const sortTranslations = () => {
            translations.value.sort((a, b) => {
                const seqA = parseInt(a.sequence) || 0;
                const seqB = parseInt(b.sequence) || 0;
                return seqA - seqB;
            });
            unsavedChanges.value = true;
        };

        const saveTranslations = async () => {
            const catId = showTranslationsFor.value.id;

            const validRows = translations.value.filter(
                row => (row.arabic ?? '').trim() !== '' || (row.transliteration ?? '').trim() !== '' || (row.translation ?? '').trim() !== '' || (row.english ?? '').trim() !== ''
            );

            const hasTransliteration = validRows.some(row => (row.transliteration ?? '').trim() !== '');

            isLoading.value = true;
            error.value = null;

            try {
                const stmts = [];

                // 1. Process Deletions
                deletedTranslationIds.value.forEach(id => {
                    stmts.push({
                        sql: 'DELETE FROM item_translations WHERE id = ?',
                        args: [id]
                    });
                });

                // 2. Process Inserts/Updates
                validRows.forEach((row) => {
                    const targetCatId = row.new_category_id || catId;
                    if (row.id) {
                        // Update
                        stmts.push({
                            sql: `UPDATE item_translations SET
                                    category_id = ?, sequence = ?, language_title = ?, arabic = ?, translation = ?, transliteration = ?, english = ?, is_visible = ?
                                  WHERE id = ?`,
                            args: [
                                targetCatId, row.sequence, row.language_title.trim(), row.arabic == null ? null : row.arabic.trim(), row.translation == null ? null : row.translation.trim(), row.transliteration == null ? null : row.transliteration.trim(), row.english == null ? null : row.english.trim(), row.is_visible ? 1 : 0, row.id
                            ]
                        });
                    } else {
                        // Insert
                        stmts.push({
                            sql: `INSERT INTO item_translations
                                    (category_id, sequence, language_title, arabic, translation, transliteration, english, is_visible)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            args: [
                                targetCatId, row.sequence, row.language_title.trim(), row.arabic == null ? null : row.arabic.trim(), row.translation == null ? null : row.translation.trim(), row.transliteration == null ? null : row.transliteration.trim(), row.english == null ? null : row.english.trim(), row.is_visible ? 1 : 0
                            ]
                        });
                    }
                });

                // 3. Update category is_trans flag based on content
                stmts.push({
                    sql: 'UPDATE categories SET is_trans = ? WHERE id = ?',
                    args: [hasTransliteration ? 1 : 0, catId]
                });

                await dbBatch(stmts);

                unsavedChanges.value = false;
                deletedTranslationIds.value = [];

                // Refresh rows to get new IDs
                await fetchTranslationsForCategoryAndLanguage();

                alert("Content translations saved successfully!");

            } catch (err) {
                error.value = "Failed to save content: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        const updateParentId = () => {
            const match = allCategories.value.find(c => c.english_name === editingCategory.value.parent_name);
            editingCategory.value.parent_id = match ? match.id : null;
            unsavedChanges.value = true;
        };

        const updateRowCategoryId = (row) => {
            const match = allCategories.value.find(c => c.english_name === row.category_name);
            if (match) {
                row.new_category_id = match.id;
            } else {
                row.new_category_id = null;
            }
            unsavedChanges.value = true;
        };

        return {
            dbUrl, authToken, isDbConnected, isLoggedIn, isLoading, error, currentUser, loginForm,
            connectDb, disconnectDb, userLogin, logout,
            currentBranch, availableBranches, switchBranch,

            currentView, languages,
            fetchLanguages, openLanguageModal, closeLanguageModal, saveLanguage, deleteLanguage,
            editingLanguage, showLanguageModal,

            users, showUserModal, editingUser,
            fetchUsers, openUserModal, saveUser, deleteUser,

            categories, breadcrumbs, currentCategory,
            fetchCategories, openCategory, goToBreadcrumb,

            showCategoryModal, editingCategory, openCategoryModal, closeCategoryModal, saveCategory, deleteCategory, fetchAllCategories,

            mediaTestUrl, mediaTestType, testMedia, showExportModal,

            dragStart, dragOver, drop, draggedIndex, dropTargetIndex,
            allCategories,

            showTranslationsFor, translations, unsavedChanges, bulkInput, selectedLanguageId, selectedLanguageName, categoryMeta,
            viewTranslations, closeTranslations, processBulkTranslations, getLineNumbers,
            updateParentId, updateRowCategoryId,
            importFromCsv, addTranslationRow, removeTranslationRow, toggleEditTranslation, copySql, sortTranslations, saveTranslations, saveCategoryMeta,

            availableTables, githubToken, dbSharingSettings, dbSharingPresets, latestPublishedDb, publishedReleases, currentDbVersion,
            triggerPublishWorkflow, savePreset, loadPreset, deletePreset, copyToClipboard, updateHash
        };
    }
});

app.mount('#app');
