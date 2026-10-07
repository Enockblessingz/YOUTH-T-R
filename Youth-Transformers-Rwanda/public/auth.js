/* ============================================================
   Youth Transformers — auth.js (Firebase Edition)
   Single source of truth for authentication, profiles, and DB.
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, 
  signOut as fbSignOut, onAuthStateChanged, sendPasswordResetEmail, 
  updatePassword as fbUpdatePassword, sendEmailVerification,
  applyActionCode, verifyPasswordResetCode, confirmPasswordReset
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { 
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, collection, 
  query, where, getDocs, onSnapshot 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { 
  getStorage, ref, uploadBytes, getDownloadURL 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyA8qaMX8AUH4X9xfWz8BimpS-TluIit5bM",
  authDomain: "youth-transformers-rwanda.firebaseapp.com",
  projectId: "youth-transformers-rwanda",
  storageBucket: "youth-transformers-rwanda.firebasestorage.app",
  messagingSenderId: "522013775817",
  appId: "1:522013775817:web:249045a0a77ae10d6bfa18",
  measurementId: "G-B7WMK9XMGK"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

let CURRENT_PROFILE = null;
let CURRENT_ORG = null;

/* ═══════════ ERROR HELPERS ═══════════ */
function makeError(code, detail, cause) {
  const e = new Error(code);
  e.code = code;
  e.detail = detail || code;
  if (cause) e.cause = cause;
  console.error('[auth:' + code + ']', detail || code, cause || '');
  return e;
}

/* ═══════════ PROFILE & ORG FETCH ═══════════ */
async function fetchProfile(userId) {
  try {
    const docSnap = await getDoc(doc(db, 'profiles', userId));
    if (docSnap.exists()) return { id: docSnap.id, ...docSnap.data() };
    return null;
  } catch (error) {
    throw makeError('PROFILE_FETCH_FAILED', error.message, error);
  }
}

async function fetchOrg(orgId) {
  if (!orgId) return null;
  try {
    const docSnap = await getDoc(doc(db, 'organizations', orgId));
    return docSnap.exists() ? { id: docSnap.id, ...docSnap.data() } : null;
  } catch (error) {
    throw makeError('ORG_FETCH_FAILED', error.message, error);
  }
}

/* ═══════════ SIGN IN ═══════════ */
async function signIn(email, password) {
  if (!email || !password) throw makeError('MISSING_CREDENTIALS', 'Email and password are required.');
  
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    
    if (!user.emailVerified) {
      // Allow login but warn, or block depending on your preference.
      console.warn('[auth] Email not verified for', email);
    }

    const profile = await fetchProfile(user.uid);
    if (!profile) {
      await fbSignOut(auth);
      throw makeError('PROFILE_NOT_FOUND', 'No profile found for user.');
    }
    if (profile.status === 'suspended' || profile.status === 'disabled') {
      await fbSignOut(auth);
      throw makeError('ACCOUNT_SUSPENDED', 'Account status: ' + profile.status);
    }

    CURRENT_PROFILE = profile;
    CURRENT_ORG = await fetchOrg(profile.org_id);
    return { user, profile, org: CURRENT_ORG };
  } catch (error) {
    if (error.code && error.code.startsWith('auth/')) {
      if (error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found') {
        throw makeError('INVALID_CREDENTIALS', 'Invalid email or password.');
      }
      throw makeError('AUTH_ERROR', error.message, error);
    }
    throw error;
  }
}

/* ═══════════ SIGN UP (Ministry Admin) ═══════════ */
async function signUpMinistryAdmin({ full_name, ministry_name, email, password }) {
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    // 1. Send Firebase Email Verification Link
    await sendEmailVerification(user, {
      url: window.location.origin + '/login.html'
    });

    // 2. Create the User Profile Document in Firestore
    const orgRef = doc(collection(db, 'organizations'));
    const profileData = {
      id: user.uid,
      email: email,
      full_name: full_name,
      role: 'ministry_admin',
      org_id: orgRef.id,
      status: 'pending',
      created_at: new Date().toISOString()
    };
    
    await setDoc(doc(db, 'profiles', user.uid), profileData);
    
    // 3. Create the Organization Document
    await setDoc(orgRef, {
      id: orgRef.id,
      name: ministry_name,
      created_at: new Date().toISOString(),
      created_by: user.uid
    });

    return userCredential;
  } catch (error) {
    if (error.code === 'auth/email-already-in-use') {
      throw makeError('EMAIL_ALREADY_REGISTERED', 'This email is already registered.');
    }
    throw makeError('SIGNUP_FAILED', error.message, error);
  }
}

