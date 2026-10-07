/* ============================================================
   Youth Transformers — auth.js
   Supabase client, session management, profile fetch, signOut,
   restoreSession. Single source of truth for authentication.

   ERROR CONTRACT
   --------------
   Every error thrown by this module has:
     err.code    — a stable machine-readable code
     err.message — the same string as err.code (back-compat with
                   existing `code === 'ACCOUNT_SUSPENDED'` checks)
     err.detail  — a human-readable explanation
     err.cause   — the original error, when one exists

   Recognized codes:
     INVALID_CREDENTIALS, EMAIL_NOT_CONFIRMED, EMAIL_ALREADY_REGISTERED,
     SIGNUPS_DISABLED, EMAIL_LOGIN_DISABLED, INVALID_API_KEY, RATE_LIMITED,
     OTP_INVALID, NETWORK_ERROR,
     PROFILE_NOT_FOUND, PROFILE_FETCH_FAILED, PROFILE_MULTIPLE,
     ACCOUNT_SUSPENDED, ACCOUNT_PENDING,
     RLS_DENIED, SCHEMA_MISSING_TABLE, SCHEMA_MISSING_COLUMN,
     ORG_FETCH_FAILED, SERVER_ERROR,
     NOT_AUTHENTICATED, EMAIL_REQUIRED, MISSING_CREDENTIALS,
     AUTH_SDK_UNAVAILABLE, UNKNOWN
   ============================================================ */

