/* ================================================================
   Youth Transformers — auth.js (Firebase Edition, single file)
   Loads AFTER the 4 firebase-*-compat.js <script> tags.
   Exposes window.YT with:
     • YT.sb      — Supabase-compatible adapter over Firebase
     • All auth helpers (signIn, signUp, signOut, reset, etc.)
     • YT.ROLE_SECTIONS / YT.SECTION_LABELS / YT.canAccess
     • YT.writeAudit / YT.uploadMedia / YT.restoreSession
   ================================================================ */
(function () {
  'use strict';

  /* ─────────── Firebase config ─────────── */
  const firebaseConfig = {
    apiKey: "AIzaSyA8qaMX8AUH4X9xfWz8BimpS-TluIit5bM",
    authDomain: "youth-transformers-rwanda.firebaseapp.com",
    projectId: "youth-transformers-rwanda",
    storageBucket: "youth-transformers-rwanda.firebasestorage.app",
    messagingSenderId: "522013775817",
    appId: "1:522013775817:web:249045a0a77ae10d6bfa18",
    measurementId: "G-B7WMK9XMGK"
  };

  if (!window.firebase) {
    console.error('[auth] Firebase compat SDK not loaded. Load firebase-app-compat.js, firebase-auth-compat.js, firebase-firestore-compat.js, firebase-storage-compat.js BEFORE auth.js.');
    return;
  }

  if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(firebaseConfig);
  const fbAuth  = firebase.auth();
  const db      = firebase.firestore();
  const storage = firebase.storage();

  let CURRENT_PROFILE = null;
  let CURRENT_ORG     = null;
  let CURRENT_USER    = null;

  fbAuth.onAuthStateChanged(u => { CURRENT_USER = u; });

  /* ─────────── Error helper ─────────── */
  function makeError(code, detail, cause) {
    const e = new Error(code);
    e.code = code;
    e.detail = detail || code;
    if (cause) e.cause = cause;
    console.error('[auth:' + code + ']', detail || code, cause || '');
    return e;
  }

  /* ─────────── Firestore auto-id (matches Firebase format) ─────────── */
  const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  function newId() {
    let s = '';
    for (let i = 0; i < 20; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    return s;
  }

  /* ══════════════════════════════════════════════════════════
     QueryBuilder — Supabase-shaped API over Firestore
     ══════════════════════════════════════════════════════════ */
  class QueryBuilder {
    constructor(table) {
      this.table = table;
      this._filters   = [];
      this._orExpr    = null;
      this._orderBy   = [];
      this._limitN    = null;
      this._range     = null;
      this._selectCols = null;
      this._countOpt  = null;
      this._head      = false;
      this._op        = 'select';
      this._payload   = null;
      this._singleMode = null;
    }

    select(cols, opts) {
      this._selectCols = cols || '*';
      if (opts) {
        if (opts.count) this._countOpt = opts.count;
        if (opts.head)  this._head = true;
      }
      return this;
    }

    eq(c, v)  { this._filters.push({ c, op: '==', v }); return this; }
    neq(c, v) { this._filters.push({ c, op: '!=', v }); return this; }
    gt(c, v)  { this._filters.push({ c, op: '>',  v }); return this; }
    gte(c, v) { this._filters.push({ c, op: '>=', v }); return this; }
    lt(c, v)  { this._filters.push({ c, op: '<',  v }); return this; }
    lte(c, v) { this._filters.push({ c, op: '<=', v }); return this; }
    in(c, v)  { this._filters.push({ c, op: 'in', v }); return this; }
    contains(c, v) { this._filters.push({ c, op: 'array-contains', v }); return this; }
    not(c, op, v)  { this._filters.push({ c, op: 'not-' + op, v }); return this; }
    ilike(c, v)    { this._filters.push({ c, op: 'ilike', v }); return this; }
    or(expr)  { this._orExpr = expr; return this; }

    order(col, opts) {
      this._orderBy.push({ c: col, asc: !(opts && opts.ascending === false) });
      return this;
    }
    limit(n) { this._limitN = n; return this; }
    range(f, t) { this._range = { f, t }; return this; }
    single()      { this._singleMode = 'single'; return this; }
    maybeSingle() { this._singleMode = 'maybeSingle'; return this; }

    insert(d) { this._op = 'insert'; this._payload = Array.isArray(d) ? d : [d]; return this; }
    update(d) { this._op = 'update'; this._payload = d; return this; }
    delete()  { this._op = 'delete'; return this; }
    upsert(d) { this._op = 'upsert'; this._payload = Array.isArray(d) ? d : [d]; return this; }

    then(res, rej) { return this._run().then(res, rej); }
    catch(rej)     { return this._run().catch(rej); }

    async _run() {
      try {
        if (this._op === 'select') return await this._runSelect();
        if (this._op === 'insert') return await this._runInsert();
        if (this._op === 'update') return await this._runUpdate();
        if (this._op === 'delete') return await this._runDelete();
        if (this._op === 'upsert') return await this._runUpsert();
        return { data: null, error: { message: 'Unknown op' }, count: 0 };
      } catch (e) {
        console.error('[' + this.table + ':' + this._op + ']', e);
        return { data: null, error: { message: e.message || String(e), code: e.code }, count: 0 };
      }
    }

    _project(row) {
      if (!this._selectCols || this._selectCols === '*') return row;
      const cols = this._selectCols.split(',').map(s => s.trim()).filter(Boolean);
      const out = {};
      cols.forEach(c => { if (c in row) out[c] = row[c]; });
      return out;
    }

    _buildBaseQuery() {
      const supported = ['==', '!=', '>', '>=', '<', '<=', 'array-contains', 'in'];
      const fsFilters     = this._filters.filter(f => supported.includes(f.op));
      const clientFilters = this._filters.filter(f => !supported.includes(f.op));

      let ref = db.collection(this.table);
      for (const f of fsFilters) {
        if (f.op === 'in') ref = ref.where(f.c, 'in', f.v);
        else               ref = ref.where(f.c, f.op, f.v);
      }

      const hasIneq = fsFilters.some(f => ['!=', '>', '>=', '<', '<='].includes(f.op));
      if (!hasIneq && this._orderBy.length) {
        for (const o of this._orderBy) ref = ref.orderBy(o.c, o.asc ? 'asc' : 'desc');
      }

      // Hard safety cap — we always fetch with some limit to avoid runaway reads.
      const wanted = this._range ? this._range.t + 1 : (this._limitN || 0);
      const cap    = Math.max(wanted, 1) * 2;
      const finalLimit = Math.min(Math.max(cap, 500), 5000);
      ref = ref.limit(finalLimit);

      return { ref, clientFilters, hasIneq };
    }

    async _runSelect() {
      const { ref, clientFilters, hasIneq } = this._buildBaseQuery();

      let snap;
      try {
        snap = await ref.get();
      } catch (e) {
        // Fallback: unfiltered fetch + client-side filter (missing index / bad orderBy etc.)
        console.warn('[' + this.table + '] falling back to full scan:', e.message);
        snap = await db.collection(this.table).limit(5000).get();
      }

      let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Re-apply EVERY filter client-side to be safe (Firestore may have dropped some).
      rows = rows.filter(r => {
        for (const f of this._filters) {
          const val = r[f.c];
          switch (f.op) {
            case '==':              if (val !== f.v) return false; break;
            case '!=':              if (val === f.v) return false; break;
            case '>':               if (!(val > f.v)) return false; break;
            case '>=':              if (!(val >= f.v)) return false; break;
            case '<':               if (!(val < f.v)) return false; break;
            case '<=':              if (!(val <= f.v)) return false; break;
            case 'in':              if (!Array.isArray(f.v) || !f.v.includes(val)) return false; break;
            case 'array-contains':  if (!Array.isArray(val) || !val.includes(f.v)) return false; break;
            case 'ilike': {
              const needle = String(f.v || '').replace(/%/g, '').toLowerCase();
              if (!String(val ?? '').toLowerCase().includes(needle)) return false;
              break;
            }
            case 'not-is': {
              if (f.v === null) { if (val === null || val === undefined) return false; }
              else              { if (val === f.v) return false; }
              break;
            }
          }
        }
        return true;
      });

      // OR expression
      if (this._orExpr) {
        const clauses = this._orExpr.split(',').map(s => s.trim()).filter(Boolean);
        const parsed = clauses.map(cl => {
          const m = cl.match(/^([\w.]+)\.([\w]+)\.(.+)$/);
          return m ? { c: m[1], op: m[2], v: m[3] } : null;
        }).filter(Boolean);
        rows = rows.filter(r => parsed.some(p => {
          const val = String(r[p.c] ?? '');
          if (p.op === 'ilike') {
            const needle = String(p.v).replace(/%/g, '').toLowerCase();
            return val.toLowerCase().includes(needle);
          }
          if (p.op === 'eq')  return val === String(p.v);
          if (p.op === 'neq') return val !== String(p.v);
          return false;
        }));
      }

      // Client-side ordering (always — cheap and consistent)
      if (this._orderBy.length) {
        for (let i = this._orderBy.length - 1; i >= 0; i--) {
          const o = this._orderBy[i];
          rows.sort((a, b) => {
            const va = a[o.c], vb = b[o.c];
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            if (va < vb) return o.asc ? -1 : 1;
            if (va > vb) return o.asc ? 1 : -1;
            return 0;
          });
        }
      }

      const count = rows.length;
      if (this._range) rows = rows.slice(this._range.f, this._range.t + 1);
      else if (this._limitN) rows = rows.slice(0, this._limitN);

      rows = rows.map(r => this._project(r));

      if (this._singleMode) {
        if (!rows.length) {
          if (this._singleMode === 'single')
            return { data: null, error: { message: 'No rows found', code: 'PGRST116' }, count: 0 };
          return { data: null, error: null, count };
        }
        return { data: rows[0], error: null, count };
      }

      if (this._head) return { data: null, error: null, count };
      return { data: rows, error: null, count };
    }

    async _runInsert() {
      const results = [];
      for (const d of this._payload) {
        const id = d.id || newId();
        const data = { ...d, id };
        await db.collection(this.table).doc(id).set(data);
        results.push(data);
      }
      return { data: results, error: null };
    }

    async _runUpdate() {
      const sel = new QueryBuilder(this.table);
      sel._filters = [...this._filters];
      sel._limitN  = this._limitN || 500;
      const s = await sel._runSelect();
      if (s.error) return s;
      const matching = s.data || [];
      for (const row of matching) {
        await db.collection(this.table).doc(row.id).update(this._payload);
      }
      return { data: null, error: null, count: matching.length };
    }

    async _runDelete() {
      const sel = new QueryBuilder(this.table);
      sel._filters = [...this._filters];
      sel._limitN  = this._limitN || 500;
      const s = await sel._runSelect();
      if (s.error) return s;
      const matching = s.data || [];
      for (const row of matching) {
        await db.collection(this.table).doc(row.id).delete();
      }
      return { data: null, error: null, count: matching.length };
    }

    async _runUpsert() {
      const results = [];
      for (const d of this._payload) {
        const id = d.id || newId();
        const data = { ...d, id };
        await db.collection(this.table).doc(id).set(data, { merge: true });
        results.push(data);
      }
      return { data: results, error: null };
    }
  }

  /* ══════════════════════════════════════════════════════════
     Supabase-shaped sb adapter
     ══════════════════════════════════════════════════════════ */
  const sb = {
    from(table) { return new QueryBuilder(table); },

    auth: {
      getSession: async () => {
        const u = fbAuth.currentUser;
        if (!u) return { data: { session: null }, error: null };
        return { data: { session: { user: { id: u.uid, email: u.email, user_metadata: { full_name: u.displayName } } } }, error: null };
      },
      getUser: async () => {
        const u = fbAuth.currentUser;
        return { data: { user: u ? { id: u.uid, email: u.email } : null }, error: null };
      },
      signOut: async () => { await fbAuth.signOut(); return { error: null }; },
      signInWithPassword: async ({ email, password }) => {
        try { await fbAuth.signInWithEmailAndPassword(email, password); return { data: {}, error: null }; }
        catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
      },
      updateUser: async ({ password }) => {
        try {
          if (!fbAuth.currentUser) throw new Error('Not signed in');
          await fbAuth.currentUser.updatePassword(password);
          return { data: {}, error: null };
        } catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
      }
    },

    storage: {
      from(_bucket) {
        return {
          upload: async (path, file) => {
            try {
              const r = storage.ref('media/' + path);
              await r.put(file);
              const url = await r.getDownloadURL();
              return { data: { path, url }, error: null };
            } catch (e) { return { data: null, error: { message: e.message } }; }
          },
          getPublicUrl: () => ({ data: { publicUrl: '' } }),
          list: async (prefix) => {
            try {
              const r = storage.ref('media/' + (prefix || ''));
              const res = await r.listAll();
              return { data: res.items.map(i => ({ name: i.name, id: i.fullPath })), error: null };
            } catch (e) { return { data: null, error: { message: e.message } }; }
          }
        };
      }
    },

    rpc: async (name) => {
      if (name === 'generate_join_code') {
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        let code = '';
        for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
        return { data: code, error: null };
      }
      return { data: null, error: { message: 'RPC not implemented: ' + name } };
    },

    // Realtime is a no-op for now — messages still work via manual load/refresh.
    channel(_name) {
      const ch = {
        on(_t, _f, _cb) { return ch; },
        subscribe(cb) { if (cb) setTimeout(() => cb('SUBSCRIBED'), 10); return ch; },
        track() { return Promise.resolve(); },
        presenceState() { return {}; },
        unsubscribe() {}
      };
      return ch;
    },
    removeChannel() { /* no-op */ }
  };

  /* ══════════════════════════════════════════════════════════
     Auth helpers
     ══════════════════════════════════════════════════════════ */
  async function fetchProfile(userId) {
    try {
      const snap = await db.collection('profiles').doc(userId).get();
      if (!snap.exists) return null;
      return { id: snap.id, ...snap.data() };
    } catch (e) { throw makeError('PROFILE_FETCH_FAILED', e.message, e); }
  }
  async function fetchOrg(orgId) {
    if (!orgId) return null;
    try {
      const snap = await db.collection('organizations').doc(orgId).get();
      return snap.exists ? { id: snap.id, ...snap.data() } : null;
    } catch (e) { throw makeError('ORG_FETCH_FAILED', e.message, e); }
  }

  let _authResolved = false;
  fbAuth.onAuthStateChanged(() => { _authResolved = true; });
  function _waitAuth() {
    if (_authResolved) return Promise.resolve(fbAuth.currentUser);
    return new Promise(res => {
      const unsub = fbAuth.onAuthStateChanged(() => { unsub(); _authResolved = true; res(fbAuth.currentUser); });
    });
  }

  async function signIn(email, password) {
    if (!email || !password) throw makeError('MISSING_CREDENTIALS', 'Email and password required.');
    let cred;
    try { cred = await fbAuth.signInWithEmailAndPassword(email, password); }
    catch (e) {
      const c = e.code || '';
      if (/wrong-password|user-not-found|invalid-credential|invalid-email/.test(c))
        throw makeError('INVALID_CREDENTIALS', 'Invalid email or password.', e);
      if (/too-many-requests/.test(c)) throw makeError('RATE_LIMITED', e.message, e);
      if (/network/.test(c))           throw makeError('NETWORK_ERROR', e.message, e);
      throw makeError('AUTH_ERROR', e.message, e);
    }
    const user = cred.user;
    const profile = await fetchProfile(user.uid);
    if (!profile) { await fbAuth.signOut(); throw makeError('PROFILE_NOT_FOUND', 'No profile.'); }
    if (['suspended', 'disabled'].includes(profile.status)) {
      await fbAuth.signOut();
      throw makeError('ACCOUNT_SUSPENDED', 'Account status: ' + profile.status);
    }
    CURRENT_PROFILE = profile;
    try { CURRENT_ORG = await fetchOrg(profile.org_id); } catch (_) { CURRENT_ORG = null; }
    return { user, profile, org: CURRENT_ORG };
  }

  async function _oauthSignIn(provider) {
    let cred;
    try { cred = await fbAuth.signInWithPopup(provider); }
    catch (e) {
      if (e.code === 'auth/popup-closed-by-user') throw makeError('OAUTH_CANCELLED', 'Cancelled.');
      if (e.code === 'auth/operation-not-allowed') throw makeError('OAUTH_FAILED', 'Provider not enabled.', e);
      if (e.code === 'auth/unauthorized-domain')   throw makeError('OAUTH_FAILED', 'Domain not authorized.', e);
      throw makeError('OAUTH_FAILED', e.message, e);
    }
    const user = cred.user;
    let profile = await fetchProfile(user.uid);
    if (!profile) {
      const stub = {
        id: user.uid,
        email: user.email || '',
        full_name: user.displayName || '',
        role: 'ministry_admin',
        org_id: null,
        status: 'pending',
        created_at: new Date().toISOString()
      };
      await db.collection('profiles').doc(user.uid).set(stub);
      profile = stub;
    }
    CURRENT_PROFILE = profile;
    if (profile.org_id) { try { CURRENT_ORG = await fetchOrg(profile.org_id); } catch (_) {} }
    return { user, profile, org: CURRENT_ORG };
  }
  async function signInWithGoogle() {
    const p = new firebase.auth.GoogleAuthProvider();
    p.setCustomParameters({ prompt: 'select_account' });
    return _oauthSignIn(p);
  }
  async function signInWithApple() {
    const p = new firebase.auth.OAuthProvider('apple.com');
    p.addScope('email'); p.addScope('name');
    return _oauthSignIn(p);
  }

  async function hasActiveSession() { await _waitAuth(); return !!fbAuth.currentUser; }

  async function signOut() {
    CURRENT_PROFILE = null; CURRENT_ORG = null;
    try { await fbAuth.signOut(); } catch (_) {}
    window.location.replace('/login.html');
  }

  async function signUpMinistryAdmin({ full_name, ministry_name, email, password }) {
    let cred;
    try { cred = await fbAuth.createUserWithEmailAndPassword(email, password); }
    catch (e) {
      if (e.code === 'auth/email-already-in-use') throw makeError('EMAIL_ALREADY_REGISTERED', 'Email already registered.', e);
      if (e.code === 'auth/weak-password')        throw makeError('WEAK_PASSWORD', 'Password too weak.', e);
      throw makeError('SIGNUP_FAILED', e.message, e);
    }
    const user = cred.user;
    try { await user.updateProfile({ displayName: full_name }); } catch (_) {}
    try { await user.sendEmailVerification({ url: window.location.origin + '/login.html' }); } catch (_) {}

    const orgId = newId();
    const now = new Date().toISOString();
    await db.collection('organizations').doc(orgId).set({
      id: orgId, name: ministry_name, created_by: user.uid, created_at: now
    });
    await db.collection('profiles').doc(user.uid).set({
      id: user.uid, email, full_name, role: 'ministry_admin',
      org_id: orgId, status: 'pending', created_at: now
    });
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let code = '';
    for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
    try { await db.collection('organizations').doc(orgId).update({ join_code: code, join_code_rotated_at: now }); } catch (_) {}
    return cred;
  }

  async function sendPasswordReset(email) {
    try { await fbAuth.sendPasswordResetEmail(email, { url: window.location.origin + '/reset-password.html' }); }
    catch (e) {
      if (e.code === 'auth/user-not-found') return;
      throw makeError('RESET_FAILED', e.message, e);
    }
  }
  async function updatePassword(newPassword) {
    if (!fbAuth.currentUser) throw makeError('NOT_AUTHENTICATED', 'Not signed in.');
    try { await fbAuth.currentUser.updatePassword(newPassword); }
    catch (e) { throw makeError('PASSWORD_UPDATE_FAILED', e.message, e); }
  }
  async function verifyResetCode(oobCode) {
    try { return await fbAuth.verifyPasswordResetCode(oobCode); }
    catch (e) {
      if (e.code === 'auth/expired-action-code') throw makeError('RESET_CODE_EXPIRED', 'Expired.');
      throw makeError('RESET_CODE_INVALID', e.message, e);
    }
  }
  async function confirmReset(oobCode, newPassword) {
    try { await fbAuth.confirmPasswordReset(oobCode, newPassword); }
    catch (e) {
      if (e.code === 'auth/weak-password')        throw makeError('WEAK_PASSWORD', 'Too weak.');
      if (e.code === 'auth/expired-action-code')  throw makeError('RESET_CODE_EXPIRED', 'Expired.');
      throw makeError('PASSWORD_UPDATE_FAILED', e.message, e);
    }
  }

  async function restoreSession({ requireAuth = false, redirectIfAuthed = false } = {}) {
    await _waitAuth();
    const user = fbAuth.currentUser;
    if (!user) {
      if (requireAuth) window.location.replace('/login.html');
      return null;
    }
    let profile;
    try { profile = await fetchProfile(user.uid); }
    catch (e) { await fbAuth.signOut(); if (requireAuth) window.location.replace('/login.html'); return null; }
    if (!profile || ['suspended', 'disabled'].includes(profile.status)) {
      await fbAuth.signOut();
      if (requireAuth) window.location.replace('/login.html');
      return null;
    }
    CURRENT_PROFILE = profile;
    try { CURRENT_ORG = await fetchOrg(profile.org_id); } catch (_) { CURRENT_ORG = null; }
    if (redirectIfAuthed) { window.location.replace('/app.html'); return null; }
    return { user, profile, org: CURRENT_ORG };
  }

  async function getSession() {
    await _waitAuth();
    const u = fbAuth.currentUser;
    if (!u) return null;
    const profile = await fetchProfile(u.uid).catch(() => null);
    return { user: { id: u.uid, email: u.email }, profile };
  }
  async function getCurrentUser() {
    await _waitAuth();
    return fbAuth.currentUser ? { id: fbAuth.currentUser.uid, email: fbAuth.currentUser.email } : null;
  }

  async function writeAudit(action, target_type, target_id, meta) {
    if (!CURRENT_PROFILE) return;
    try {
      await db.collection('audit_logs').add({
        org_id: CURRENT_PROFILE.org_id,
        actor_id: CURRENT_PROFILE.id,
        actor_name: CURRENT_PROFILE.full_name || CURRENT_PROFILE.email,
        action, target_type, target_id: target_id || null, meta: meta || {},
        created_at: new Date().toISOString()
      });
    } catch (e) { console.warn('[auth] writeAudit failed', e.message); }
  }

  async function uploadMedia(file, folder = 'misc') {
    if (!CURRENT_PROFILE) throw makeError('NOT_AUTHENTICATED', 'No profile.');
    const ext = (file.name || 'file').split('.').pop();
    const path = `media/${CURRENT_PROFILE.org_id}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const r = storage.ref(path);
    await r.put(file, { cacheControl: 'public,max-age=3600' });
    return await r.getDownloadURL();
  }

  /* ─────────── Role sections & labels (preserved) ─────────── */
  const ROLE_SECTIONS = {
    super_admin:       ['dashboard','members','pending-members','departments','events','tasks','bible','discipleship','pastoral','finance','approvals','projects','assets','committees','announcements','media','messages','reports','audit-logs','settings'],
    ministry_admin:    ['dashboard','members','pending-members','departments','events','tasks','bible','discipleship','pastoral','finance','approvals','projects','assets','committees','announcements','media','messages','reports','audit-logs','settings'],
    pastor:            ['dashboard','members','pending-members','departments','events','tasks','bible','discipleship','pastoral','approvals','projects','committees','announcements','messages','reports','settings'],
    ministry_leader:   ['dashboard','members','pending-members','departments','events','tasks','bible','discipleship','projects','assets','committees','announcements','media','messages','reports','settings'],
    department_leader: ['dashboard','members','events','tasks','bible','discipleship','projects','assets','announcements','messages','reports','settings'],
    finance_officer:   ['dashboard','events','finance','approvals','projects','tasks','reports','settings'],
    discipleship_leader:['dashboard','members','pending-members','bible','discipleship','pastoral','events','tasks','messages','reports','settings'],
    media_officer:     ['dashboard','events','announcements','media','tasks','assets','messages','settings'],
    committee_member:  ['dashboard','committees','announcements','messages','reports','settings'],
    volunteer:         ['dashboard','events','tasks','announcements','messages','settings'],
    member:            ['dashboard','discipleship','messages','settings']
  };

  const SECTION_LABELS = {
    dashboard:{en:'Dashboard',rw:'Imbonerahamwe',icon:'dashboard'},
    members:{en:'Members',rw:'Abanyamuryango',icon:'group'},
    'pending-members':{en:'Pending Members',rw:'Abategereje',icon:'how_to_reg'},
    departments:{en:'Departments',rw:'Amashami',icon:'account_tree'},
    events:{en:'Events',rw:'Ibirori',icon:'event'},
    tasks:{en:'Tasks',rw:'Imirimo',icon:'checklist'},
    bible:{en:'Bible Studies',rw:'Kwiga Bibiliya',icon:'menu_book'},
    discipleship:{en:'Discipleship',rw:'Ukuyoboka',icon:'diversity_3'},
    pastoral:{en:'Pastoral Care',rw:'Ubwuzuzanye',icon:'volunteer_activism'},
    finance:{en:'Finance',rw:'Imari',icon:'payments'},
    approvals:{en:'Approvals',rw:'Ibyemejwe',icon:'inbox'},
    projects:{en:'Projects',rw:'Imishinga',icon:'rocket_launch'},
    assets:{en:'Assets',rw:'Ibikoresho',icon:'inventory_2'},
    committees:{en:'Committees',rw:'Komite',icon:'groups'},
    announcements:{en:'Announcements',rw:'Amatangazo',icon:'campaign'},
    media:{en:'Media & Social',rw:'Itangazamakuru',icon:'photo_camera'},
    messages:{en:'Messages',rw:'Ubutumwa',icon:'forum'},
    reports:{en:'Reports',rw:'Raporo',icon:'assessment'},
    'audit-logs':{en:'Audit Logs',rw:'Ibyakozwe',icon:'history'},
    settings:{en:'Settings',rw:'Igenamiterere',icon:'settings'}
  };
  function canAccess(role, section) { return (ROLE_SECTIONS[role] || []).includes(section); }

  /* ─────────── Exports ─────────── */
  window.YT = {
    sb,
    signIn, signInWithGoogle, signInWithApple, hasActiveSession, signOut,
    signUpMinistryAdmin, sendPasswordReset, updatePassword,
    verifyResetCode, confirmReset,
    restoreSession, fetchProfile, fetchOrg, getSession, getCurrentUser,
    canAccess, ROLE_SECTIONS, SECTION_LABELS,
    writeAudit, uploadMedia,
    get profile() { return CURRENT_PROFILE; },
    get org()     { return CURRENT_ORG; },
    firebase: { auth: fbAuth, db, storage }
  };

  console.log('[auth] Firebase adapter ready');
})();