/* ═══════════ PASSWORD RESET ═══════════ */
async function sendPasswordReset(email) {
  try {
    await sendPasswordResetEmail(auth, email, {
      url: window.location.origin + '/login.html'
    });
  } catch (error) {
    throw makeError('RESET_FAILED', error.message, error);
  }
}

async function updatePassword(newPassword) {
  if (!auth.currentUser) throw makeError('NOT_AUTHENTICATED', 'No user logged in.');
  try {
    await fbUpdatePassword(auth.currentUser, newPassword);
  } catch (error) {
    throw makeError('PASSWORD_UPDATE_FAILED', error.message, error);
  }
}

/* ═══════════ SIGN OUT ═══════════ */
async function signOut() {
  CURRENT_PROFILE = null;
  CURRENT_ORG = null;
  await fbSignOut(auth);
  window.location.replace('/login.html');
}

/* ═══════════ SESSION RESTORE ═══════════ */
async function restoreSession({ requireAuth = false, redirectIfAuthed = false } = {}) {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      unsubscribe(); // Only run once
      
      if (!user) {
        if (requireAuth) window.location.replace('/login.html');
        return resolve(null);
      }

      try {
        const profile = await fetchProfile(user.uid);
        if (!profile || profile.status === 'suspended' || profile.status === 'disabled') {
          await fbSignOut(auth);
          if (requireAuth) window.location.replace('/login.html');
          return resolve(null);
        }

        CURRENT_PROFILE = profile;
        CURRENT_ORG = await fetchOrg(profile.org_id);

        if (redirectIfAuthed) {
          window.location.replace('/app.html');
          return resolve(null);
        }

        resolve({ user, profile, org: CURRENT_ORG });
      } catch (err) {
        console.error('[auth] restoreSession error:', err);
        await fbSignOut(auth);
        if (requireAuth) window.location.replace('/login.html');
        resolve(null);
      }
    });
  });
}