(function () {
  'use strict';

  const SUPABASE_URL      = window.__YT_SUPABASE_URL__      || 'https://YOUR-PROJECT.supabase.co';
  const SUPABASE_ANON_KEY = window.__YT_SUPABASE_ANON_KEY__ || 'YOUR-ANON-KEY';

  /* ═══════════ ERROR HELPERS (defined before use) ═══════════ */
  function makeError(code, detail, cause) {
    const e = new Error(code);           // .message === code (back-compat)
    e.code   = code;
    e.detail = detail || code;
    if (cause) e.cause = cause;
    try { window.__YT_LAST_ERROR__ = e; } catch (_) {}
    // Always log the underlying detail so the console shows the real cause.
    console.error('[auth:' + code + ']', detail || code, cause || '');
    return e;
  }

  /* Translate a raw Supabase / PostgREST / fetch error into a stable code. */
  function translate(err, fallbackCode) {
    if (!err) return makeError(fallbackCode || 'UNKNOWN', 'Unknown error');
    const msg    = String(err.message || err.error_description || err || '');
    const code   = String(err.code || err.error || '');
    const status = err.status || err.statusCode || 0;

    /* --- Supabase Auth (GoTrue) --- */
    if (/Invalid login credentials/i.test(msg))          return makeError('INVALID_CREDENTIALS', msg, err);
    if (/Email not confirmed/i.test(msg))                return makeError('EMAIL_NOT_CONFIRMED', msg, err);
    if (/User already registered/i.test(msg))            return makeError('EMAIL_ALREADY_REGISTERED', msg, err);
    if (/Signups? not allowed/i.test(msg))               return makeError('SIGNUPS_DISABLED', msg, err);
    if (/Email logins are disabled/i.test(msg))          return makeError('EMAIL_LOGIN_DISABLED', msg, err);
    if (/Invalid API key|No API key|apikey/i.test(msg))  return makeError('INVALID_API_KEY', msg, err);
    if (/rate limit|too many requests/i.test(msg))       return makeError('RATE_LIMITED', msg, err);
    if (/token has expired|invalid.*token|otp.*expired/i.test(msg))
      return makeError('OTP_INVALID', msg, err);
    if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg))
      return makeError('NETWORK_ERROR', msg, err);

    /* --- PostgREST / Postgres --- */
    if (code === 'PGRST116' || /multiple \(or more\) rows/i.test(msg))
      return makeError('PROFILE_MULTIPLE', msg, err);
    if (code === 'PGRST205' || /Could not find the table/i.test(msg))
      return makeError('SCHEMA_MISSING_TABLE', msg, err);
    if (code === 'PGRST204' || /Could not find the ['"]?[\w]+['"]? column/i.test(msg))
      return makeError('SCHEMA_MISSING_COLUMN', msg, err);
    if (code === '42501' || /permission denied|row-level security|RLS/i.test(msg))
      return makeError('RLS_DENIED', msg, err);
    if (code === '42P01' || /relation ['"]?[\w]+['"]? does not exist/i.test(msg))
      return makeError('SCHEMA_MISSING_TABLE', msg, err);
    if (code === '42703' || /column ['"]?[\w]+['"]? does not exist/i.test(msg))
      return makeError('SCHEMA_MISSING_COLUMN', msg, err);

    /* --- HTTP status fallbacks --- */
    if (status === 401) return makeError('INVALID_CREDENTIALS', msg, err);
    if (status === 403) return makeError('RLS_DENIED', msg, err);
    if (status === 429) return makeError('RATE_LIMITED', msg, err);
    if (status >= 500)  return makeError('SERVER_ERROR', msg, err);

    return makeError(fallbackCode || 'UNKNOWN', msg, err);
  }

  /* ═══════════ GUARD: Supabase SDK loaded? ═══════════ */
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error('[auth] Supabase SDK is not loaded. Ensure the CDN <script> appears BEFORE auth.js.');
    const fail = function () {
      throw makeError('AUTH_SDK_UNAVAILABLE', 'Supabase SDK failed to load.');
    };
    // Expose a stub YT so pages degrade gracefully (instead of ReferenceError).
    window.YT = {
      sb: null,
      signIn: fail, signUpMinistryAdmin: fail, verifySignupOtp: fail,
      resendSignupOtp: fail, sendPasswordReset: fail, updatePassword: fail,
      signOut: fail, restoreSession: fail, fetchProfile: fail, fetchOrg: fail,
      getSession: async () => null, getCurrentUser: async () => null,
      canAccess: () => false,
      ROLE_SECTIONS: {}, SECTION_LABELS: {},
      writeAudit: fail, uploadMedia: fail, subscribeTable: fail, inviteUser: fail,
      getMyMemberRecord: async () => null, isPendingApproval: async () => false,
      getLastError: () => window.__YT_LAST_ERROR__ || null,
      profile: null, org: null
    };
    return;
  }

  /* ═══════════ SUPABASE CLIENT ═══════════ */
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'yt-auth-token'
    },
    realtime: { params: { eventsPerSecond: 5 } }
  });

  let CURRENT_PROFILE = null;
  let CURRENT_ORG     = null;

  /* ═══════════ PROFILE & ORG ═══════════ */
  const PROFILE_FULL_SELECT = 'id, email, full_name, phone, role, org_id, status, preferences, created_at';
  const PROFILE_MIN_SELECT  = 'id, email, full_name, role, org_id, status, created_at';

  async function fetchProfile(userId) {
    let { data, error } = await sb
      .from('profiles')
      .select(PROFILE_FULL_SELECT)
      .eq('id', userId)
      .maybeSingle();

    // Schema drift resilience: if a column is missing, retry with the minimal set.
    if (error && (error.code === '42703' || error.code === 'PGRST204' ||
                  /column .* does not exist/i.test(error.message || ''))) {
      console.warn('[auth] profiles: full select failed (' + error.message + '). Retrying with minimal columns.');
      ({ data, error } = await sb
        .from('profiles')
        .select(PROFILE_MIN_SELECT)
        .eq('id', userId)
        .maybeSingle());
    }

    if (error) throw translate(error, 'PROFILE_FETCH_FAILED');
    return data;
  }

  async function fetchOrg(orgId) {
    if (!orgId) return null;
    const { data, error } = await sb
      .from('organizations')
      .select('id, name, created_at')
      .eq('id', orgId)
      .maybeSingle();
    if (error) throw translate(error, 'ORG_FETCH_FAILED');
    return data;
  }

  /* ═══════════ SESSION ═══════════ */
  async function getSession() {
    const { data: { session } } = await sb.auth.getSession();
    return session;
  }

  async function getCurrentUser() {
    const { data: { user } } = await sb.auth.getUser();
    return user;
  }

  async function safeSignOut() {
    try { await sb.auth.signOut(); } catch (_) { /* never let signOut mask the real error */ }
  }

  /* ═══════════ SIGN IN ═══════════ */
  async function signIn(email, password) {
    if (!email || !password) {
      throw makeError('MISSING_CREDENTIALS', 'Email and password are required.');
    }

    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw translate(error, 'INVALID_CREDENTIALS');
    if (!data || !data.user) throw makeError('INVALID_CREDENTIALS', 'No user returned from auth.');

    let profile;
    try {
      profile = await fetchProfile(data.user.id);
    } catch (err) {
      await safeSignOut();
      // fetchProfile already translated; re-throw as-is.
      throw err.code ? err : translate(err, 'PROFILE_FETCH_FAILED');
    }

    if (!profile) {
      await safeSignOut();
      throw makeError('PROFILE_NOT_FOUND', 'No profile row for user ' + data.user.id);
    }
    if (profile.status === 'suspended' || profile.status === 'disabled') {
      await safeSignOut();
      throw makeError('ACCOUNT_SUSPENDED', 'Account status: ' + profile.status);
    }

    /* Pending members can sign in — the app shows an "Awaiting approval" gate. */

    CURRENT_PROFILE = profile;

    // Org fetch is non-fatal: a broken org row shouldn't block login.
    try {
      CURRENT_ORG = await fetchOrg(profile.org_id);
    } catch (err) {
      console.warn('[auth] signIn: org fetch failed, continuing without org.', err.detail || err.message);
      CURRENT_ORG = null;
    }

    return { user: data.user, profile, org: CURRENT_ORG };
  }

  /* ═══════════ SIGN UP (Ministry Admin) ═══════════ */
  async function signUpMinistryAdmin({ full_name, ministry_name, email, password }) {
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: {
        data: { full_name, ministry_name, signup_intent: 'ministry_admin' },
        emailRedirectTo: window.location.origin + '/login.html'
      }
    });
    if (error) throw translate(error, 'SIGNUP_FAILED');
    return data;
  }

  async function verifySignupOtp(email, token) {
    const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'signup' });
    if (error) throw translate(error, 'OTP_INVALID');
    return data;
  }

  async function resendSignupOtp(email) {
    const { error } = await sb.auth.resend({ type: 'signup', email });
    if (error) throw translate(error, 'RESEND_FAILED');
  }

  /* ═══════════ PASSWORD RESET ═══════════ */
  async function sendPasswordReset(email) {
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/reset-password.html'
    });
    if (error) throw translate(error, 'RESET_FAILED');
  }

  async function updatePassword(newPassword) {
    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) throw translate(error, 'PASSWORD_UPDATE_FAILED');
  }

  /* ═══════════ SIGN OUT ═══════════ */
  async function signOut() {
    CURRENT_PROFILE = null;
    CURRENT_ORG     = null;
    await safeSignOut();
    window.location.replace('/login.html');
  }

  /* ═══════════ SESSION RESTORE ═══════════ */
  async function restoreSession({ requireAuth = false, redirectIfAuthed = false } = {}) {
    const session = await getSession();

    if (!session) {
      if (requireAuth) window.location.replace('/login.html');
      return null;
    }

    let profile;
    try {
      profile = await fetchProfile(session.user.id);
    } catch (err) {
      console.error('[auth] restoreSession: profile fetch failed.', err.code, err.detail || err.message);
      await safeSignOut();
      if (requireAuth) window.location.replace('/login.html');
      return null;
    }

    if (!profile || profile.status === 'suspended' || profile.status === 'disabled') {
      await safeSignOut();
      if (requireAuth) window.location.replace('/login.html');
      return null;
    }

    CURRENT_PROFILE = profile;
    try {
      CURRENT_ORG = await fetchOrg(profile.org_id);
    } catch (err) {
      console.warn('[auth] restoreSession: org fetch failed, continuing without org.', err.detail || err.message);
      CURRENT_ORG = null;
    }

    if (redirectIfAuthed) {
      window.location.replace('/app.html');
      return null;
    }

    return { session, profile, org: CURRENT_ORG };
  }

  /* ═══════════ ROLE SECTIONS ═══════════ */
  const ROLE_SECTIONS = {
    super_admin: [
      'dashboard','members','pending-members','departments','events','tasks','bible',
      'discipleship','pastoral','finance','approvals','projects','assets','committees',
      'announcements','media','messages','reports','audit-logs','settings'
    ],
    ministry_admin: [
      'dashboard','members','pending-members','departments','events','tasks','bible',
      'discipleship','pastoral','finance','approvals','projects','assets','committees',
      'announcements','media','messages','reports','audit-logs','settings'
    ],
    pastor: [
      'dashboard','members','pending-members','departments','events','tasks','bible',
      'discipleship','pastoral','approvals','projects','committees','announcements',
      'messages','reports','settings'
    ],
    ministry_leader: [
      'dashboard','members','pending-members','departments','events','tasks','bible',
      'discipleship','projects','assets','committees','announcements','media',
      'messages','reports','settings'
    ],
    department_leader: [
      'dashboard','members','events','tasks','bible','discipleship','projects',
      'assets','announcements','messages','reports','settings'
    ],
    finance_officer: [
      'dashboard','events','finance','approvals','projects','tasks','reports','settings'
    ],
    discipleship_leader: [
      'dashboard','members','pending-members','bible','discipleship','pastoral',
      'events','tasks','messages','reports','settings'
    ],
    media_officer: [
      'dashboard','events','announcements','media','tasks','assets','messages','settings'
    ],
    committee_member: [
      'dashboard','committees','announcements','messages','reports','settings'
    ],
    volunteer: [
      'dashboard','events','tasks','announcements','messages','settings'
    ],
    member: [
      'dashboard','discipleship','messages','settings'
    ]
  };

  /* ═══════════ SECTION LABELS ═══════════ */
  const SECTION_LABELS = {
    dashboard:         { en: 'Dashboard',       rw: 'Imbonerahamwe',   icon: 'dashboard' },
    members:           { en: 'Members',         rw: 'Abanyamuryango',  icon: 'group' },
    'pending-members': { en: 'Pending Members', rw: 'Abategereje',     icon: 'how_to_reg' },
    departments:       { en: 'Departments',     rw: 'Amashami',        icon: 'account_tree' },
    events:            { en: 'Events',          rw: 'Ibirori',         icon: 'event' },
    tasks:             { en: 'Tasks',           rw: 'Imirimo',         icon: 'checklist' },
    bible:             { en: 'Bible Studies',   rw: 'Kwiga Bibiliya',  icon: 'menu_book' },
    discipleship:      { en: 'Discipleship',    rw: 'Ukuyoboka',       icon: 'diversity_3' },
    pastoral:          { en: 'Pastoral Care',   rw: 'Ubwuzuzanye',     icon: 'volunteer_activism' },
    finance:           { en: 'Finance',         rw: 'Imari',           icon: 'payments' },
    approvals:         { en: 'Approvals',       rw: 'Ibyemejwe',       icon: 'inbox' },
    projects:          { en: 'Projects',        rw: 'Imishinga',       icon: 'rocket_launch' },
    assets:            { en: 'Assets',          rw: 'Ibikoresho',      icon: 'inventory_2' },
    committees:        { en: 'Committees',      rw: 'Komite',          icon: 'groups' },
    announcements:     { en: 'Announcements',   rw: 'Amatangazo',      icon: 'campaign' },
    media:             { en: 'Media & Social',  rw: 'Itangazamakuru',  icon: 'photo_camera' },
    messages:          { en: 'Messages',        rw: 'Ubutumwa',        icon: 'forum' },
    reports:           { en: 'Reports',         rw: 'Raporo',          icon: 'assessment' },
    'audit-logs':      { en: 'Audit Logs',      rw: 'Ibyakozwe',       icon: 'history' },
    settings:          { en: 'Settings',        rw: 'Igenamiterere',   icon: 'settings' }
  };

  function canAccess(role, section) {
    if (!role) return false;
    return (ROLE_SECTIONS[role] || []).includes(section);
  }

  /* ═══════════ AUDIT LOG ═══════════ */
  async function writeAudit(action, target_type, target_id, meta = {}) {
    if (!CURRENT_PROFILE) return;
    try {
      await sb.from('audit_logs').insert({
        org_id: CURRENT_PROFILE.org_id,
        actor_id: CURRENT_PROFILE.id,
        actor_name: CURRENT_PROFILE.full_name,
        action,
        target_type,
        target_id: target_id ? String(target_id) : null,
        meta
      });
    } catch (err) {
      // Non-fatal, but visible in the console.
      console.warn('[auth] writeAudit failed (non-fatal):', err && err.message);
    }
  }

  /* ═══════════ STORAGE ═══════════ */
  async function uploadMedia(file, folder = 'misc') {
    if (!CURRENT_PROFILE) throw makeError('NOT_AUTHENTICATED', 'No current profile.');
    const ext  = file.name.split('.').pop();
    const path = `${CURRENT_PROFILE.org_id}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await sb.storage.from('media').upload(path, file, { cacheControl: '3600', upsert: false });
    if (error) throw translate(error, 'UPLOAD_FAILED');
    const { data } = sb.storage.from('media').getPublicUrl(path);
    return data.publicUrl;
  }

  /* ═══════════ REALTIME HELPERS ═══════════ */
  function subscribeTable(table, orgId, onChange) {
    return sb.channel(`rt-${table}-${orgId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, filter: `org_id=eq.${orgId}` }, onChange)
      .subscribe();
  }

  /* ═══════════ INVITATIONS ═══════════ */
  async function inviteUser({ email, full_name, role = 'member', message, member_id }) {
    if (!CURRENT_PROFILE) throw makeError('NOT_AUTHENTICATED', 'No current profile.');
    if (!email)           throw makeError('EMAIL_REQUIRED', 'Email is required.');

    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const rawToken = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const hashBuf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
    const tokenHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: invRow, error: invErr } = await sb
      .from('manager_invitations')
      .insert({
        organization_id: CURRENT_PROFILE.org_id,
        invited_by: CURRENT_PROFILE.id,
        invited_by_name: CURRENT_PROFILE.full_name || CURRENT_PROFILE.email,
        email: String(email).trim().toLowerCase(),
        full_name: full_name || null,
        role,
        message: message || null,
        token_hash: tokenHash,
        status: 'pending',
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();
    if (invErr) throw translate(invErr, 'INVITE_FAILED');

    const acceptUrl = `${window.location.origin}/accept-invite.html?token=${rawToken}&inv=${invRow.id}`;

    try {
      await writeAudit('invite_user', 'invitation', invRow.id, { email, role, member_id });
    } catch (_) { /* non-fatal */ }

    return { invitation: invRow, acceptUrl };
  }

  /* ═══════════ MEMBER HELPERS ═══════════ */
  async function getMyMemberRecord() {
    if (!CURRENT_PROFILE) return null;

    const { data: byProfile, error: e1 } = await sb
      .from('members')
      .select('*')
      .eq('profile_id', CURRENT_PROFILE.id)
      .maybeSingle();
    if (e1) console.warn('[auth] getMyMemberRecord (by profile_id):', e1.message);
    if (byProfile) return byProfile;

    if (CURRENT_PROFILE.email) {
      const { data: byEmail, error: e2 } = await sb
        .from('members')
        .select('*')
        .eq('org_id', CURRENT_PROFILE.org_id)
        .eq('email', CURRENT_PROFILE.email)
        .maybeSingle();
      if (e2) console.warn('[auth] getMyMemberRecord (by email):', e2.message);
      return byEmail || null;
    }
    return null;
  }

  async function isPendingApproval() {
    const m = await getMyMemberRecord();
    return !!(m && m.approval_status === 'Pending');
  }

  /* ═══════════ EXPORTS ═══════════ */
  window.YT = {
    sb,

    /* auth */
    signIn, signUpMinistryAdmin, verifySignupOtp, resendSignupOtp,
    sendPasswordReset, updatePassword, signOut,
    restoreSession, fetchProfile, fetchOrg, getSession, getCurrentUser,

    /* permissions */
    canAccess,
    ROLE_SECTIONS, SECTION_LABELS,

    /* audit */
    writeAudit,

    /* storage */
    uploadMedia,

    /* realtime */
    subscribeTable,

    /* invitations */
    inviteUser,

    /* member helpers */
    getMyMemberRecord, isPendingApproval,

    /* debug */
    getLastError() { return window.__YT_LAST_ERROR__ || null; },

    /* shortcuts */
    get profile() { return CURRENT_PROFILE; },
    get org()     { return CURRENT_ORG; }
  };
})();
