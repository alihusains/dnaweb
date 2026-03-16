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

        // Navigation & UI State
        const currentView = ref('categories');
        const users = ref([]);
        const showUserModal = ref(false);
        const editingUser = ref({ id: null, email: '', password: '', role: 'editor', github_token: '' });
        const categories = ref([]);
        const breadcrumbs = ref([]);
        const currentCategory = ref(null);

        // --- Database Helpers (Replacement for @libsql/client) ---
        const mapArgs = (args) => {
            if (!args) return [];
            return args.map(arg => {
                if (arg === null) return { type: 'null', value: null };
                if (typeof arg === 'number') return { type: 'integer', value: String(arg) };
                if (typeof arg === 'boolean') return { type: 'integer', value: arg ? '1' : '0' };
                return { type: 'text', value: String(arg) };
            });
        };

        const dbRequest = async (requests) => {
            let url = dbUrl.value.replace('libsql://', 'https://');
            if (url.endsWith('/')) url = url.slice(0, -1);
            if (!url.endsWith('/v2/pipeline')) url += '/v2/pipeline';

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${authToken.value}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ requests })
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${text}`);
            }

            const data = await response.json();
            if (data.error) throw new Error(data.error.message || data.error);
            return data.results;
        };

        const dbExecute = async (sqlOrConfig) => {
            const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig.sql;
            const args = typeof sqlOrConfig === 'string' ? [] : (sqlOrConfig.args || []);

            const requests = [
                {
                    type: 'execute',
                    stmt: {
                        sql,
                        args: mapArgs(args)
                    }
                },
                { type: 'close' }
            ];

            const results = await dbRequest(requests);
            const execResult = results[0];

            if (execResult.type === 'error') throw new Error(execResult.error.message);

            const result = execResult.response.result;
            if (!result || !result.cols) return { rows: [], columns: [] };

            const rows = result.rows.map(row => {
                const obj = {};
                result.cols.forEach((col, i) => {
                    const val = row[i];
                    // Turso values can be objects with a 'value' property
                    obj[col.name] = (val && typeof val === 'object' && 'value' in val) ? val.value : val;
                });
                return obj;
            });

            return { rows };
        };

        const dbBatch = async (stmts) => {
            const requests = stmts.map(s => ({
                type: 'execute',
                stmt: {
                    sql: s.sql,
                    args: mapArgs(s.args)
                }
            }));
            requests.push({ type: 'close' });

            const results = await dbRequest(requests);

            // Check for errors in any result
            for (const res of results) {
                if (res.type === 'error') throw new Error(res.error.message);
            }

            return results;
        };

        // Login form state
        const loginForm = reactive({
            email: '',
            password: ''
        });

        // Hashing helper
        const hashPassword = async (password) => {
            const encoder = new TextEncoder();
            const data = encoder.encode(password);
            const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        };

        // Navigation State
        // --- User Management ---
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
                    // Update
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
                    // Insert
                    if (!editingUser.value.password) throw new Error("Password is required for new users.");
                    const hashedPassword = await hashPassword(editingUser.value.password);
                    await dbExecute({
                        sql: 'INSERT INTO users (email, password_hash, role, github_token) VALUES (?, ?, ?, ?)',
                        args: [editingUser.value.email, hashedPassword, editingUser.value.role, editingUser.value.github_token]
                    });
                }
                showUserModal.value = false;
                await fetchUsers();

                // If editing self, update current session
                if (editingUser.value.id === currentUser.value?.id) {
                    currentUser.value.email = editingUser.value.email;
                    currentUser.value.role = editingUser.value.role;
                    currentUser.value.github_token = editingUser.value.github_token;
                    githubToken.value = editingUser.value.github_token;
                    localStorage.setItem('cmsUser', JSON.stringify(currentUser.value));
                }
            } catch (err) {
                error.value = "Failed to save user: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        const deleteUser = async (user) => {
            if (user.id === currentUser.value.id) {
                alert("You cannot delete yourself.");
                return;
            }
            if (!confirm(`Delete user ${user.email}?`)) return;
            isLoading.value = true;
            try {
                await dbExecute({
                    sql: 'DELETE FROM users WHERE id = ?',
                    args: [user.id]
                });
                await fetchUsers();
            } catch (err) {
                error.value = "Failed to delete user: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        // Languages State
        const languages = ref([]);
        const showLanguageModal = ref(false);
        const editingLanguage = ref({
            id: null, code: '', name: '', is_rtl: 0
        });

        // Edit Modal State
        const showCategoryModal = ref(false);
        const editingCategory = ref({
            id: null, parent_id: null, sequence: 0, lang_name: '', english_name: '',
            audio_url: '', video_url: '', duas_url: '', local_audio_url: '', local_video_url: '',
            related1: null, related2: null, notify_hijri_date: '', label1: '', label2: '',
            is_last_level: false, language_code: ''
        });

        // Media Test Modal State
        const mediaTestUrl = ref(null);
        const mediaTestType = ref(null); // 'audio' or 'video'

        // Export Modal
        const showExportModal = ref(false);

        // Drag and Drop State
        const draggedIndex = ref(null);
        const dropTargetIndex = ref(null);

        // Translation Content State
        const showTranslationsFor = ref(null);
        const translations = ref([]);
        const deletedTranslationIds = ref([]);
        const selectedLanguageId = ref(null);
        const unsavedChanges = ref(false);

        const selectedLanguageCode = computed(() => {
            const lang = languages.value.find(l => l.id === selectedLanguageId.value);
            return lang ? lang.code : '';
        });

        const selectedLanguageName = computed(() => {
            const lang = languages.value.find(l => l.id === selectedLanguageId.value);
            return lang ? lang.name : 'Local';
        });

        const categoryMeta = ref({
            audio_url: '', video_url: '', duas_url: '',
            related1: null, related2: null, notify_hijri_date: '',
            label1: '', label2: '', is_trans: 0
        });

        // --- Database Sharing State ---
        const availableTables = ref([]);
        const githubToken = ref(localStorage.getItem('githubToken') || '');
        const dbSharingSettings = reactive({
            selectedTables: [],
            autoIncrement: true,
            manualVersion: '',
            configName: 'default',
            backupMode: false,
            triggerMethod: 'dispatch' // 'dispatch' or 'commit'
        });
        const dbSharingPresets = ref(JSON.parse(localStorage.getItem('dbSharingPresets') || '[]'));
        const latestPublishedDb = ref({ version: '0.0', url: '', date: '' });
        const publishedReleases = ref([]);

        const currentDbVersion = ref(0);

        const bulkInput = reactive({
            arabic: '',
            transliteration: '',
            translation: ''
        });

        // --- Lifecycle ---
        onMounted(async () => {
            // Priority 1: window.CONFIG (GitHub Secrets / Local config.js)
            if (window.CONFIG?.url && window.CONFIG?.token) {
                dbUrl.value = window.CONFIG.url;
                authToken.value = window.CONFIG.token;
            } else {
                // Priority 2: LocalStorage fallback
                const savedDbUrl = localStorage.getItem('tursoDbUrl');
                const savedAuthToken = localStorage.getItem('tursoAuthToken');

                if (savedDbUrl && savedAuthToken) {
                    dbUrl.value = savedDbUrl;
                    authToken.value = savedAuthToken;
                } else {
                    // Default fallback URL (useful for initial clone)
                    dbUrl.value = 'libsql://duasandaamalapp-alihusains.aws-ap-northeast-1.turso.io';
                }
            }

            if (dbUrl.value && authToken.value) {
                try {
                    await connectDb();

                    // Restore user session with 48h expiry check
                    const savedUser = localStorage.getItem('cmsUser');
                    const sessionExpiry = localStorage.getItem('cmsSessionExpiry');

                    if (savedUser && sessionExpiry) {
                        if (Date.now() < parseInt(sessionExpiry)) {
                            currentUser.value = JSON.parse(savedUser);
                            if (currentUser.value.github_token) {
                                githubToken.value = currentUser.value.github_token;
                            }
                            isLoggedIn.value = true;
                            await fetchLanguages();
                            await fetchCategories(null);
                        } else {
                            console.log("Session expired.");
                            logout();
                        }
                    }
                } catch (e) {
                    console.log("Auto-connect or session restoration failed:", e);
                }
            }
        });

        // --- stage 1: Database Connection ---
        const connectDb = async () => {
            isLoading.value = true;
            error.value = null;
            try {
                // Test connection
                await dbExecute('SELECT 1');

                // Save to local storage for this device
                localStorage.setItem('tursoDbUrl', dbUrl.value);
                localStorage.setItem('tursoAuthToken', authToken.value);

                isDbConnected.value = true;
            } catch (err) {
                error.value = "Connection failed: " + err.message;
                isDbConnected.value = false;
                throw err;
            } finally {
                isLoading.value = false;
            }
        };

        // --- stage 2: User Login ---
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
                        email: user.email,
                        role: user.role,
                        github_token: user.github_token
                    };
                    isLoggedIn.value = true;

                    // Populate GitHub token if present
                    if (user.github_token) {
                        githubToken.value = user.github_token;
                    }

                    // Save session to LocalStorage (48h expiry)
                    const expiry = Date.now() + (48 * 60 * 60 * 1000);
                    localStorage.setItem('cmsUser', JSON.stringify(currentUser.value));
                    localStorage.setItem('cmsSessionExpiry', expiry.toString());

                    // Clear password from memory
                    loginForm.password = '';

                    await fetchLanguages();
                    await fetchCategories(null);
                } else {
                    error.value = "Invalid email or password.";
                }
            } catch (err) {
                error.value = "Login error: " + err.message;
            } finally {
                isLoading.value = false;
            }
        };

        const logout = () => {
            isLoggedIn.value = false;
            currentUser.value = null;
            localStorage.removeItem('cmsUser');
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

        const openCategory = async (category) => {
            breadcrumbs.value.push(category);
            currentCategory.value = category;
            await fetchCategories(category.id);
        };

        const goToBreadcrumb = async (index) => {
            if (index === -1) {
                breadcrumbs.value = [];
                currentCategory.value = null;
                await fetchCategories(null);
            } else {
                breadcrumbs.value = breadcrumbs.value.slice(0, index + 1);
                currentCategory.value = breadcrumbs.value[index];
                await fetchCategories(currentCategory.value.id);
            }
            showTranslationsFor.value = null;
        };

        // --- Category CRUD ---
        const openCategoryModal = (category = null) => {
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
                    notify_hijri_date: category.notify_hijri_date == null ? '' : String(category.notify_hijri_date),
                    label1: category.label1 == null ? '' : String(category.label1),
                    label2: category.label2 == null ? '' : String(category.label2),
                    is_trans: category.is_trans || 0,
                    is_last_level: category.is_last_level,
                    language_code: category.language_code || selectedLanguageCode.value
                };
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
                    related1: null, related2: null, notify_hijri_date: '', label1: '', label2: '',
                    is_trans: 0,
                    is_last_level: false,
                    language_code: selectedLanguageCode.value
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
                                lang_name = ?, english_name = ?,
                                audio_url = ?, video_url = ?, duas_url = ?,
                                local_audio_url = ?, local_video_url = ?,
                                related1 = ?, related2 = ?, notify_hijri_date = ?, label1 = ?, label2 = ?,
                                is_last_level = ?, is_trans = ?, language_code = ?
                              WHERE id = ?`,
                        args: [
                            editingCategory.value.lang_name,
                            editingCategory.value.english_name,
                            editingCategory.value.audio_url || null,
                            editingCategory.value.video_url || null,
                            editingCategory.value.duas_url || null,
                            editingCategory.value.local_audio_url || null,
                            editingCategory.value.local_video_url || null,
                            editingCategory.value.related1 || null,
                            editingCategory.value.related2 || null,
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
                                (parent_id, sequence, lang_name, english_name, audio_url, video_url, duas_url, local_audio_url, local_video_url, related1, related2, notify_hijri_date, label1, label2, is_last_level, is_trans, language_code)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            } catch (err) {
                error.value = "Failed to delete: " + err.message;
            } finally {
                isLoading.value = false;
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
        const viewTranslations = async (category) => {
            showTranslationsFor.value = category;
            unsavedChanges.value = false;
            deletedTranslationIds.value = [];

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
                const result = await dbExecute({
                    sql: 'SELECT * FROM item_translations WHERE category_id = ? ORDER BY sequence ASC',
                    args: [showTranslationsFor.value.id]
                });

                translations.value = result.rows.map(row => ({
                    id: row.id,
                    sequence: row.sequence,
                    language_title: row.language_title == null ? '' : String(row.language_title),
                    arabic: row.arabic == null ? '' : String(row.arabic),
                    transliteration: row.transliteration == null ? '' : String(row.transliteration),
                    translation: row.translation == null ? '' : String(row.translation),
                    is_visible: row.is_visible === 1,
                    isEditing: false
                }));
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
            // Refresh categories in case meta was updated
            fetchCategories(currentCategory.value ? currentCategory.value.id : null);
        };

        const saveCategoryMeta = async () => {
            if (!showTranslationsFor.value) return;
            isLoading.value = true;
            error.value = null;
            try {
                await dbExecute({
                    sql: `UPDATE categories SET
                            audio_url = ?, video_url = ?, duas_url = ?,
                            related1 = ?, related2 = ?, notify_hijri_date = ?, label1 = ?, label2 = ?,
                            is_trans = ?
                          WHERE id = ?`,
                    args: [
                        categoryMeta.value.audio_url || null,
                        categoryMeta.value.video_url || null,
                        categoryMeta.value.duas_url || null,
                        categoryMeta.value.related1 || null,
                        categoryMeta.value.related2 || null,
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
                const pathParts = window.location.pathname.split('/').filter(Boolean);
                let owner = 'alihusainsorathiya', repo = 'dnaweb';

                if (pathParts.length >= 2) {
                    owner = pathParts[0];
                    repo = pathParts[1];
                }

                const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
                    headers: { 'Authorization': `token ${githubToken.value}` }
                });
                if (response.ok) {
                    const data = await response.json();
                    publishedReleases.value = data.map(r => ({
                        version: r.tag_name.replace('v', ''),
                        date: new Date(r.published_at).toLocaleString(),
                        url: r.assets.find(a => a.name.endsWith('.db'))?.browser_download_url || ''
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
                const pathParts = window.location.pathname.split('/').filter(Boolean);
                let owner = 'alihusainsorathiya', repo = 'dnaweb';

                if (pathParts.length >= 2) {
                    owner = pathParts[0];
                    repo = pathParts[1];
                }

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
                const pathParts = window.location.pathname.split('/').filter(Boolean);
                let owner = 'alihusainsorathiya', repo = 'dnaweb';

                if (pathParts.length >= 2) {
                    owner = pathParts[0];
                    repo = pathParts[1];
                }

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
                        sha: sha
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

        watch(currentView, (newView) => {
            if (newView === 'db-sharing') {
                fetchAvailableTables();
                fetchCurrentVersion();
                fetchReleases();
            }
        });

        watch(() => dbSharingSettings.backupMode, (val) => {
            if (!val && publishedReleases.value.length > 0) {
                latestPublishedDb.value = publishedReleases.value[0];
            }
        });

        const getLineNumbers = (text) => {
            const linesCount = (text || '').split('\n').length;
            return Array.from({length: linesCount}, (_, i) => i + 1).join('\n');
        };

        const processBulkTranslations = () => {
            const arLines = bulkInput.arabic.split('\n');
            const trLines = bulkInput.transliteration.split('\n');
            const tlLines = bulkInput.translation.split('\n');

            const maxLines = Math.max(arLines.length, trLines.length, tlLines.length);

            if (maxLines === 0 || (bulkInput.arabic === '' && bulkInput.transliteration === '' && bulkInput.translation === '')) {
                alert("Please paste some text first.");
                return;
            }

            let currentSeq = translations.value.length > 0 ? Math.max(...translations.value.map(t => t.sequence)) : 0;
            const langTitle = showTranslationsFor.value.english_name;

            const newTranslations = [];
            for (let i = 0; i < maxLines; i++) {
                const ar = (arLines[i] || '').trim();
                const tr = (trLines[i] || '').trim();
                const tl = (tlLines[i] || '').trim();

                // Only skip if we are at the very end and all are empty
                // (prevents trailing empty rows from extra newlines)
                if (i >= arLines.length && i >= trLines.length && i >= tlLines.length) continue;
                if (ar === '' && tr === '' && tl === '' && i === maxLines - 1) continue;

                currentSeq++;
                newTranslations.push({
                    id: null, // New record
                    sequence: currentSeq,
                    language_title: langTitle,
                    arabic: ar,
                    transliteration: tr,
                    translation: tl,
                    is_visible: true,
                    isEditing: false
                });
            }

            translations.value = [...translations.value, ...newTranslations];
            unsavedChanges.value = true;

            bulkInput.arabic = '';
            bulkInput.transliteration = '';
            bulkInput.translation = '';
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
            translations.value[index].isEditing = !translations.value[index].isEditing;
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
                row => row.arabic.trim() !== '' || row.transliteration.trim() !== '' || row.translation.trim() !== ''
            );

            const hasTransliteration = validRows.some(row => row.transliteration.trim() !== '');

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
                    if (row.id) {
                        // Update
                        stmts.push({
                            sql: `UPDATE item_translations SET
                                    sequence = ?, language_title = ?, arabic = ?, translation = ?, transliteration = ?, is_visible = ?
                                  WHERE id = ?`,
                            args: [
                                row.sequence, row.language_title.trim(), row.arabic.trim(), row.translation.trim(), row.transliteration.trim(), row.is_visible ? 1 : 0, row.id
                            ]
                        });
                    } else {
                        // Insert
                        stmts.push({
                            sql: `INSERT INTO item_translations
                                    (category_id, sequence, language_title, arabic, translation, transliteration, is_visible)
                                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            args: [
                                catId, row.sequence, row.language_title.trim(), row.arabic.trim(), row.translation.trim(), row.transliteration.trim(), row.is_visible ? 1 : 0
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

        return {
            dbUrl, authToken, isDbConnected, isLoggedIn, isLoading, error, currentUser, loginForm,
            connectDb, disconnectDb, userLogin, logout,

            currentView, languages,
            fetchLanguages, openLanguageModal, closeLanguageModal, saveLanguage, deleteLanguage,
            editingLanguage, showLanguageModal,

            users, showUserModal, editingUser,
            fetchUsers, openUserModal, saveUser, deleteUser,

            categories, breadcrumbs, currentCategory,
            fetchCategories, openCategory, goToBreadcrumb,

            showCategoryModal, editingCategory, openCategoryModal, closeCategoryModal, saveCategory, deleteCategory,

            mediaTestUrl, mediaTestType, testMedia, showExportModal,

            dragStart, dragOver, drop, draggedIndex, dropTargetIndex,

            showTranslationsFor, translations, unsavedChanges, bulkInput, selectedLanguageId, selectedLanguageName, categoryMeta,
            viewTranslations, closeTranslations, processBulkTranslations, getLineNumbers,
            addTranslationRow, removeTranslationRow, toggleEditTranslation, copySql, sortTranslations, saveTranslations, saveCategoryMeta,

            availableTables, githubToken, dbSharingSettings, dbSharingPresets, latestPublishedDb, publishedReleases, currentDbVersion,
            triggerPublishWorkflow, savePreset, loadPreset, deletePreset, copyToClipboard
        };
    }
});

app.mount('#app');