/* ═══════════ AUDIT LOG ═══════════ */
async function writeAudit(action, target_type, target_id, meta = {}) {
  if (!CURRENT_PROFILE) return;
  try {
    await addDoc(collection(db, 'audit_logs'), {
      org_id: CURRENT_PROFILE.org_id,
      actor_id: CURRENT_PROFILE.id,
      actor_name: CURRENT_PROFILE.full_name,
      action,
      target_type,
      target_id: target_id ? String(target_id) : null,
      meta,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.warn('[auth] writeAudit failed (non-fatal):', err.message);
  }
}

/* ═══════════ STORAGE (MEDIA UPLOAD) ═══════════ */
async function uploadMedia(file, folder = 'misc') {
  if (!CURRENT_PROFILE) throw makeError('NOT_AUTHENTICATED', 'No current profile.');
  const ext = file.name.split('.').pop();
  const path = `media/${CURRENT_PROFILE.org_id}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  
  try {
    const storageRef = ref(storage, path);
    await uploadBytes(storageRef, file, { cacheControl: '3600' });
    return await getDownloadURL(storageRef);
  } catch (error) {
    throw makeError('UPLOAD_FAILED', error.message, error);
  }
}

/* ═══════════ REALTIME HELPERS ═══════════ */
function subscribeTable(table, orgId, onChange) {
  const q = query(collection(db, table), where('org_id', '==', orgId));
  return onSnapshot(q, (snapshot) => {
    const changes = snapshot.docChanges().map(change => ({
      eventType: change.type, // 'added', 'modified', 'removed'
      new: change.doc.data(),
      old: null
    }));
    onChange(changes);
  }, (error) => {
    console.error(`[auth] Realtime subscription error on ${table}:`, error);
  });
}

/* ═══════════ MEMBER HELPERS ═══════════ */
async function getMyMemberRecord() {
  if (!CURRENT_PROFILE) return null;
  try {
    const q = query(collection(db, 'members'), where('profile_id', '==', CURRENT_PROFILE.id));
    const querySnapshot = await getDocs(q);
    if (!querySnapshot.empty) return querySnapshot.docs[0].data();
    
    // Fallback to email lookup
    if (CURRENT_PROFILE.email) {
      const q2 = query(collection(db, 'members'), where('org_id', '==', CURRENT_PROFILE.org_id), where('email', '==', CURRENT_PROFILE.email));
      const snap2 = await getDocs(q2);
      if (!snap2.empty) return snap2.docs[0].data();
    }
    return null;
  } catch (error) {
    console.warn('[auth] getMyMemberRecord failed:', error);
    return null;
  }
}

async function isPendingApproval() {
  const m = await getMyMemberRecord();
  return !!(m && m.approval_status === 'Pending');
}

/* ═══════════ ROLE SECTIONS & LABELS (Preserved) ═══════════ */
const ROLE_SECTIONS = {
  super_admin: ['dashboard','members','pending-members','departments','events','tasks','bible','discipleship','pastoral','finance','approvals','projects','assets','committees','announcements','media','messages','reports','audit-logs','settings'],
  ministry_admin: ['dashboard','members','pending-members','departments','events','tasks','bible','discipleship','pastoral','finance','approvals','projects','assets','committees','announcements','media','messages','reports','audit-logs','settings'],
  pastor: ['dashboard','members','pending-members','departments','events','tasks','bible','discipleship','pastoral','approvals','projects','committees','announcements','messages','reports','settings'],
  ministry_leader: ['dashboard','members','pending-members','departments','events','tasks','bible','discipleship','projects','assets','committees','announcements','media','messages','reports','settings'],
  department_leader: ['dashboard','members','events','tasks','bible','discipleship','projects','assets','announcements','messages','reports','settings'],
  finance_officer: ['dashboard','events','finance','approvals','projects','tasks','reports','settings'],
  discipleship_leader: ['dashboard','members','pending-members','bible','discipleship','pastoral','events','tasks','messages','reports','settings'],
  media_officer: ['dashboard','events','announcements','media','tasks','assets','messages','settings'],
  committee_member: ['dashboard','committees','announcements','messages','reports','settings'],
  volunteer: ['dashboard','events','tasks','announcements','messages','settings'],
  member: ['dashboard','discipleship','messages','settings']
};

const SECTION_LABELS = {
  dashboard: { en: 'Dashboard', rw: 'Imbonerahamwe', icon: 'dashboard' },
  members: { en: 'Members', rw: 'Abanyamuryango', icon: 'group' },
  'pending-members': { en: 'Pending Members', rw: 'Abategereje', icon: 'how_to_reg' },
  departments: { en: 'Departments', rw: 'Amashami', icon: 'account_tree' },
  events: { en: 'Events', rw: 'Ibirori', icon: 'event' },
  tasks: { en: 'Tasks', rw: 'Imirimo', icon: 'checklist' },
  bible: { en: 'Bible Studies', rw: 'Kwiga Bibiliya', icon: 'menu_book' },
  discipleship: { en: 'Discipleship', rw: 'Ukuyoboka', icon: 'diversity_3' },
  pastoral: { en: 'Pastoral Care', rw: 'Ubwuzuzanye', icon: 'volunteer_activism' },
  finance: { en: 'Finance', rw: 'Imari', icon: 'payments' },
  approvals: { en: 'Approvals', rw: 'Ibyemejwe', icon: 'inbox' },
  projects: { en: 'Projects', rw: 'Imishinga', icon: 'rocket_launch' },
  assets: { en: 'Assets', rw: 'Ibikoresho', icon: 'inventory_2' },
  committees: { en: 'Committees', rw: 'Komite', icon: 'groups' },
  announcements: { en: 'Announcements', rw: 'Amatangazo', icon: 'campaign' },
  media: { en: 'Media & Social', rw: 'Itangazamakuru', icon: 'photo_camera' },
  messages: { en: 'Messages', rw: 'Ubutumwa', icon: 'forum' },
  reports: { en: 'Reports', rw: 'Raporo', icon: 'assessment' },
  'audit-logs': { en: 'Audit Logs', rw: 'Ibyakozwe', icon: 'history' },
  settings: { en: 'Settings', rw: 'Igenamiterere', icon: 'settings' }
};

function canAccess(role, section) {
  if (!role) return false;
  return (ROLE_SECTIONS[role] || []).includes(section);
}

/* ═══════════ EXPORTS ═══════════ */
window.YT = {
  auth, db, storage,
  signIn, signUpMinistryAdmin, signOut,
  restoreSession, fetchProfile, fetchOrg,
  sendPasswordReset, updatePassword,
  canAccess, ROLE_SECTIONS, SECTION_LABELS,
  writeAudit, uploadMedia, subscribeTable,
  getMyMemberRecord, isPendingApproval,
  get profile() { return CURRENT_PROFILE; },
  get org() { return CURRENT_ORG; }
};
