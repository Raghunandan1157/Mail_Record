// ============================================================
// Stationary Management App - StockRegister
// localStorage + Supabase integration
// ============================================================

// --- SUPABASE ---

const SUPABASE_URL = 'https://zovnmmdfthpbubrorsgh.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpvdm5tbWRmdGhwYnVicm9yc2doIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE1NzE3ODgsImV4cCI6MjA3NzE0Nzc4OH0.92BH2sjUOgkw6iSRj1_4gt0p3eThg3QT4VK-Q4EdmBE';

// FIX #4: WARNING: The anon key is exposed in client-side code. This is by design for Supabase,
// but requires Row Level Security (RLS) to be enabled on ALL tables to prevent unauthorized access.
// TODO: Enable RLS policies on: stock_entries, employees, edit_log, deletion_log,
// received_date_log, received_date_deletion_log, app_config

// Helper: fetch with timeout and retry for slow/flaky mobile networks
const FETCH_TIMEOUT = 15000; // 15 seconds
const MAX_RETRIES = 3;

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out. Please check your internet connection.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url, options);
    } catch (err) {
      if (attempt === retries) throw err;
      // Exponential backoff: 1s, 2s, 4s
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}

// Helper: direct REST fetch from Supabase with automatic pagination
// PostgREST returns max 1000 rows by default; this fetches ALL rows.
async function supabaseFetch(table, params = '') {
  const pageSize = 1000;
  let allRows = [];
  let offset = 0;
  while (true) {
    const res = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + SUPABASE_ANON,
        'Range': `${offset}-${offset + pageSize - 1}`,
        'Prefer': 'count=exact',
      },
    });
    if (!res.ok) throw new Error(`Supabase error: ${res.status} ${res.statusText}`);
    const rows = await res.json();
    allRows = allRows.concat(rows);
    // If we got fewer rows than the page size, we've fetched everything
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return allRows;
}

async function supabaseInsert(table, rows) {
  const res = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON,
      'Authorization': 'Bearer ' + SUPABASE_ANON,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Insert error: ${res.status} ${errText}`);
  }
  return true;
}

async function supabaseUpdate(table, id, data) {
  const res = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_ANON,
      'Authorization': 'Bearer ' + SUPABASE_ANON,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Update error: ${res.status} ${errText}`);
  }
  return true;
}

// --- SESSION ---

let currentEmployee = null;  // { id, emp_id, name, role, mobile, location }
let selectedLocation = null;
let isHeadOffice = false;

// --- LOGIN FLOW ---

async function initLogin() {
  const select = document.getElementById('login-location-select');
  const errorEl = document.getElementById('login-error');

  if (select) select.innerHTML = '<option value="" disabled selected>Loading locations...</option>';

  try {
    // Use direct REST API — no client library dependency
    const data = await supabaseFetch('employees', 'select=location&location=not.is.null');

    const locations = [...new Set(data.map(e => e.location).filter(Boolean))].sort();
    // Always include Head Office as an option
    if (!locations.includes('Head Office')) locations.push('Head Office');
    locations.sort();

    if (!select) return;

    if (locations.length === 0) {
      select.innerHTML = '<option value="" disabled selected>No locations found</option>';
      return;
    }

    select.innerHTML = '<option value="" disabled selected>Choose a location...</option>' +
      locations.map(loc => `<option value="${loc}">${loc}</option>`).join('');
  } catch (err) {
    console.error('Failed to load locations:', err);
    if (select) select.innerHTML = '<option value="" disabled selected>Failed to load</option>';
    if (errorEl) {
      errorEl.textContent = 'Failed to load locations: ' + err.message;
      errorEl.classList.remove('hidden');
    }
  }
}

async function loginSelectLocation() {
  const select = document.getElementById('login-location-select');
  const errorEl = document.getElementById('login-error');
  const location = select ? select.value : '';

  if (!location) {
    errorEl.textContent = 'Please select a location';
    errorEl.classList.remove('hidden');
    return;
  }

  errorEl.classList.add('hidden');
  selectedLocation = location;

  // Head Office / Corporate Office → no BOE, skip profile selection
  if (location === 'Head Office' || location === 'Corporate Office') {
    currentEmployee = location === 'Head Office'
      ? { id: 0, emp_id: 'HO-USER', name: 'Santosh', role: 'Admin Executive', mobile: '', location: location }
      : { id: 0, emp_id: 'CO-USER', name: 'Chetan', role: 'Admin Executive', mobile: '', location: location };

    sessionStorage.setItem('sr_employee', JSON.stringify(currentEmployee));
    sessionStorage.setItem('sr_location', selectedLocation);
    localStorage.setItem('sr_employee', JSON.stringify(currentEmployee));
    localStorage.setItem('sr_location', selectedLocation);
    // FIX #7: Store login timestamp for session expiry
    const loginTime = Date.now().toString();
    sessionStorage.setItem('sr_login_time', loginTime);
    localStorage.setItem('sr_login_time', loginTime);

    appData.profile.branch = selectedLocation;
    appData.profile.boe = 'Navachetana Livelihoods Pvt Ltd';
    saveData(appData);

    document.getElementById('login-screen').classList.add('hidden');
    updateUserUI();
    // FIX #14: Add error handling to async data load
    loadFromSupabase().then(() => {
      saveData(appData);
      renderDashboard();
    }).catch(err => {
      console.error('Failed to load data:', err);
      showToast('Failed to load data from server', 'delete');
    });
    return;
  }

  try {
    // Fetch employees at this location with role = 'BOE' via REST
    const data = await supabaseFetch('employees', `select=*&location=eq.${encodeURIComponent(location)}&role=eq.BOE`);

    if (!data || data.length === 0) {
      // Check if we have a saved name for this location in localStorage
      const savedUserKey = 'temp_boe_user_' + location;
      const savedUser = localStorage.getItem(savedUserKey);
      
      if (savedUser) {
        // Use the saved user
        currentEmployee = JSON.parse(savedUser);
        loginConfirm();
        return;
      } else {
        // Show name input field for new user
        showNameInputForNewUser(location);
        return;
      }
    }

    // Auto-select if only 1 BOE profile
    if (data.length === 1) {
      currentEmployee = data[0];
      loginConfirm();
      return;
    }

    // Render profile cards in step 2
    document.getElementById('login-welcome').textContent = location;
    const container = document.getElementById('login-profiles');
    container.innerHTML = data.map(emp => {
      const initials = emp.name ? emp.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : '?';
      return `
        <button onclick="selectProfile(this, ${emp.id})"
          data-emp='${JSON.stringify(emp).replace(/'/g, "&#39;")}'
          class="profile-option w-full flex items-center gap-4 p-4 rounded-lg border border-slate-200 dark:border-slate-700 text-left hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
          <div class="size-11 rounded-full bg-gradient-to-br from-primary to-blue-400 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">${initials}</div>
          <div class="min-w-0 flex-1">
            <p class="font-semibold text-slate-800 dark:text-white text-sm truncate">${emp.name || 'Unknown'}</p>
            <p class="text-xs text-slate-500 dark:text-slate-400">${emp.emp_id || ''} &middot; ${emp.role || ''}</p>
          </div>
          <span class="material-symbols-outlined text-slate-300 dark:text-slate-600 text-base">chevron_right</span>
        </button>
      `;
    }).join('');

    // Show step 2
    document.getElementById('login-step1').classList.add('hidden');
    document.getElementById('login-step2').classList.remove('hidden');

  } catch (err) {
    errorEl.textContent = 'Connection error: ' + err.message;
    errorEl.classList.remove('hidden');
  }
}

function showNameInputForNewUser(location) {
  const errorEl = document.getElementById('login-error');
  const locationSelect = document.getElementById('login-location-select');
  
  // Clear any previous error
  errorEl.classList.add('hidden');
  
  // Create a container for the name input
  const nameInputContainer = document.createElement('div');
  nameInputContainer.id = 'name-input-container';
  nameInputContainer.className = 'mt-4 p-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg';
  
  nameInputContainer.innerHTML = `
    <h4 class="text-sm font-semibold text-slate-800 dark:text-white mb-2">No BOE profiles found</h4>
    <p class="text-sm text-slate-500 dark:text-slate-400 mb-4">Please enter your name to continue:</p>
    <div class="mb-4">
      <input id="new-user-name" type="text" placeholder="Enter your full name" 
             class="w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent">
    </div>
    <button onclick="saveNewUserName('${location}')" 
            class="w-full flex items-center justify-center gap-2 px-4 py-3 bg-primary text-white rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors">
      <span class="material-symbols-outlined text-base">save</span>
      Continue
    </button>
  `;
  
  // Insert the container after the location select
  locationSelect.parentNode.insertBefore(nameInputContainer, locationSelect.nextSibling);
  
  // Disable the continue button to prevent proceeding without entering a name
  const continueBtn = document.querySelector('button[onclick="loginSelectLocation()"]');
  if (continueBtn) {
    continueBtn.disabled = true;
    continueBtn.classList.add('opacity-50', 'cursor-not-allowed');
  }
}

function saveNewUserName(location) {
  const nameInput = document.getElementById('new-user-name');
  const name = nameInput ? nameInput.value.trim() : '';
  
  if (!name) {
    showToast('Please enter your name', 'delete');
    return;
  }
  
  // Create a temporary employee object
  const tempEmployee = {
    id: 'temp-' + Date.now(),
    name: name,
    role: 'BOE',
    location: location,
    emp_id: 'TEMP-' + Math.floor(Math.random() * 10000)
  };
  
  // Save to localStorage for persistence
  localStorage.setItem('temp_boe_user_' + location, JSON.stringify(tempEmployee));
  
  // Set as current employee and proceed with login
  currentEmployee = tempEmployee;
  selectedLocation = location;
  
  // Remove the name input container
  const nameInputContainer = document.getElementById('name-input-container');
  if (nameInputContainer) {
    nameInputContainer.remove();
  }
  
  // Proceed with login
  loginConfirm();
}

function selectProfile(el, empId) {
  // Highlight selected
  document.querySelectorAll('.profile-option').forEach(btn => {
    btn.classList.remove('border-primary', 'bg-primary/5', 'dark:bg-primary/10');
    btn.classList.add('border-slate-200', 'dark:border-slate-700');
  });
  el.classList.remove('border-slate-200', 'dark:border-slate-700');
  el.classList.add('border-primary', 'bg-primary/5', 'dark:bg-primary/10');
  currentEmployee = JSON.parse(el.dataset.emp.replace(/&#39;/g, "'"));
}

function loginBack() {
  document.getElementById('login-step2').classList.add('hidden');
  document.getElementById('login-step1').classList.remove('hidden');
  currentEmployee = null;
  
  // Remove name input container if it exists
  const nameInputContainer = document.getElementById('name-input-container');
  if (nameInputContainer) {
    nameInputContainer.remove();
  }
  
  // Re-enable the continue button
  const continueBtn = document.querySelector('button[onclick="loginSelectLocation()"]');
  if (continueBtn) {
    continueBtn.disabled = false;
    continueBtn.classList.remove('opacity-50', 'cursor-not-allowed');
  }
}

function loginAdminStart() {
  document.getElementById('login-step1').classList.add('hidden');
  document.getElementById('login-step3').classList.remove('hidden');
  document.getElementById('login-ho-otp').value = '';
  document.getElementById('login-otp-error').classList.add('hidden');
  showToast('Enter admin OTP to continue');
}

function loginBackFromOTP() {
  document.getElementById('login-step3').classList.add('hidden');
  document.getElementById('login-step1').classList.remove('hidden');
}

async function loginHeadOfficeOTP() {
  const otpInput = document.getElementById('login-ho-otp');
  const errorEl = document.getElementById('login-otp-error');
  const otp = otpInput ? otpInput.value.trim() : '';

  if (!otp) {
    errorEl.textContent = 'Please enter OTP';
    errorEl.classList.remove('hidden');
    return;
  }

  // FIX #3: Validate OTP against Supabase instead of hardcoded value
  try {
    const configs = await supabaseFetch('app_config', 'select=value&key=eq.admin_otp');
    const storedOtp = configs && configs[0] && configs[0].value;
    if (!storedOtp || otp !== storedOtp) {
      errorEl.textContent = 'Invalid OTP';
      errorEl.classList.remove('hidden');
      return;
    }
  } catch (err) {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.classList.remove('hidden');
    return;
  }

  errorEl.classList.add('hidden');
  isHeadOffice = true;
  selectedLocation = 'Head Office';
  currentEmployee = { id: 0, emp_id: 'HO-ADMIN', name: 'Santosh', role: 'Admin', mobile: '', location: 'Head Office' };

  // Save session
  sessionStorage.setItem('sr_employee', JSON.stringify(currentEmployee));
  sessionStorage.setItem('sr_location', selectedLocation);
  sessionStorage.setItem('sr_headoffice', 'true');
  localStorage.setItem('sr_employee', JSON.stringify(currentEmployee));
  localStorage.setItem('sr_location', selectedLocation);
  localStorage.setItem('sr_headoffice', 'true');
  // FIX #7: Store login timestamp for session expiry
  const loginTime = Date.now().toString();
  sessionStorage.setItem('sr_login_time', loginTime);
  localStorage.setItem('sr_login_time', loginTime);

  // Hide login, show app
  document.getElementById('login-screen').classList.add('hidden');

  // Switch to admin sidebar
  switchToAdminMode();

  // Update UI
  updateUserUI();

  // Load and render admin dashboard
  loadAdminData().then(() => navigateTo('admin'));
}

function loginConfirm() {
  const locErr = document.getElementById('login-loc-error');

  if (!currentEmployee) {
    locErr.textContent = 'Please select your profile to continue';
    locErr.classList.remove('hidden');
    return;
  }

  locErr.classList.add('hidden');

  // Save session (both session + persistent localStorage)
  sessionStorage.setItem('sr_employee', JSON.stringify(currentEmployee));
  sessionStorage.setItem('sr_location', selectedLocation);
  localStorage.setItem('sr_employee', JSON.stringify(currentEmployee));
  localStorage.setItem('sr_location', selectedLocation);
  // FIX #7: Store login timestamp for session expiry
  const loginTime = Date.now().toString();
  sessionStorage.setItem('sr_login_time', loginTime);
  localStorage.setItem('sr_login_time', loginTime);

  // Update app profile
  appData.profile.branch = selectedLocation;
  appData.profile.boe = 'Navachetana Livelihoods Pvt Ltd';
  saveData(appData);

  // Show loading state on login button
  const loginBtn = document.getElementById('login-confirm-btn');
  loginBtn.innerHTML = '<span class="material-symbols-outlined text-base animate-spin">progress_activity</span> Loading...';
  loginBtn.disabled = true;

  // Hide login, show app
  document.getElementById('login-screen').classList.add('hidden');

  // Update UI
  updateUserUI();

  // Always load fresh data from Supabase after login, then render
  // FIX #14: Add error handling to async data load
  loadFromSupabase().then(() => {
    saveData(appData);
    renderDashboard();
  }).catch(err => {
    console.error('Failed to load data:', err);
    showToast('Failed to load data from server', 'delete');
  });
}

function updateUserUI() {
  if (!currentEmployee) return;
  const initials = currentEmployee.name ? currentEmployee.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : '??';

  document.querySelectorAll('.user-initials').forEach(el => el.textContent = initials);
  document.querySelectorAll('.user-name').forEach(el => el.textContent = currentEmployee.name || 'User');
  document.querySelectorAll('.user-role').forEach(el => el.textContent = currentEmployee.role || 'Staff');
}

function checkSession() {
  // Check sessionStorage first (current tab), then localStorage (persistent across tabs/sessions)
  const savedEmp = sessionStorage.getItem('sr_employee') || localStorage.getItem('sr_employee');
  const savedLoc = sessionStorage.getItem('sr_location') || localStorage.getItem('sr_location');
  const savedHO = sessionStorage.getItem('sr_headoffice') || localStorage.getItem('sr_headoffice');

  // FIX #7: Check session expiry (24hr TTL)
  const loginTime = sessionStorage.getItem('sr_login_time') || localStorage.getItem('sr_login_time');
  const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
  if (loginTime && (Date.now() - parseInt(loginTime, 10)) > SESSION_TTL) {
    logout();
    return false;
  }

  if (savedEmp && savedLoc) {
    currentEmployee = JSON.parse(savedEmp);
    selectedLocation = savedLoc;
    isHeadOffice = savedHO === 'true';
    // Keep both in sync
    sessionStorage.setItem('sr_employee', savedEmp);
    sessionStorage.setItem('sr_location', savedLoc);
    if (isHeadOffice) sessionStorage.setItem('sr_headoffice', 'true');
    // Update app profile branch from session
    appData.profile.branch = savedLoc;
    saveData(appData);
    document.getElementById('login-screen').classList.add('hidden');
    updateUserUI();
    if (isHeadOffice) switchToAdminMode();
    return true;
  }
  return false;
}

function logout() {
  sessionStorage.removeItem('sr_employee');
  sessionStorage.removeItem('sr_location');
  sessionStorage.removeItem('sr_headoffice');
  localStorage.removeItem('sr_employee');
  localStorage.removeItem('sr_location');
  localStorage.removeItem('sr_headoffice');
  // FIX #7: Clear login timestamp
  sessionStorage.removeItem('sr_login_time');
  localStorage.removeItem('sr_login_time');
  currentEmployee = null;
  selectedLocation = null;
  isHeadOffice = false;

  // Reset to regular nav
  switchToRegularMode();

  // Redirect to hub
  sessionStorage.removeItem('mr_session');
  localStorage.removeItem('mr_session');
  window.location.href = 'index.html';
}

// --- ADMIN MODE SWITCHING ---

function switchToAdminMode() {
  document.getElementById('nav-regular').classList.add('hidden');
  document.getElementById('nav-regular').classList.remove('flex-1');
  document.getElementById('nav-admin').classList.remove('hidden');
  document.getElementById('nav-admin').classList.add('flex-1');
  // Hide team section and regular profile for admin
  const teamSection = document.querySelector('#sidebar > .px-4.pb-3');
  if (teamSection) teamSection.classList.add('hidden');
  document.getElementById('new-entry-btn').classList.add('hidden');
}

function switchToRegularMode() {
  document.getElementById('nav-admin').classList.add('hidden');
  document.getElementById('nav-admin').classList.remove('flex-1');
  document.getElementById('nav-regular').classList.remove('hidden');
  document.getElementById('nav-regular').classList.add('flex-1');
  const teamSection = document.querySelector('#sidebar > .px-4.pb-3');
  if (teamSection) teamSection.classList.remove('hidden');
  document.getElementById('new-entry-btn').classList.remove('hidden');
}

// Initialize login on load
document.addEventListener('DOMContentLoaded', () => {
  initLogin();

  // Ripple water effect on btn-bounce buttons
  document.querySelectorAll('.btn-bounce').forEach(btn => {
    btn.addEventListener('click', function(e) {
      const ripple = document.createElement('span');
      ripple.classList.add('ripple');
      const rect = btn.getBoundingClientRect();
      ripple.style.left = (e.clientX - rect.left) + 'px';
      ripple.style.top = (e.clientY - rect.top) + 'px';
      btn.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove());
    });
  });

  // Admin nav link click handlers
  document.querySelectorAll('.nav-link-admin').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigateTo(link.dataset.page);
    });
  });

  // OTP Enter key support
  const otpInput = document.getElementById('login-ho-otp');
  if (otpInput) otpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loginHeadOfficeOTP(); } });
});

// --- DATA LAYER ---

const STORAGE_KEY = 'stockregister_data';
const DATA_VERSION = 7; // Redesigned profile card + company name fix

const DEFAULT_TEAM = []; // Team members now loaded from Supabase

const DEFAULT_INVENTORY = [
  // Writing
  { id: 1, name: 'Ball Pen Blue', sku: '96081099', category: 'Writing', qty: 0, unit: 'No', reorder: 10, rate: 5.08, gst: 18 },
  { id: 2, name: 'Ball Pen Black', sku: '96081099', category: 'Writing', qty: 0, unit: 'No', reorder: 5, rate: 5.08, gst: 18 },
  { id: 3, name: 'Ball Pen Red', sku: '96081099', category: 'Writing', qty: 0, unit: 'No', reorder: 5, rate: 5.08, gst: 18 },
  { id: 4, name: 'Highlighter Pen', sku: '96082000', category: 'Writing', qty: 0, unit: 'No', reorder: 3, rate: 16.95, gst: 18 },
  { id: 5, name: 'Pencil', sku: '96091000', category: 'Writing', qty: 0, unit: 'No', reorder: 5, rate: 4.46, gst: 12 },
  // Paper & Covers
  { id: 6, name: 'Xerox Paper A4', sku: '48025690', category: 'Paper & Covers', qty: 0, unit: 'Ream', reorder: 5, rate: 267.86, gst: 12 },
  { id: 7, name: 'Brown Cover A4 Size', sku: '48203000', category: 'Paper & Covers', qty: 0, unit: 'No', reorder: 15, rate: 4.24, gst: 18 },
  { id: 8, name: 'Clothlined Cover A4', sku: '4817', category: 'Paper & Covers', qty: 0, unit: 'No', reorder: 15, rate: 5.51, gst: 18 },
  { id: 9, name: 'Carbon Paper', sku: '48162010', category: 'Paper & Covers', qty: 0, unit: 'No', reorder: 5, rate: 186.44, gst: 18 },
  // Filing
  { id: 10, name: 'Office File', sku: '48203000', category: 'Filing', qty: 0, unit: 'No', reorder: 10, rate: 18.64, gst: 18 },
  { id: 11, name: 'Lever Arch File', sku: '48203000', category: 'Filing', qty: 0, unit: 'No', reorder: 5, rate: 88.98, gst: 18 },
  { id: 12, name: 'Tag', sku: '48211010', category: 'Filing', qty: 0, unit: 'Bundle', reorder: 3, rate: 182.20, gst: 18 },
  // Books & Registers
  { id: 13, name: 'Register Books 100 Page', sku: '48201010', category: 'Books & Registers', qty: 0, unit: 'No', reorder: 5, rate: 127.12, gst: 18 },
  { id: 14, name: 'Register Books 200 Page', sku: '48201090', category: 'Books & Registers', qty: 0, unit: 'No', reorder: 5, rate: 127.12, gst: 18 },
  { id: 15, name: 'Cash Book', sku: '48201010', category: 'Books & Registers', qty: 0, unit: 'No', reorder: 2, rate: 199.15, gst: 18 },
  { id: 16, name: 'King Size Book 100 Pages', sku: '48202000', category: 'Books & Registers', qty: 0, unit: 'No', reorder: 3, rate: 31.25, gst: 12 },
  { id: 17, name: 'King Size Book 200 Pages', sku: '48202000', category: 'Books & Registers', qty: 0, unit: 'No', reorder: 3, rate: 31.25, gst: 12 },
  // Desk Supplies
  { id: 18, name: 'Eraser', sku: '40169200', category: 'Desk Supplies', qty: 0, unit: 'No', reorder: 5, rate: 3.81, gst: 5 },
  { id: 19, name: 'Sharpener', sku: '82141010', category: 'Desk Supplies', qty: 0, unit: 'No', reorder: 5, rate: 3.57, gst: 12 },
  { id: 20, name: 'Duster', sku: '39269099', category: 'Desk Supplies', qty: 0, unit: 'No', reorder: 5, rate: 33.90, gst: 18 },
  { id: 21, name: 'Drawing Pin', sku: '73170091', category: 'Desk Supplies', qty: 0, unit: 'No', reorder: 5, rate: 21.19, gst: 18 },
  { id: 22, name: 'Rubber Band', sku: '40169920', category: 'Desk Supplies', qty: 0, unit: 'No', reorder: 5, rate: 2.68, gst: 12 },
  { id: 23, name: 'Stamp Pad', sku: '96122000', category: 'Desk Supplies', qty: 0, unit: 'No', reorder: 3, rate: 35.59, gst: 18 },
  { id: 24, name: 'Stamp Pad Blue Ink', sku: '32159090', category: 'Desk Supplies', qty: 0, unit: 'No', reorder: 3, rate: 38.14, gst: 18 },
  { id: 25, name: 'Calculator', sku: '84701000', category: 'Desk Supplies', qty: 0, unit: 'No', reorder: 2, rate: 338.98, gst: 18 },
  { id: 26, name: 'White Board Marker', sku: '96082000', category: 'Desk Supplies', qty: 0, unit: 'No', reorder: 3, rate: 21.19, gst: 18 },
  // Tapes & Adhesives
  { id: 27, name: 'Glue Stick', sku: '35061000', category: 'Tapes & Adhesives', qty: 0, unit: 'No', reorder: 5, rate: 21.19, gst: 18 },
  { id: 28, name: 'Tixo Tape', sku: '39199020', category: 'Tapes & Adhesives', qty: 0, unit: 'No', reorder: 3, rate: 33.90, gst: 18 },
  { id: 29, name: 'Brown Tape', sku: '84778090', category: 'Tapes & Adhesives', qty: 0, unit: 'No', reorder: 3, rate: 33.90, gst: 18 },
  // Machines
  { id: 30, name: 'Stapler Machine', sku: '84729010', category: 'Machines', qty: 0, unit: 'No', reorder: 2, rate: 46.61, gst: 18 },
  { id: 31, name: 'Stapler Kangaro HP-45', sku: '84729010', category: 'Machines', qty: 0, unit: 'No', reorder: 1, rate: 148.31, gst: 18 },
  { id: 32, name: 'Small Stapler Pins', sku: '84729010', category: 'Machines', qty: 0, unit: 'No', reorder: 5, rate: 80.51, gst: 18 },
  { id: 33, name: 'Big Stapler Pins', sku: '83052000', category: 'Machines', qty: 0, unit: 'No', reorder: 5, rate: 127.12, gst: 18 },
  { id: 34, name: 'Punching Machine - DP 280', sku: '84729099', category: 'Machines', qty: 0, unit: 'No', reorder: 2, rate: 101.69, gst: 18 },
  { id: 35, name: 'Punching Machine - DP 600', sku: '84729099', category: 'Machines', qty: 0, unit: 'No', reorder: 2, rate: 101.69, gst: 18 },
];

const DEFAULT_TRANSACTIONS = [];

const DEFAULT_SUPPLIERS = [];

const DEFAULT_NOTIFICATIONS = [];

function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed._version === DATA_VERSION) return parsed;
    // FIX #10: Migrate data instead of wiping on version change
    parsed._version = DATA_VERSION;
    parsed.inventory = DEFAULT_INVENTORY.map(item => {
      const old = (parsed.inventory || []).find(i => i.name === item.name);
      return old ? { ...item, qty: old.qty } : item;
    });
    if (!parsed.transactions) parsed.transactions = [];
    if (!parsed.team) parsed.team = [];
    if (!parsed.suppliers) parsed.suppliers = [];
    if (!parsed.notifications) parsed.notifications = [];
    if (!parsed.profile) parsed.profile = { branch: '', boe: '' };
    saveData(parsed);
    return parsed;
  }
  const data = {
    _version: DATA_VERSION,
    inventory: DEFAULT_INVENTORY,
    transactions: DEFAULT_TRANSACTIONS,
    team: DEFAULT_TEAM,
    suppliers: DEFAULT_SUPPLIERS,
    notifications: DEFAULT_NOTIFICATIONS,
    profile: {
      branch: selectedLocation || 'Unknown Branch',
      boe: 'Navachetana Livelihoods Pvt Ltd',
    },
  };
  saveData(data);
  return data;
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

let appData = loadData();

// --- SUPABASE DATA SYNC ---

async function loadFromSupabase() {
  if (!selectedLocation) return;

  try {
    // FIX #1: Fetch entries in ascending order so sequential qty computation is correct
    const entries = await supabaseFetch('stock_entries',
      'select=*&location=eq.' + encodeURIComponent(selectedLocation) + '&order=created_at.asc');

    // Reset inventory quantities to 0 from catalog
    appData.inventory = DEFAULT_INVENTORY.map(item => ({ ...item, qty: 0 }));

    // FIX #9: Handle renamed/removed items — create entries for unknown item names
    const knownNames = new Set(appData.inventory.map(i => i.name));
    entries.forEach(e => {
      let item = appData.inventory.find(i => i.name === e.item_name);
      if (!item) {
        // Item not in DEFAULT_INVENTORY — create a dynamic entry
        item = { id: Date.now() + Math.random(), name: e.item_name, sku: e.hsn_code || '', category: e.category || 'Uncategorized', qty: 0, unit: e.unit || 'No', reorder: 0, rate: e.rate || 0, gst: e.gst || 0 };
        appData.inventory.push(item);
        knownNames.add(e.item_name);
      }
      if (e.entry_type === 'in') item.qty += e.quantity;
      else item.qty = Math.max(0, item.qty - e.quantity);
    });

    // Convert entries to local transactions format
    // FIX #1: .reverse() so newest shows first in the UI (entries are fetched asc for correct qty calc)
    appData.transactions = entries.map(e => ({
      id: e.id,
      itemName: e.item_name,
      sku: e.hsn_code,
      type: e.entry_type,
      qty: e.quantity,
      date: e.created_at,
      user: e.emp_name,
      isEdited: e.is_edited || false,
    })).reverse();

    // Generate notifications for low/out-of-stock items
    appData.notifications = [];
    appData.inventory.forEach(item => {
      if (item.qty <= item.reorder) {
        appData.notifications.push({
          id: item.id,
          text: `${item.name} stock ${item.qty <= 0 ? 'depleted' : 'critically low'} (${item.qty} ${item.unit || 'units'})`,
          type: 'alert',
          time: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        });
      }
    });

    // Punching Machine data reset notice (auto-expires 27 Feb 2026)
    if (new Date() < new Date('2026-02-27')) {
      appData.notifications.unshift({
        id: 'punching-machine-notice',
        text: 'Punching Machine data has been deleted. Please re-enter your stock data under the correct machine — DP 280 or DP 600.',
        type: 'alert',
        time: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      });
    }

  } catch (err) {
    console.error('Failed to load from Supabase:', err);
    showToast('Failed to load data from server', 'delete');
  }
}

// --- ADMIN DATA ---

let adminData = { entries: [], employees: [], editLogs: [], deletionLogs: [], receivedDateDeletions: [] };
let selectedBranch = null;

async function loadAdminData() {
  try {
    const [entries, employees, editLogs, deletionLogs, receivedDateDeletions] = await Promise.all([
      // FIX #1: Fetch stock_entries in asc order for correct sequential qty computation
      supabaseFetch('stock_entries', 'select=*&order=created_at.asc'),
      supabaseFetch('employees', 'select=*&order=name.asc'),
      supabaseFetch('edit_log', 'select=*&order=edited_at.desc'),
      supabaseFetch('deletion_log', 'select=*&order=deleted_at.desc').catch(() => []),
      supabaseFetch('received_date_deletion_log', 'select=*&order=deleted_at.desc').catch(() => []),
    ]);
    adminData.entries = entries || [];
    adminData.employees = employees || [];
    adminData.editLogs = editLogs || [];
    adminData.deletionLogs = deletionLogs || [];
    adminData.receivedDateDeletions = receivedDateDeletions || [];
  } catch (err) {
    console.error('Failed to load admin data:', err);
    showToast('Failed to load admin data', 'delete');
  }
}

function renderAdminDashboard() {
  const entries = adminData.entries;
  const employees = adminData.employees;

  // Compute aggregates
  const stockInQty = entries.filter(e => e.entry_type === 'in').reduce((s, e) => s + e.quantity, 0);
  const stockOutQty = entries.filter(e => e.entry_type === 'out').reduce((s, e) => s + e.quantity, 0);

  // Closing stock: compute per-item qty across all branches, then sum
  const closingStock = DEFAULT_INVENTORY.reduce((total, item) => {
    let qty = 0;
    entries.forEach(e => {
      if (e.item_name === item.name) {
        if (e.entry_type === 'in') qty += e.quantity;
        else qty = Math.max(0, qty - e.quantity);
      }
    });
    return total + qty;
  }, 0);

  // Get unique branches from entries + employees
  const branchesFromEntries = entries.map(e => e.location).filter(Boolean);
  const branchesFromEmployees = employees.map(e => e.location).filter(Boolean);
  const allBranches = [...new Set([...branchesFromEntries, ...branchesFromEmployees])].filter(b => b !== 'Head Office').sort();

  // KPIs
  document.getElementById('admin-kpi-closing-stock').textContent = closingStock.toLocaleString() + ' Units';
  document.getElementById('admin-kpi-branches').textContent = allBranches.length;
  document.getElementById('admin-kpi-stock-in').textContent = stockInQty.toLocaleString() + ' Units';
  document.getElementById('admin-kpi-stock-out').textContent = stockOutQty.toLocaleString() + ' Units';

  // Branch-wise breakdown
  const branchTable = document.getElementById('admin-branch-table');
  if (allBranches.length === 0) {
    branchTable.innerHTML = '<tr><td class="px-6 py-4 text-slate-400 text-center" colspan="6">No branch data found</td></tr>';
  } else {
    branchTable.innerHTML = allBranches.map(branch => {
      const branchEntries = entries.filter(e => e.location === branch);
      const branchIn = branchEntries.filter(e => e.entry_type === 'in').reduce((s, e) => s + e.quantity, 0);
      const branchOut = branchEntries.filter(e => e.entry_type === 'out').reduce((s, e) => s + e.quantity, 0);
      const branchEmps = employees.filter(e => e.location === branch).length;
      return `
        <tr onclick="openBranchDetail(this.dataset.branch)" data-branch="${escHtml(branch)}" class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors cursor-pointer group">
          <td class="px-6 py-4">
            <div class="flex items-center gap-3">
              <div class="size-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <span class="material-symbols-outlined text-primary text-sm">location_on</span>
              </div>
              <span class="font-semibold text-slate-800 dark:text-white">${escHtml(branch)}</span>
            </div>
          </td>
          <td class="px-6 py-4 font-semibold text-slate-700 dark:text-slate-300">${branchEntries.length}</td>
          <td class="px-6 py-4 text-green-600 dark:text-green-400 font-semibold">+${branchIn.toLocaleString()}</td>
          <td class="px-6 py-4 text-red-500 font-semibold">-${branchOut.toLocaleString()}</td>
          <td class="px-6 py-4 text-slate-600 dark:text-slate-400">${branchEmps}</td>
          <td class="px-6 py-4"><span class="material-symbols-outlined text-slate-300 dark:text-slate-600 group-hover:text-primary text-base transition-colors">chevron_right</span></td>
        </tr>
      `;
    }).join('');
  }

  // Recent activity (last 10)
  const recent = entries.slice(0, 10);
  const recentTable = document.getElementById('admin-recent-table');
  if (recent.length === 0) {
    recentTable.innerHTML = '<tr><td class="px-6 py-4 text-slate-400 text-center" colspan="5">No recent activity</td></tr>';
  } else {
    recentTable.innerHTML = recent.map(e => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
        <td class="px-6 py-3">
          <span class="font-medium text-slate-800 dark:text-slate-200">${escHtml(e.item_name)}</span>
        </td>
        <td class="px-6 py-3">
          <div class="flex items-center gap-1 flex-wrap">
            ${e.entry_type === 'in'
              ? '<span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[10px] font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">IN</span>'
              : '<span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400">OUT</span>'
            }
            ${e.is_edited ? '<span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">EDITED</span>' : ''}
          </div>
        </td>
        <td class="px-6 py-3 font-semibold text-slate-700 dark:text-slate-300">${e.entry_type === 'in' ? '+' : '-'}${e.quantity}</td>
        <td class="px-6 py-3 text-xs text-slate-500 dark:text-slate-400">${escHtml(e.location || '--')}</td>
        <td class="px-6 py-3 text-xs text-slate-500 dark:text-slate-400">${escHtml(e.emp_name || '--')}</td>
      </tr>
    `).join('');
  }

  // All employees grid with branch filter
  const empFilter = document.getElementById('admin-emp-filter');
  if (empFilter) {
    const currentVal = empFilter.value;
    empFilter.innerHTML = '<option value="all">All Branches</option>' +
      allBranches.map(b => `<option value="${escHtml(b)}">${escHtml(b)}</option>`).join('');
    empFilter.value = currentVal && allBranches.includes(currentVal) ? currentVal : 'all';
  }

  renderAdminEmployees();
}

let _adminAllEmployees = null;

function renderAdminEmployees() {
  const filter = document.getElementById('admin-emp-filter');
  const filterVal = filter ? filter.value : 'all';
  const employees = filterVal === 'all'
    ? adminData.employees.filter(e => e.location !== 'Head Office')
    : adminData.employees.filter(e => e.location === filterVal);

  _adminAllEmployees = employees;

  const grid = document.getElementById('admin-employees-grid');
  const TEAM_COLORS = ['from-primary to-blue-400','from-emerald-500 to-teal-400','from-violet-500 to-purple-400','from-amber-500 to-orange-400','from-rose-500 to-pink-400','from-cyan-500 to-sky-400'];

  if (employees.length === 0) {
    grid.innerHTML = '<div class="col-span-full bg-white dark:bg-[#1c2631] p-6 text-center text-slate-400 text-sm">No employees found</div>';
    return;
  }

  grid.innerHTML = employees.map((m, i) => {
    const initials = m.name ? m.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : '??';
    const color = TEAM_COLORS[i % TEAM_COLORS.length];
    return `
      <div class="bg-white dark:bg-[#1c2631] p-4 flex items-center gap-3">
        <div class="size-10 rounded-full bg-gradient-to-br ${color} flex items-center justify-center text-white font-bold text-xs flex-shrink-0">${initials}</div>
        <div class="min-w-0 flex-1">
          <p class="font-semibold text-slate-800 dark:text-white text-sm truncate">${escHtml(m.name)}</p>
          <p class="text-[10px] text-slate-500 dark:text-slate-400">${escHtml(m.role || '')} &middot; ${escHtml(m.location || '')}</p>
        </div>
      </div>
    `;
  }).join('');
}

function filterAdminEmployees() {
  renderAdminEmployees();
}

// --- BRANCH DETAIL (Admin) ---

function openBranchDetail(branchName) {
  selectedBranch = branchName;
  navigateTo('branchdetail');
}

function renderBranchDetail() {
  if (!selectedBranch) { navigateTo('admin'); return; }

  const entries = adminData.entries.filter(e => e.location === selectedBranch);
  const employees = adminData.employees.filter(e => e.location === selectedBranch);

  // Header
  document.getElementById('bd-branch-name').textContent = selectedBranch;
  document.getElementById('bd-branch-badge').textContent = selectedBranch;

  // Compute per-item inventory from branch entries
  const branchInventory = DEFAULT_INVENTORY.map(item => {
    let qty = 0;
    entries.forEach(e => {
      if (e.item_name === item.name) {
        if (e.entry_type === 'in') qty += e.quantity;
        else qty = Math.max(0, qty - e.quantity);
      }
    });
    return { ...item, qty };
  });

  // KPIs
  const closingStock = branchInventory.reduce((s, i) => s + i.qty, 0);
  const lowStockCount = branchInventory.filter(i => i.qty > 0 && i.qty <= i.reorder).length;
  const stockInTotal = entries.filter(e => e.entry_type === 'in').reduce((s, e) => s + e.quantity, 0);
  const stockOutTotal = entries.filter(e => e.entry_type === 'out').reduce((s, e) => s + e.quantity, 0);

  document.getElementById('bd-kpi-closing').textContent = closingStock.toLocaleString() + ' Units';
  document.getElementById('bd-kpi-low').textContent = lowStockCount + ' Items';
  document.getElementById('bd-kpi-in').textContent = stockInTotal.toLocaleString() + ' Units';
  document.getElementById('bd-kpi-out').textContent = stockOutTotal.toLocaleString() + ' Units';

  // Inventory table
  const invTable = document.getElementById('bd-inventory-table');
  const itemsWithStock = branchInventory.filter(i => i.qty > 0 || entries.some(e => e.item_name === i.name));
  if (itemsWithStock.length === 0) {
    invTable.innerHTML = '<tr><td colspan="5" class="px-6 py-16 text-center"><div class="flex flex-col items-center text-slate-400 dark:text-slate-500"><span class="material-symbols-outlined text-5xl mb-3">inventory_2</span><p class="text-sm font-medium">No inventory data for this branch</p><p class="text-xs mt-1">Stock entries will appear here once recorded</p></div></td></tr>';
  } else {
    invTable.innerHTML = itemsWithStock.map(item => {
      let status, statusClass;
      if (item.qty <= 0) {
        status = 'Out of Stock'; statusClass = 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
      } else if (item.qty <= item.reorder) {
        status = 'Low Stock'; statusClass = 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
      } else {
        status = 'In Stock'; statusClass = 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
      }
      return `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
          <td class="px-6 py-4 font-medium text-slate-800 dark:text-slate-200">${escHtml(item.name)}</td>
          <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${escHtml(item.category)}</td>
          <td class="px-6 py-4 font-semibold text-slate-700 dark:text-slate-300">${item.qty.toLocaleString()} ${escHtml(item.unit || 'No')}</td>
          <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${item.reorder} ${escHtml(item.unit || 'No')}</td>
          <td class="px-6 py-4"><span class="py-1 px-2.5 rounded-full text-xs font-semibold ${statusClass}">${status}</span></td>
        </tr>
      `;
    }).join('');
  }

  // Recent transactions (last 10)
  const recentTxns = entries.slice(0, 10);
  const txnTable = document.getElementById('bd-txn-table');
  if (recentTxns.length === 0) {
    txnTable.innerHTML = '<tr><td colspan="5" class="px-6 py-16 text-center"><div class="flex flex-col items-center text-slate-400 dark:text-slate-500"><span class="material-symbols-outlined text-5xl mb-3">swap_horiz</span><p class="text-sm font-medium">No transactions recorded</p><p class="text-xs mt-1">Stock entries for this branch will appear here</p></div></td></tr>';
  } else {
    txnTable.innerHTML = recentTxns.map(e => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
        <td class="px-6 py-3 font-medium text-slate-800 dark:text-slate-200">${escHtml(e.item_name)}</td>
        <td class="px-6 py-3">
          <div class="flex items-center gap-1.5 flex-wrap">
            ${e.entry_type === 'in'
              ? '<span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[10px] font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">IN</span>'
              : '<span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400">OUT</span>'
            }
            ${e.is_edited ? '<span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">EDITED</span>' : ''}
          </div>
        </td>
        <td class="px-6 py-3 font-semibold text-slate-700 dark:text-slate-300">${e.entry_type === 'in' ? '+' : '-'}${e.quantity}</td>
        <td class="px-6 py-3 text-xs text-slate-500 dark:text-slate-400">${formatDate(e.created_at)}</td>
        <td class="px-6 py-3 text-xs text-slate-500 dark:text-slate-400">${escHtml(e.emp_name || '--')}</td>
      </tr>
    `).join('');
  }

  // Team members
  const teamGrid = document.getElementById('bd-team-grid');
  const teamCount = document.getElementById('bd-team-count');
  if (teamCount) {
    if (employees.length > 0) { teamCount.textContent = employees.length; teamCount.classList.remove('hidden'); }
    else { teamCount.classList.add('hidden'); }
  }
  const TEAM_COLORS = ['from-primary to-blue-400','from-emerald-500 to-teal-400','from-violet-500 to-purple-400','from-amber-500 to-orange-400','from-rose-500 to-pink-400','from-cyan-500 to-sky-400'];
  if (employees.length === 0) {
    teamGrid.innerHTML = '<div class="col-span-full p-6 text-center text-slate-400 dark:text-slate-500 text-sm">No employees found at this branch</div>';
  } else {
    teamGrid.innerHTML = employees.map((m, i) => {
      const initials = m.name ? m.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : '??';
      const color = TEAM_COLORS[i % TEAM_COLORS.length];
      return `
        <div class="bg-white dark:bg-[#1c2631] p-4 flex items-center gap-3">
          <div class="size-10 rounded-full bg-gradient-to-br ${color} flex items-center justify-center text-white font-bold text-xs flex-shrink-0">${initials}</div>
          <div class="min-w-0 flex-1">
            <p class="font-semibold text-slate-800 dark:text-white text-sm truncate">${escHtml(m.name)}</p>
            <p class="text-[10px] text-slate-500 dark:text-slate-400">${escHtml(m.role || '')} &middot; ${escHtml(m.emp_id || '')}</p>
          </div>
        </div>
      `;
    }).join('');
  }
}

// --- CLOSING STOCK PAGE (Admin) ---

function computeBranchInventory(branch) {
  const branchEntries = adminData.entries.filter(e => e.location === branch);
  return DEFAULT_INVENTORY.map(item => {
    let qty = 0;
    branchEntries.forEach(e => {
      if (e.item_name === item.name) {
        if (e.entry_type === 'in') qty += e.quantity;
        else qty = Math.max(0, qty - e.quantity);
      }
    });
    return { ...item, qty };
  });
}

function renderClosingStock() {
  const entries = adminData.entries;
  const employees = adminData.employees;

  const branchesFromEntries = entries.map(e => e.location).filter(Boolean);
  const branchesFromEmployees = employees.map(e => e.location).filter(Boolean);
  const allBranches = [...new Set([...branchesFromEntries, ...branchesFromEmployees])].filter(b => b !== 'Head Office').sort();

  const branchStocks = allBranches.map(branch => {
    const inv = computeBranchInventory(branch);
    const closingStock = inv.reduce((s, i) => s + i.qty, 0);
    return { branch, closingStock };
  });

  const grandTotal = branchStocks.reduce((s, b) => s + b.closingStock, 0);

  const table = document.getElementById('cs-branch-table');
  if (branchStocks.length === 0) {
    table.innerHTML = '<tr><td colspan="2" class="px-6 py-16 text-center"><div class="flex flex-col items-center text-slate-400 dark:text-slate-500"><span class="material-symbols-outlined text-5xl mb-3">inventory</span><p class="text-sm font-medium">No branch data found</p></div></td></tr>';
  } else {
    table.innerHTML = branchStocks.map(b => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
        <td class="px-6 py-4">
          <div class="flex items-center gap-3">
            <div class="size-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <span class="material-symbols-outlined text-primary text-sm">location_on</span>
            </div>
            <span class="font-semibold text-slate-800 dark:text-white">${escHtml(b.branch)}</span>
          </div>
        </td>
        <td class="px-6 py-4 text-right font-bold text-slate-700 dark:text-slate-300">${b.closingStock.toLocaleString()} <span class="text-xs font-normal text-slate-400">Units</span></td>
      </tr>
    `).join('');
  }

  document.getElementById('cs-grand-total').textContent = grandTotal.toLocaleString() + ' Units';
}

function exportClosingStockToExcel() {
  const entries = adminData.entries;
  const employees = adminData.employees;

  const branchesFromEntries = entries.map(e => e.location).filter(Boolean);
  const branchesFromEmployees = employees.map(e => e.location).filter(Boolean);
  const allBranches = [...new Set([...branchesFromEntries, ...branchesFromEmployees])].filter(b => b !== 'Head Office').sort();

  const wb = XLSX.utils.book_new();

  allBranches.forEach(branch => {
    const inv = computeBranchInventory(branch);
    const itemsWithActivity = inv.filter(i => i.qty > 0 || adminData.entries.some(e => e.item_name === i.name && e.location === branch));

    const rows = itemsWithActivity.map(item => ({
      'Item Name': item.name,
      'Category': item.category,
      'Quantity': item.qty,
      'Unit': item.unit || 'No',
      'Reorder Level': item.reorder,
      'Status': item.qty <= 0 ? 'Out of Stock' : item.qty <= item.reorder ? 'Low Stock' : 'In Stock',
    }));

    if (rows.length === 0) {
      rows.push({ 'Item Name': 'No inventory data', 'Category': '', 'Quantity': '', 'Unit': '', 'Reorder Level': '', 'Status': '' });
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 14 }];
    // Sheet names max 31 chars, no special chars
    const sheetName = branch.length > 31 ? branch.slice(0, 31) : branch;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

  if (allBranches.length === 0) {
    const ws = XLSX.utils.json_to_sheet([{ 'Info': 'No branch data found' }]);
    XLSX.utils.book_append_sheet(wb, ws, 'No Data');
  }

  XLSX.writeFile(wb, 'Closing_Stock_' + new Date().toISOString().slice(0, 10) + '.xlsx');
  showToast('Closing stock Excel downloaded');
}

function exportOutOfStockToExcel() {
  const entries = adminData.entries;
  const employees = adminData.employees;

  const branchesFromEntries = entries.map(e => e.location).filter(Boolean);
  const branchesFromEmployees = employees.map(e => e.location).filter(Boolean);
  const allBranches = [...new Set([...branchesFromEntries, ...branchesFromEmployees])].filter(b => b !== 'Head Office').sort();

  const combinedRows = [];

  allBranches.forEach(branch => {
    const inv = computeBranchInventory(branch);
    const outItems = inv.filter(i => i.qty <= 0 && adminData.entries.some(e => e.item_name === i.name && e.location === branch));

    outItems.forEach(item => {
      combinedRows.push({
        'Branch': branch,
        'Item Name': item.name,
        'Category': item.category,
        'Quantity': item.qty,
        'Unit': item.unit || 'No',
        'Reorder Level': item.reorder,
        'Status': 'Out of Stock',
      });
    });
  });

  const wb = XLSX.utils.book_new();

  if (combinedRows.length === 0) {
    const ws = XLSX.utils.json_to_sheet([{ 'Info': 'No out-of-stock items found' }]);
    XLSX.utils.book_append_sheet(wb, ws, 'Out of Stock');
  } else {
    const ws = XLSX.utils.json_to_sheet(combinedRows);
    ws['!cols'] = [{ wch: 22 }, { wch: 28 }, { wch: 18 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Out of Stock');
  }

  XLSX.writeFile(wb, 'Out_Of_Stock_' + new Date().toISOString().slice(0, 10) + '.xlsx');
  showToast('Out of stock Excel downloaded');
}

// --- STOCK RECEIVED DATE (Branch) ---

async function renderReceivedDate() {
  if (!selectedLocation) return;

  const table = document.getElementById('received-date-table');
  table.innerHTML = '<tr><td class="px-6 py-4 text-slate-400 text-center" colspan="5">Loading...</td></tr>';

  // Default date picker to today
  const dateInput = document.getElementById('rd-date-input');
  if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);

  try {
    const logs = await supabaseFetch('received_date_log',
      'select=*&location=eq.' + encodeURIComponent(selectedLocation) + '&order=created_at.desc');

    if (!logs || logs.length === 0) {
      table.innerHTML = '<tr><td colspan="5" class="px-6 py-16 text-center"><div class="flex flex-col items-center text-slate-400 dark:text-slate-500"><span class="material-symbols-outlined text-5xl mb-3">event_available</span><p class="text-sm font-medium">No received dates logged yet</p><p class="text-xs mt-1">Use the form above to log when stock was received</p></div></td></tr>';
      return;
    }

    table.innerHTML = logs.map(l => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
        <td class="px-6 py-4">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-primary text-sm">event_available</span>
            <span class="font-semibold text-slate-800 dark:text-white">${escHtml(formatDateShort(l.received_date))}</span>
          </div>
        </td>
        <td class="px-6 py-4 text-slate-600 dark:text-slate-400">${escHtml(l.note || '--')}</td>
        <td class="px-6 py-4 text-slate-600 dark:text-slate-400">${escHtml(l.logged_by || '--')}</td>
        <td class="px-6 py-4 text-xs text-slate-500 dark:text-slate-400">${formatDate(l.created_at)}</td>
        <td class="px-6 py-4">
          <button onclick="deleteReceivedDateLog(${l.id})" class="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors">
            <span class="material-symbols-outlined text-base">delete</span>
          </button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Failed to load received date log:', err);
    table.innerHTML = '<tr><td class="px-6 py-4 text-red-400 text-center" colspan="5">Failed to load data</td></tr>';
  }
}

function formatDateShort(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function saveReceivedDateLog() {
  const dateInput = document.getElementById('rd-date-input');
  const noteInput = document.getElementById('rd-note-input');

  if (!dateInput || !dateInput.value) {
    showToast('Please select a date', 'delete');
    return;
  }

  try {
    await supabaseInsert('received_date_log', [{
      location: selectedLocation,
      received_date: dateInput.value,
      note: noteInput ? noteInput.value.trim() || null : null,
      logged_by: currentEmployee ? currentEmployee.name : 'Unknown',
      created_at: new Date().toISOString(),
    }]);

    showToast('Received date logged');
    dateInput.value = new Date().toISOString().slice(0, 10);
    if (noteInput) noteInput.value = '';
    renderReceivedDate();
  } catch (err) {
    console.error('Failed to save received date:', err);
    showToast('Failed to save', 'delete');
  }
}

async function deleteReceivedDateLog(id) {
  if (!confirm('Delete this received date entry?')) return;

  try {
    // FIX #13: Fetch entry, delete first, then log — ensures atomicity
    const entries = await supabaseFetch('received_date_log', 'select=*&id=eq.' + id);
    const entry = entries && entries[0];
    if (!entry) {
      showToast('Entry not found', 'delete');
      return;
    }

    const res = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/received_date_log?id=eq.${id}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + SUPABASE_ANON,
        'Prefer': 'return=minimal',
      },
    });
    if (!res.ok) throw new Error('Delete failed');

    // Log deletion (best-effort)
    try {
      await supabaseInsert('received_date_deletion_log', [{
        original_id: entry.id,
        location: entry.location,
        received_date: entry.received_date,
        note: entry.note,
        logged_by: entry.logged_by,
        deleted_by: currentEmployee ? currentEmployee.name : 'Unknown',
        deleted_at: new Date().toISOString(),
      }]);
    } catch (logErr) {
      console.error('Failed to log deletion:', logErr);
    }

    showToast('Entry deleted & logged');
    renderReceivedDate();
  } catch (err) {
    console.error('Failed to delete received date log:', err);
    showToast('Failed to delete', 'delete');
  }
}

// --- EDIT LOG ---

function renderEditLog() {
  const logs = adminData.editLogs || [];

  // KPIs
  document.getElementById('editlog-kpi-total').textContent = logs.length.toLocaleString();
  const branches = new Set(logs.map(l => l.branch).filter(Boolean));
  document.getElementById('editlog-kpi-branches').textContent = branches.size;

  const table = document.getElementById('editlog-table');
  if (logs.length === 0) {
    table.innerHTML = `<tr><td colspan="5" class="px-6 py-16 text-center"><div class="flex flex-col items-center text-slate-400 dark:text-slate-500"><span class="material-symbols-outlined text-5xl mb-3">edit_note</span><p class="text-sm font-medium">No edits recorded yet</p><p class="text-xs mt-1">Edits made by BOE users will appear here</p></div></td></tr>`;
    return;
  }

  table.innerHTML = logs.map(l => {
    const typeBadge = (type) => type === 'in'
      ? '<span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[10px] font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">IN</span>'
      : '<span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400">OUT</span>';

    const typeChanged = l.old_type !== l.new_type;
    const qtyChanged = l.old_qty !== l.new_qty;

    let changeHtml = '';
    if (typeChanged) {
      changeHtml += `<div class="flex items-center gap-1.5">${typeBadge(l.old_type)}<span class="material-symbols-outlined text-slate-400 text-sm">arrow_forward</span>${typeBadge(l.new_type)}</div>`;
    }
    if (qtyChanged) {
      changeHtml += `<div class="flex items-center gap-1.5 text-xs"><span class="text-slate-500">Qty:</span><span class="font-semibold text-slate-600 dark:text-slate-300">${l.old_qty}</span><span class="material-symbols-outlined text-slate-400 text-sm">arrow_forward</span><span class="font-semibold text-slate-600 dark:text-slate-300">${l.new_qty}</span></div>`;
    }
    if (!typeChanged && !qtyChanged) {
      changeHtml = '<span class="text-xs text-slate-400">No change</span>';
    }

    return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
        <td class="px-6 py-4 text-slate-500 dark:text-slate-400 text-xs">${formatDate(l.edited_at)}</td>
        <td class="px-6 py-4 font-medium text-slate-800 dark:text-slate-200">${escHtml(l.item_name || '--')}</td>
        <td class="px-6 py-4"><div class="flex flex-col gap-1">${changeHtml}</div></td>
        <td class="px-6 py-4 text-slate-700 dark:text-slate-300">${escHtml(l.edited_by || '--')}</td>
        <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${escHtml(l.branch || '--')}</td>
      </tr>
    `;
  }).join('');
}

// --- DELETION LOG ---

let deleteLogFilter = 'transactions';

function filterDeleteLog(type) {
  deleteLogFilter = type;

  // Update button styles
  const txnBtn = document.getElementById('deletelog-filter-txn');
  const rdBtn = document.getElementById('deletelog-filter-rd');
  const activeClass = 'px-4 py-2 rounded-lg text-sm font-semibold bg-primary text-white transition-colors';
  const inactiveClass = 'px-4 py-2 rounded-lg text-sm font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors';

  if (type === 'transactions') {
    txnBtn.className = activeClass;
    rdBtn.className = inactiveClass;
  } else {
    txnBtn.className = inactiveClass;
    rdBtn.className = activeClass;
  }

  renderDeleteLog();
}

function renderDeleteLog() {
  const txnLogs = adminData.deletionLogs || [];
  const rdLogs = adminData.receivedDateDeletions || [];

  // KPIs — show combined totals
  const totalDeletions = txnLogs.length + rdLogs.length;
  document.getElementById('deletelog-kpi-total').textContent = totalDeletions.toLocaleString();
  const allBranches = new Set([
    ...txnLogs.map(l => l.branch).filter(Boolean),
    ...rdLogs.map(l => l.location).filter(Boolean),
  ]);
  document.getElementById('deletelog-kpi-branches').textContent = allBranches.size;

  const table = document.getElementById('deletelog-table');
  const thead = document.getElementById('deletelog-thead');
  const title = document.getElementById('deletelog-table-title');
  const subtitle = document.getElementById('deletelog-table-subtitle');

  if (deleteLogFilter === 'transactions') {
    if (title) title.textContent = 'Deleted Transactions';
    if (subtitle) subtitle.textContent = 'Stock entries deleted by BOE users';
    if (thead) thead.innerHTML = '<tr><th class="px-6 py-4 font-semibold">Deleted At</th><th class="px-6 py-4 font-semibold">Item</th><th class="px-6 py-4 font-semibold">Type & Qty</th><th class="px-6 py-4 font-semibold">Original Date</th><th class="px-6 py-4 font-semibold">Deleted By</th><th class="px-6 py-4 font-semibold">Branch</th></tr>';

    if (txnLogs.length === 0) {
      table.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center"><div class="flex flex-col items-center text-slate-400 dark:text-slate-500"><span class="material-symbols-outlined text-5xl mb-3">delete_sweep</span><p class="text-sm font-medium">No transaction deletions recorded</p></div></td></tr>`;
      return;
    }

    table.innerHTML = txnLogs.map(l => {
      const typeBadge = l.entry_type === 'in'
        ? '<span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[10px] font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">IN</span>'
        : '<span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400">OUT</span>';

      return `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
          <td class="px-6 py-4 text-slate-500 dark:text-slate-400 text-xs">${formatDate(l.deleted_at)}</td>
          <td class="px-6 py-4 font-medium text-slate-800 dark:text-slate-200">${escHtml(l.item_name || '--')}</td>
          <td class="px-6 py-4">
            <div class="flex items-center gap-2">
              ${typeBadge}
              <span class="font-semibold text-slate-700 dark:text-slate-300">${l.entry_type === 'in' ? '+' : '-'}${l.quantity}</span>
            </div>
          </td>
          <td class="px-6 py-4 text-slate-500 dark:text-slate-400 text-xs">${l.original_date ? formatDate(l.original_date) : '--'}</td>
          <td class="px-6 py-4 text-slate-700 dark:text-slate-300">${escHtml(l.deleted_by || '--')}</td>
          <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${escHtml(l.branch || '--')}</td>
        </tr>
      `;
    }).join('');

  } else {
    // Received date deletions
    if (title) title.textContent = 'Deleted Received Dates';
    if (subtitle) subtitle.textContent = 'Received date entries deleted by branch users';
    if (thead) thead.innerHTML = '<tr><th class="px-6 py-4 font-semibold">Deleted At</th><th class="px-6 py-4 font-semibold">Received Date</th><th class="px-6 py-4 font-semibold">Note</th><th class="px-6 py-4 font-semibold">Logged By</th><th class="px-6 py-4 font-semibold">Deleted By</th><th class="px-6 py-4 font-semibold">Branch</th></tr>';

    if (rdLogs.length === 0) {
      table.innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center"><div class="flex flex-col items-center text-slate-400 dark:text-slate-500"><span class="material-symbols-outlined text-5xl mb-3">event_busy</span><p class="text-sm font-medium">No received date deletions recorded</p></div></td></tr>`;
      return;
    }

    table.innerHTML = rdLogs.map(l => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
        <td class="px-6 py-4 text-slate-500 dark:text-slate-400 text-xs">${formatDate(l.deleted_at)}</td>
        <td class="px-6 py-4 font-medium text-slate-800 dark:text-slate-200">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-primary text-sm">event_available</span>
            ${escHtml(formatDateShort(l.received_date))}
          </div>
        </td>
        <td class="px-6 py-4 text-slate-600 dark:text-slate-400">${escHtml(l.note || '--')}</td>
        <td class="px-6 py-4 text-slate-500 dark:text-slate-400 text-xs">${escHtml(l.logged_by || '--')}</td>
        <td class="px-6 py-4 text-slate-700 dark:text-slate-300">${escHtml(l.deleted_by || '--')}</td>
        <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${escHtml(l.location || '--')}</td>
      </tr>
    `).join('');
  }
}

// --- BRANCHES PAGE ---

function timeAgo(date) {
  const now = new Date();
  const d = new Date(date);
  const diffMs = now - d;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return diffMin + ' min ago';
  if (diffHr < 24) return diffHr + (diffHr === 1 ? ' hour ago' : ' hours ago');
  if (diffDay < 30) return diffDay + (diffDay === 1 ? ' day ago' : ' days ago');
  return d.toLocaleDateString();
}

async function renderBranches() {
  const entries = adminData.entries;
  const employees = adminData.employees;

  // Get filter values
  const searchText = (document.getElementById('branches-search')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('branches-status-filter')?.value || 'all';
  const sourceFilter = document.getElementById('branches-source-filter')?.value || 'entries';

  // Get unique branches (exclude Head Office)
  const branchesFromEntries = entries.map(e => e.location).filter(Boolean);
  const branchesFromEmployees = employees.map(e => e.location).filter(Boolean);
  const allBranches = [...new Set([...branchesFromEntries, ...branchesFromEmployees])].filter(b => b !== 'Head Office').sort();

  // Fetch received_date_log on demand if needed
  if ((sourceFilter === 'received' || sourceFilter === 'both') && !adminData.receivedDateLogs) {
    try {
      adminData.receivedDateLogs = await supabaseFetch('received_date_log', 'select=*&order=created_at.desc');
    } catch (e) {
      console.error('Failed to fetch received_date_log:', e);
      adminData.receivedDateLogs = [];
    }
  }

  const now = new Date();

  // Compute last update per branch
  const branchData = allBranches.map(branch => {
    let lastUpdate = null;

    if (sourceFilter === 'entries' || sourceFilter === 'both') {
      const branchEntries = entries.filter(e => e.location === branch);
      const maxEntry = branchEntries.reduce((max, e) => {
        const d = new Date(e.created_at);
        return d > max ? d : max;
      }, new Date(0));
      if (branchEntries.length > 0 && maxEntry > new Date(0)) {
        lastUpdate = maxEntry;
      }
    }

    if (sourceFilter === 'received' || sourceFilter === 'both') {
      const rdLogs = (adminData.receivedDateLogs || []).filter(r => r.location === branch);
      const maxRd = rdLogs.reduce((max, r) => {
        const d = new Date(r.created_at);
        return d > max ? d : max;
      }, new Date(0));
      if (rdLogs.length > 0 && maxRd > new Date(0)) {
        if (!lastUpdate || maxRd > lastUpdate) lastUpdate = maxRd;
      }
    }

    const daysSince = lastUpdate ? Math.floor((now - lastUpdate) / 86400000) : null;
    const updatedToday = daysSince === 0;
    const inactive = daysSince === null;

    let status = 'not-updated';
    if (updatedToday) status = 'updated';
    else if (inactive) status = 'inactive';

    const branchEmployees = employees.filter(e => e.location === branch);
    // Sort BOE first
    branchEmployees.sort((a, b) => {
      const aIsBoe = (a.role || '').toLowerCase().includes('boe') ? 0 : 1;
      const bIsBoe = (b.role || '').toLowerCase().includes('boe') ? 0 : 1;
      return aIsBoe - bIsBoe || a.name.localeCompare(b.name);
    });

    return { branch, lastUpdate, status, updatedToday, inactive, employees: branchEmployees };
  });

  // Sort: no updates first, then oldest update first (least recent → most recent)
  branchData.sort((a, b) => {
    if (!a.lastUpdate && !b.lastUpdate) return a.branch.localeCompare(b.branch);
    if (!a.lastUpdate) return -1;
    if (!b.lastUpdate) return 1;
    return a.lastUpdate - b.lastUpdate;
  });

  // Apply filters
  let filtered = branchData;
  if (searchText) {
    filtered = filtered.filter(b => b.branch.toLowerCase().includes(searchText));
  }
  if (statusFilter !== 'all') {
    filtered = filtered.filter(b => b.status === statusFilter);
  }

  // KPIs (based on unfiltered data)
  const totalBranches = branchData.length;
  const updatedCount = branchData.filter(b => b.updatedToday).length;
  const notUpdatedCount = totalBranches - updatedCount;
  document.getElementById('branches-kpi-total').textContent = totalBranches;
  document.getElementById('branches-kpi-updated').textContent = updatedCount;
  document.getElementById('branches-kpi-not-updated').textContent = notUpdatedCount;

  // Group into time buckets
  const daysAgo = d => Math.floor((now - new Date(d)) / 86400000);
  const buckets = [
    { key: 'inactive', label: 'No Updates', icon: 'error', color: 'red', branches: [] },
    { key: 'd15', label: '15+ Days Ago', icon: 'schedule', color: 'amber', branches: [] },
    { key: 'd10', label: 'Last 10 Days', icon: 'schedule', color: 'orange', branches: [] },
    { key: 'd5', label: 'Last 5 Days', icon: 'update', color: 'blue', branches: [] },
    { key: 'today', label: 'Updated Today', icon: 'check_circle', color: 'green', branches: [] },
  ];

  filtered.forEach(b => {
    if (!b.lastUpdate) { buckets[0].branches.push(b); return; }
    const d = daysAgo(b.lastUpdate);
    if (d > 10) buckets[1].branches.push(b);        // 11+ days (including > 15)
    else if (d > 5) buckets[2].branches.push(b);    // 6-10 days
    else if (d >= 1) buckets[3].branches.push(b);   // 1-5 days
    else buckets[4].branches.push(b);               // today
  });

  // Render chart
  const chartEl = document.getElementById('branches-chart');
  const maxBucket = Math.max(...buckets.map(bk => bk.branches.length), 1);
  const barColors = { red: 'bg-red-500', amber: 'bg-amber-500', orange: 'bg-orange-500', blue: 'bg-blue-500', green: 'bg-green-500' };
  const barBgs = { red: 'bg-red-100 dark:bg-red-900/20', amber: 'bg-amber-100 dark:bg-amber-900/20', orange: 'bg-orange-100 dark:bg-orange-900/20', blue: 'bg-blue-100 dark:bg-blue-900/20', green: 'bg-green-100 dark:bg-green-900/20' };
  chartEl.innerHTML = buckets.map(bk => {
    const pct = Math.round((bk.branches.length / maxBucket) * 100);
    return `
      <div class="flex items-center gap-3">
        <span class="text-[11px] font-semibold text-slate-500 dark:text-slate-400 w-32 text-right truncate flex-shrink-0">${bk.label}</span>
        <div class="flex-1 h-6 rounded-md ${barBgs[bk.color]} overflow-hidden">
          <div class="h-full ${barColors[bk.color]} rounded-md transition-all duration-500 flex items-center justify-end px-2" style="width:${bk.branches.length > 0 ? Math.max(pct, 8) : 0}%">
            ${bk.branches.length > 0 ? `<span class="text-[10px] font-bold text-white">${bk.branches.length}</span>` : ''}
          </div>
        </div>
        ${bk.branches.length === 0 ? '<span class="text-[10px] text-slate-400 w-4">0</span>' : '<span class="w-4"></span>'}
      </div>`;
  }).join('');

  // Render columns
  const listEl = document.getElementById('branches-list');
  const activeBuckets = buckets.filter(bk => bk.branches.length > 0);

  if (activeBuckets.length === 0) {
    listEl.innerHTML = `<div class="flex flex-col items-center text-slate-400 dark:text-slate-500 py-16"><span class="material-symbols-outlined text-5xl mb-3">apartment</span><p class="text-sm font-medium">No branches found</p></div>`;
    return;
  }

  const colorMap = {
    red: { bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-700 dark:text-red-400', dot: 'bg-red-500' },
    amber: { bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-700 dark:text-amber-400', dot: 'bg-amber-500' },
    orange: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-700 dark:text-orange-400', dot: 'bg-orange-500' },
    blue: { bg: 'bg-blue-100 dark:bg-blue-900/30', text: 'text-blue-700 dark:text-blue-400', dot: 'bg-blue-500' },
    green: { bg: 'bg-green-100 dark:bg-green-900/30', text: 'text-green-700 dark:text-green-400', dot: 'bg-green-500' },
  };

  function renderBranchEmpRow(emp) {
    const isBoe = (emp.role || '').toLowerCase().includes('boe');
    const bgClass = isBoe ? 'bg-primary/5 dark:bg-primary/10' : '';
    const boeBadge = isBoe ? '<span class="px-1 py-0.5 rounded text-[8px] font-bold uppercase bg-primary/10 text-primary">BOE</span>' : '';
    const phone = emp.mobile
      ? '<a href="tel:' + escHtml(emp.mobile) + '" class="inline-flex items-center gap-1 text-primary hover:underline text-[11px] font-medium" onclick="event.stopPropagation()"><span class="material-symbols-outlined" style="font-size:11px">call</span>' + escHtml(emp.mobile) + '</a>'
      : '<span class="text-slate-400 text-[11px]">No phone</span>';
    return '<div class="flex items-center justify-between px-3 py-1.5 ' + bgClass + '">' +
      '<div class="flex items-center gap-1.5 min-w-0">' +
        '<span class="text-xs font-medium text-slate-800 dark:text-white truncate">' + escHtml(emp.name) + '</span>' +
        boeBadge +
      '</div>' +
      '<div class="flex-shrink-0 ml-2">' + phone + '</div>' +
    '</div>';
  }

  function renderBranchCard(b) {
    const lastStr = b.lastUpdate
      ? '<span class="text-slate-500 dark:text-slate-400">' + timeAgo(b.lastUpdate) + '</span>'
      : '<span class="text-slate-400">No updates</span>';
    const employeeRows = b.employees.length > 0
      ? b.employees.map(renderBranchEmpRow).join('')
      : '<div class="px-3 py-2 text-slate-400 text-xs text-center">No employees</div>';

    return '<div class="border-b border-slate-100 dark:border-slate-800 last:border-b-0">' +
      '<div class="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors select-none" onclick="toggleBranchContacts(this)">' +
        '<div class="size-7 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">' +
          '<span class="material-symbols-outlined text-primary text-sm">location_on</span>' +
        '</div>' +
        '<div class="flex-1 min-w-0">' +
          '<span class="text-xs font-bold text-slate-800 dark:text-white truncate block">' + escHtml(b.branch) + '</span>' +
          '<span class="text-[11px] block mt-0.5">' + lastStr + '</span>' +
        '</div>' +
        '<div class="flex items-center gap-1 flex-shrink-0">' +
          '<span class="text-[10px] text-slate-400">' + b.employees.length + '</span>' +
          '<span class="material-symbols-outlined text-slate-400 text-sm branch-chevron transition-transform duration-200">expand_more</span>' +
        '</div>' +
      '</div>' +
      '<div class="branch-contacts hidden divide-y divide-slate-50 dark:divide-slate-800 bg-slate-50/50 dark:bg-slate-800/20">' +
        employeeRows +
      '</div>' +
    '</div>';
  }

  function renderBucketColumn(bk) {
    const c = colorMap[bk.color];
    return '<div class="flex flex-col">' +
      '<div class="flex items-center gap-2 mb-3 px-1">' +
        '<span class="size-2 rounded-full ' + c.dot + '"></span>' +
        '<h3 class="text-xs font-bold uppercase tracking-wider ' + c.text + '">' + bk.label + '</h3>' +
        '<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-full ' + c.bg + ' ' + c.text + '">' + bk.branches.length + '</span>' +
      '</div>' +
      '<div class="bg-white dark:bg-[#1c2631] rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden flex-1">' +
        bk.branches.map(renderBranchCard).join('') +
      '</div>' +
    '</div>';
  }

  listEl.innerHTML = '<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">' +
    activeBuckets.map(renderBucketColumn).join('') +
  '</div>';
}

// Branch mapping: Region → District → BranchName (from master data)
const BRANCH_REGION_MAP = [
  {r:"ANDRA PRADESH",d:"KADAPA",b:"BUDWAL"},{r:"ANDRA PRADESH",d:"KADAPA",b:"DHARMAVARAM"},{r:"ANDRA PRADESH",d:"KADAPA",b:"KADAPA"},{r:"ANDRA PRADESH",d:"KADAPA",b:"KADIRI"},
  {r:"DHARWAD",d:"BADAMI",b:"BADAMI"},{r:"DHARWAD",d:"BADAMI",b:"GAJENDRAGAD"},{r:"DHARWAD",d:"BADAMI",b:"NARAGUNDA"},{r:"DHARWAD",d:"BADAMI",b:"RAMDURGA"},
  {r:"DHARWAD",d:"BALLARI",b:"BALLARI"},{r:"DHARWAD",d:"BALLARI",b:"KUDATHINI"},{r:"DHARWAD",d:"BALLARI",b:"SANDURU"},{r:"DHARWAD",d:"BALLARI",b:"SIRUGUPPA"},
  {r:"DHARWAD",d:"BELAGAVI",b:"BAILHONGAL"},{r:"DHARWAD",d:"BELAGAVI",b:"BELAGAVI"},{r:"DHARWAD",d:"BELAGAVI",b:"GOKAK"},{r:"DHARWAD",d:"BELAGAVI",b:"KITTUR"},{r:"DHARWAD",d:"BELAGAVI",b:"YARAGATTI"},
  {r:"DHARWAD",d:"CHIKKODI",b:"ATHANI"},{r:"DHARWAD",d:"CHIKKODI",b:"CHIKKODI"},{r:"DHARWAD",d:"CHIKKODI",b:"MUDALAGI"},{r:"DHARWAD",d:"CHIKKODI",b:"NIPPANI"},
  {r:"DHARWAD",d:"DAVANAGERE",b:"DAVANAGERE"},{r:"DHARWAD",d:"DAVANAGERE",b:"HARIHARA"},{r:"DHARWAD",d:"DAVANAGERE",b:"HONNALI"},{r:"DHARWAD",d:"DAVANAGERE",b:"SANTHEBENNURU"},
  {r:"DHARWAD",d:"DHARWAD",b:"DHARWAD"},{r:"DHARWAD",d:"DHARWAD",b:"HUBLI"},{r:"DHARWAD",d:"DHARWAD",b:"HUBLI-2"},{r:"DHARWAD",d:"DHARWAD",b:"KALGHATGI"},
  {r:"DHARWAD",d:"GADAG",b:"GADAG"},{r:"DHARWAD",d:"GADAG",b:"LAXMESHWAR"},{r:"DHARWAD",d:"GADAG",b:"MUNDARAGI"},
  {r:"DHARWAD",d:"KUDLIGI",b:"HARAPANAHALLI"},{r:"DHARWAD",d:"KUDLIGI",b:"KHANAHOSAHALLI"},{r:"DHARWAD",d:"KUDLIGI",b:"KOTTURU"},{r:"DHARWAD",d:"KUDLIGI",b:"KUDLIGI"},
  {r:"DHARWAD",d:"VIJAYANAGARA",b:"HAGARIBOMMANAHALLI"},{r:"DHARWAD",d:"VIJAYANAGARA",b:"HOSPET"},{r:"DHARWAD",d:"VIJAYANAGARA",b:"HUVENAHADAGALLI"},
  {r:"KALABURAGI",d:"BAGALKOTE",b:"BAGALKOT"},
  {r:"KALABURAGI",d:"BIDAR",b:"AURAD"},{r:"KALABURAGI",d:"BIDAR",b:"BHALKI"},{r:"KALABURAGI",d:"BIDAR",b:"BIDAR"},{r:"KALABURAGI",d:"BIDAR",b:"BIDAR-2"},
  {r:"KALABURAGI",d:"HUMNABAD",b:"BASAVAKALYAN"},{r:"KALABURAGI",d:"HUMNABAD",b:"HULSOOR"},{r:"KALABURAGI",d:"HUMNABAD",b:"HUMNABAD"},{r:"KALABURAGI",d:"HUMNABAD",b:"KAMALAPURA"},
  {r:"KALABURAGI",d:"INDI",b:"AFZALPUR"},{r:"KALABURAGI",d:"INDI",b:"ALMEL"},{r:"KALABURAGI",d:"INDI",b:"CHADCHAN"},{r:"KALABURAGI",d:"INDI",b:"INDI"},
  {r:"KALABURAGI",d:"KALBURGI",b:"ALAND"},{r:"KALABURAGI",d:"KALBURGI",b:"JEVARGI"},{r:"KALABURAGI",d:"KALBURGI",b:"KALABURAGI"},{r:"KALABURAGI",d:"KALBURGI",b:"KALBURGI-2"},
  {r:"KALABURAGI",d:"KUSHTAGI",b:"GANGAVATHI"},{r:"KALABURAGI",d:"KUSHTAGI",b:"HUNGUND"},{r:"KALABURAGI",d:"KUSHTAGI",b:"KOPPAL"},{r:"KALABURAGI",d:"KUSHTAGI",b:"KUSHTAGI"},
  {r:"KALABURAGI",d:"LINGSUGUR",b:"DEVADURGA"},{r:"KALABURAGI",d:"LINGSUGUR",b:"LINGSUGUR"},{r:"KALABURAGI",d:"LINGSUGUR",b:"MANVI"},{r:"KALABURAGI",d:"LINGSUGUR",b:"RAICHUR"},{r:"KALABURAGI",d:"LINGSUGUR",b:"SINDHNUR"},{r:"KALABURAGI",d:"LINGSUGUR",b:"SIRWAR"},
  {r:"KALABURAGI",d:"SEDAM",b:"CHINCHOLI"},{r:"KALABURAGI",d:"SEDAM",b:"KALAGI"},{r:"KALABURAGI",d:"SEDAM",b:"SEDAM"},{r:"KALABURAGI",d:"SEDAM",b:"SHAHAPUR"},{r:"KALABURAGI",d:"SEDAM",b:"YADGIR"},
  {r:"KALABURAGI",d:"VIJAYAPURA",b:"BILAGI"},{r:"KALABURAGI",d:"VIJAYAPURA",b:"JAMAKHANDI"},{r:"KALABURAGI",d:"VIJAYAPURA",b:"LOKAPUR"},{r:"KALABURAGI",d:"VIJAYAPURA",b:"MUDDEBIHAL"},{r:"KALABURAGI",d:"VIJAYAPURA",b:"SINDAGI"},{r:"KALABURAGI",d:"VIJAYAPURA",b:"TALIKOTI"},{r:"KALABURAGI",d:"VIJAYAPURA",b:"TIKOTA"},{r:"KALABURAGI",d:"VIJAYAPURA",b:"VIJAYAPUR"},
  {r:"TELANGANA",d:"MAHABOOBNAGAR",b:"GADWAL"},{r:"TELANGANA",d:"MAHABOOBNAGAR",b:"MAHABUB NAGAR"},{r:"TELANGANA",d:"MAHABOOBNAGAR",b:"MARIKAL"},{r:"TELANGANA",d:"MAHABOOBNAGAR",b:"TANDUR"},
  {r:"TELANGANA",d:"SANGAREDDY",b:"KODANGAL"},{r:"TELANGANA",d:"SANGAREDDY",b:"NARAYANKHED"},{r:"TELANGANA",d:"SANGAREDDY",b:"SANGAREDDY"},{r:"TELANGANA",d:"SANGAREDDY",b:"ZAHEERABAD"},
  {r:"TUMKUR",d:"BENGALORE -RURAL",b:"DABUSPET"},{r:"TUMKUR",d:"BENGALORE -RURAL",b:"DODDABALLAPURA"},{r:"TUMKUR",d:"BENGALORE -RURAL",b:"GOWRIBIDANUR"},
  {r:"TUMKUR",d:"BENGALORE -URBAN",b:"CHANDAPURA"},{r:"TUMKUR",d:"BENGALORE -URBAN",b:"HEBBAL"},{r:"TUMKUR",d:"BENGALORE -URBAN",b:"J P NAGAR"},{r:"TUMKUR",d:"BENGALORE -URBAN",b:"KENGERI"},
  {r:"TUMKUR",d:"CHIKKABALLAPUR",b:"BAGEPALLI"},{r:"TUMKUR",d:"CHIKKABALLAPUR",b:"CHIKBALLAPURA"},{r:"TUMKUR",d:"CHIKKABALLAPUR",b:"CHINTAMANI"},{r:"TUMKUR",d:"CHIKKABALLAPUR",b:"DEVANAHALLI"},{r:"TUMKUR",d:"CHIKKABALLAPUR",b:"SRINIVASPURA"},
  {r:"TUMKUR",d:"CHIKKAMAGALURU",b:"CHIKKAMAGALURU"},{r:"TUMKUR",d:"CHIKKAMAGALURU",b:"MUDIGERE"},{r:"TUMKUR",d:"CHIKKAMAGALURU",b:"NR PURA"},
  {r:"TUMKUR",d:"CHITRADURGA",b:"CHALLAKERE"},{r:"TUMKUR",d:"CHITRADURGA",b:"CHITRADURGA"},{r:"TUMKUR",d:"CHITRADURGA",b:"HIRIYUR"},{r:"TUMKUR",d:"CHITRADURGA",b:"JAGALORE"},
  {r:"TUMKUR",d:"HOLALKERE",b:"CHANNAGIRI"},{r:"TUMKUR",d:"HOLALKERE",b:"HOLAKERE"},{r:"TUMKUR",d:"HOLALKERE",b:"HOSADURGA"},
  {r:"TUMKUR",d:"KADUR",b:"AJJAMPURA"},{r:"TUMKUR",d:"KADUR",b:"KADUR"},{r:"TUMKUR",d:"KADUR",b:"PANCHANHALLI"},{r:"TUMKUR",d:"KADUR",b:"TARIKERE"},
  {r:"TUMKUR",d:"KOLAR",b:"BANGARPET"},{r:"TUMKUR",d:"KOLAR",b:"BETHAMANGALA"},{r:"TUMKUR",d:"KOLAR",b:"KOLAR"},{r:"TUMKUR",d:"KOLAR",b:"MALUR"},
  {r:"TUMKUR",d:"TIPTUR",b:"CHIKKANAYAKANAHALLI"},{r:"TUMKUR",d:"TIPTUR",b:"GUBBI"},{r:"TUMKUR",d:"TIPTUR",b:"HULIYAR"},{r:"TUMKUR",d:"TIPTUR",b:"TIPTUR"},{r:"TUMKUR",d:"TIPTUR",b:"TUREVEKERE"},
  {r:"TUMKUR",d:"TUMKUR",b:"KORATAGERE"},{r:"TUMKUR",d:"TUMKUR",b:"KUNIGAL"},{r:"TUMKUR",d:"TUMKUR",b:"MADHUGIRI"},{r:"TUMKUR",d:"TUMKUR",b:"SIRA"},{r:"TUMKUR",d:"TUMKUR",b:"TUMKUR"},
];

// Build lookup: uppercase branch name → { region, district }
const BRANCH_LOOKUP = {};
BRANCH_REGION_MAP.forEach(m => { BRANCH_LOOKUP[m.b.toUpperCase()] = { region: m.r, district: m.d }; });

function getBranchMapping(branchName) {
  const key = (branchName || '').toUpperCase().trim();
  return BRANCH_LOOKUP[key] || { region: 'UNMAPPED', district: 'UNMAPPED' };
}

function downloadBranchesExcel() {
  const entries = adminData.entries;
  const employees = adminData.employees;
  const sourceFilter = document.getElementById('branches-source-filter')?.value || 'entries';

  // Get unique branches (exclude Head Office and Corporate Office)
  const branchesFromEntries = entries.map(e => e.location).filter(Boolean);
  const branchesFromEmployees = employees.map(e => e.location).filter(Boolean);
  const excludeLocations = ['Head Office', 'Corporate Office'];
  const allBranches = [...new Set([...branchesFromEntries, ...branchesFromEmployees])].filter(b => !excludeLocations.includes(b)).sort();

  const todayStr = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const daysAgo = d => Math.floor((now - new Date(d)) / 86400000);

  // Compute last update per branch with region/district mapping
  const branchData = allBranches.map(branch => {
    let lastUpdate = null;
    if (sourceFilter === 'entries' || sourceFilter === 'both') {
      const branchEntries = entries.filter(e => e.location === branch);
      const maxEntry = branchEntries.reduce((max, e) => { const d = new Date(e.created_at); return d > max ? d : max; }, new Date(0));
      if (branchEntries.length > 0 && maxEntry > new Date(0)) lastUpdate = maxEntry;
    }
    if (sourceFilter === 'received' || sourceFilter === 'both') {
      const rdLogs = (adminData.receivedDateLogs || []).filter(r => r.location === branch);
      const maxRd = rdLogs.reduce((max, r) => { const d = new Date(r.created_at); return d > max ? d : max; }, new Date(0));
      if (rdLogs.length > 0 && maxRd > new Date(0)) {
        if (!lastUpdate || maxRd > lastUpdate) lastUpdate = maxRd;
      }
    }
    const mapping = getBranchMapping(branch);
    let status = 'No Updates';
    if (lastUpdate) {
      const d = daysAgo(lastUpdate);
      if (d === 0) status = 'Updated Today';
      else if (d <= 5) status = 'Last 5 Days';
      else if (d <= 10) status = 'Last 10 Days';
      else status = '15+ Days Ago';
    }
    return { branch, lastUpdate, status, region: mapping.region, district: mapping.district };
  });

  // Sort: no updates first, then oldest first
  branchData.sort((a, b) => {
    if (!a.lastUpdate && !b.lastUpdate) return a.branch.localeCompare(b.branch);
    if (!a.lastUpdate) return -1;
    if (!b.lastUpdate) return 1;
    return a.lastUpdate - b.lastUpdate;
  });

  const bucketKeys = ['No Updates', '15+ Days Ago', 'Last 10 Days', 'Last 5 Days', 'Updated Today'];

  // --- Sheet 1: Overall (Sl.No + bucket columns with branch names) ---
  const buckets = { 'No Updates': [], '15+ Days Ago': [], 'Last 10 Days': [], 'Last 5 Days': [], 'Updated Today': [] };
  branchData.forEach(b => buckets[b.status].push(b.branch));

  const maxRows = Math.max(...Object.values(buckets).map(arr => arr.length), 1);
  const overallRows = [];
  for (let i = 0; i < maxRows; i++) {
    const row = { 'Sl.No': i + 1 };
    bucketKeys.forEach(k => { row[k] = buckets[k][i] || ''; });
    overallRows.push(row);
  }
  overallRows.push({ 'Sl.No': '', 'No Updates': 'Count: ' + buckets['No Updates'].length, '15+ Days Ago': 'Count: ' + buckets['15+ Days Ago'].length, 'Last 10 Days': 'Count: ' + buckets['Last 10 Days'].length, 'Last 5 Days': 'Count: ' + buckets['Last 5 Days'].length, 'Updated Today': 'Count: ' + buckets['Updated Today'].length });

  const wsOverall = XLSX.utils.json_to_sheet(overallRows);
  wsOverall['!cols'] = [{ wch: 6 }, { wch: 28 }, { wch: 28 }, { wch: 28 }, { wch: 28 }, { wch: 28 }];
  wsOverall['!views'] = [{ state: 'frozen', ySplit: 1 }];

  // --- Sheet 2: Region (bucket columns with branch names, grouped by region) ---
  const regionGroups = {};
  branchData.forEach(b => {
    if (!regionGroups[b.region]) regionGroups[b.region] = { 'No Updates': [], '15+ Days Ago': [], 'Last 10 Days': [], 'Last 5 Days': [], 'Updated Today': [] };
    regionGroups[b.region][b.status].push(b.branch);
  });

  const regionRows = [];
  let rSlNo = 1;
  Object.keys(regionGroups).sort().forEach(region => {
    const g = regionGroups[region];
    // Region header row (just the name)
    const row = { 'Sl.No': rSlNo++, 'Region': region };
    bucketKeys.forEach(k => { row[k] = ''; });
    regionRows.push(row);
    // Branch names listed directly below
    const maxR = Math.max(...bucketKeys.map(k => g[k].length), 0);
    for (let i = 0; i < maxR; i++) {
      const detail = { 'Sl.No': '', 'Region': '' };
      bucketKeys.forEach(k => { detail[k] = g[k][i] || ''; });
      regionRows.push(detail);
    }
  });

  const wsRegion = XLSX.utils.json_to_sheet(regionRows);
  wsRegion['!cols'] = [{ wch: 6 }, { wch: 20 }, { wch: 28 }, { wch: 28 }, { wch: 28 }, { wch: 28 }, { wch: 28 }];
  wsRegion['!views'] = [{ state: 'frozen', ySplit: 1 }];

  // --- Sheet 3: District (bucket columns with branch names, grouped by region > district) ---
  const districtGroups = {};
  branchData.forEach(b => {
    const key = b.region + '||' + b.district;
    if (!districtGroups[key]) districtGroups[key] = { region: b.region, district: b.district, 'No Updates': [], '15+ Days Ago': [], 'Last 10 Days': [], 'Last 5 Days': [], 'Updated Today': [] };
    districtGroups[key][b.status].push(b.branch);
  });

  const districtRows = [];
  let dSlNo = 1;
  Object.keys(districtGroups).sort().forEach(key => {
    const g = districtGroups[key];
    // District header row (just region + district name)
    const row = { 'Sl.No': dSlNo++, 'Region': g.region, 'District': g.district };
    bucketKeys.forEach(k => { row[k] = ''; });
    districtRows.push(row);
    // Branch names listed directly below
    const maxD = Math.max(...bucketKeys.map(k => g[k].length), 0);
    for (let i = 0; i < maxD; i++) {
      const detail = { 'Sl.No': '', 'Region': '', 'District': '' };
      bucketKeys.forEach(k => { detail[k] = g[k][i] || ''; });
      districtRows.push(detail);
    }
  });

  const wsDistrict = XLSX.utils.json_to_sheet(districtRows);
  wsDistrict['!cols'] = [{ wch: 6 }, { wch: 20 }, { wch: 22 }, { wch: 28 }, { wch: 28 }, { wch: 28 }, { wch: 28 }, { wch: 28 }];
  wsDistrict['!views'] = [{ state: 'frozen', ySplit: 1 }];

  // Build workbook with 3 sheets
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsOverall, 'Overall');
  XLSX.utils.book_append_sheet(wb, wsRegion, 'Region');
  XLSX.utils.book_append_sheet(wb, wsDistrict, 'District');
  XLSX.writeFile(wb, 'Branches_' + todayStr + '.xlsx');
}

function toggleBranchContacts(headerEl) {
  const contacts = headerEl.nextElementSibling;
  const chevron = headerEl.querySelector('.branch-chevron');
  const isOpen = !contacts.classList.contains('hidden');
  contacts.classList.toggle('hidden');
  if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
}

// --- NEW ENTRY STATE ---

let entryCart = {};       // maps itemId → selected quantity
let entryType = 'in';     // 'in' or 'out'
let activeCategory = 'All';
const CATEGORIES = ['All', 'Writing', 'Paper & Covers', 'Filing', 'Books & Registers', 'Desk Supplies', 'Tapes & Adhesives', 'Machines'];

// --- NAVIGATION ---

let currentPage = 'dashboard';

function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('[id^="page-"]').forEach(el => {
    if (el.id === 'page-content') return;
    el.classList.add('hidden');
  });
  const target = document.getElementById('page-' + page);
  if (target) target.classList.remove('hidden');

  // Update regular nav highlighting
  document.querySelectorAll('.nav-link').forEach(link => {
    if (link.dataset.page === page) {
      link.className = 'nav-link flex items-center gap-3 px-4 py-3 rounded-lg bg-primary/10 text-primary font-semibold';
    } else {
      link.className = 'nav-link flex items-center gap-3 px-4 py-3 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors';
    }
  });

  // Update admin nav highlighting (branchdetail/closingstock are sub-pages of admin)
  const adminPage = (page === 'branchdetail' || page === 'closingstock') ? 'admin' : page;
  document.querySelectorAll('.nav-link-admin').forEach(link => {
    if (link.dataset.page === adminPage) {
      link.className = 'nav-link-admin flex items-center gap-3 px-4 py-3 rounded-lg bg-primary/10 text-primary font-semibold';
    } else {
      link.className = 'nav-link-admin flex items-center gap-3 px-4 py-3 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors';
    }
  });

  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');

  renderPage(page);
}

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo(link.dataset.page);
  });
});

// --- RENDER FUNCTIONS ---

function renderPage(page) {
  switch (page) {
    case 'dashboard': renderDashboard(); break;
    case 'inventory': renderInventory(); break;
    case 'transactions': renderTransactions(); break;
    case 'suppliers': renderSuppliers(); break;
    case 'reports':
      if (isHeadOffice) { loadAdminData().then(() => renderReports()); }
      else { renderReports(); }
      break;
    case 'newentry': renderNewEntryPage(); break;
    case 'admin': renderAdminDashboard(); break;
    case 'editlog': renderEditLog(); break;
    case 'deletelog': renderDeleteLog(); break;
    case 'branches': loadAdminData().then(() => renderBranches()); break;
    case 'branchdetail': renderBranchDetail(); break;
    case 'closingstock': renderClosingStock(); break;
    case 'receiveddate': renderReceivedDate(); break;
  }
}

function renderDashboard() {
  // KPIs
  const totalQty = appData.inventory.reduce((sum, i) => sum + i.qty, 0);
  const lowStock = appData.inventory.filter(i => i.qty <= i.reorder).length;
  // FIX #5: Filter to current month only for Monthly KPI
  const kpiNow = new Date();
  const monthStart = new Date(kpiNow.getFullYear(), kpiNow.getMonth(), 1);
  const monthTxns = appData.transactions.filter(t => new Date(t.date) >= monthStart);
  const monthIn = monthTxns.filter(t => t.type === 'in').reduce((s, t) => s + t.qty, 0);
  const monthOut = monthTxns.filter(t => t.type === 'out').reduce((s, t) => s + t.qty, 0);

  document.getElementById('kpi-closing-stock').textContent = totalQty.toLocaleString() + ' Units';
  document.getElementById('kpi-low-stock').textContent = lowStock + ' Items';
  document.getElementById('kpi-stock-in').textContent = monthIn.toLocaleString() + ' Units';
  document.getElementById('kpi-stock-out').textContent = monthOut.toLocaleString() + ' Units';

  // Dynamic KPI percentage badges
  const now = new Date();
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  const prevTxns = appData.transactions.filter(t => {
    const d = new Date(t.date);
    return d >= prevMonthStart && d <= prevMonthEnd;
  });
  const prevIn = prevTxns.filter(t => t.type === 'in').reduce((s, t) => s + t.qty, 0);
  const prevOut = prevTxns.filter(t => t.type === 'out').reduce((s, t) => s + t.qty, 0);

  function setBadge(id, current, previous) {
    const el = document.getElementById(id);
    if (!el) return;
    if (previous === 0 && current === 0) { el.classList.add('hidden'); return; }
    if (previous === 0) { el.textContent = 'New'; el.className = 'text-xs font-semibold px-2 py-1 rounded text-blue-500 bg-blue-500/10'; el.classList.remove('hidden'); return; }
    const pct = ((current - previous) / previous * 100).toFixed(1);
    const isUp = current >= previous;
    el.textContent = (isUp ? '+' : '') + pct + '%';
    el.className = 'text-xs font-semibold px-2 py-1 rounded ' + (isUp ? 'text-green-500 bg-green-500/10' : 'text-red-500 bg-red-500/10');
    el.classList.remove('hidden');
  }

  setBadge('kpi-badge-in', monthIn, prevIn);
  setBadge('kpi-badge-out', monthOut, prevOut);

  // Low stock badge: show Critical if any low stock items, else hide
  const lowBadge = document.getElementById('kpi-badge-low');
  if (lowBadge) {
    if (lowStock > 0) {
      lowBadge.textContent = 'Critical';
      lowBadge.className = 'text-[10px] uppercase font-bold text-white bg-red-600 px-2 py-0.5 rounded-full animate-pulse';
      lowBadge.classList.remove('hidden');
    } else {
      lowBadge.classList.add('hidden');
    }
  }

  // Profile
  document.getElementById('profile-branch').textContent = appData.profile.branch;
  document.getElementById('profile-boe').textContent = appData.profile.boe;

  // Update profile card with logged-in user data
  if (currentEmployee) {
    const initials = currentEmployee.name ? currentEmployee.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2) : '??';
    const avatarEl = document.getElementById('profile-avatar');
    if (avatarEl) avatarEl.textContent = initials;
    const nameEl = document.getElementById('profile-name');
    if (nameEl) nameEl.textContent = currentEmployee.name || 'User';
    const roleEl = document.getElementById('profile-role');
    if (roleEl) roleEl.textContent = currentEmployee.role || 'Staff';
    const empIdEl = document.getElementById('profile-empid');
    if (empIdEl) empIdEl.textContent = currentEmployee.emp_id || '--';

    // Fetch team size from Supabase
    if (selectedLocation) {
      supabaseFetch('employees', 'select=id&location=eq.' + encodeURIComponent(selectedLocation))
        .then(team => {
          const sizeEl = document.getElementById('profile-team-size');
          if (sizeEl) sizeEl.textContent = team.length + ' Members';
        }).catch(() => {});
    }
  }

  // Recent movements (last 5)
  const recent = [...appData.transactions].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
  if (recent.length === 0) {
    document.getElementById('movements-table').innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center"><div class="flex flex-col items-center text-slate-400 dark:text-slate-500"><span class="material-symbols-outlined text-5xl mb-3">swap_horiz</span><p class="text-sm font-medium">No recent movements</p></div></td></tr>`;
  } else {
    document.getElementById('movements-table').innerHTML = recent.map(t => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
        <td class="px-6 py-4">
          <div class="flex flex-col">
            <span class="font-medium text-slate-800 dark:text-slate-200">${escHtml(t.itemName)}</span>
            <span class="text-xs text-slate-400">${escHtml(t.sku)}</span>
          </div>
        </td>
        <td class="px-6 py-4">
          <div class="flex items-center gap-1.5 flex-wrap">
            ${t.type === 'in'
              ? '<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-full text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><span class="material-symbols-outlined text-[14px]">arrow_downward</span>Stock In</span>'
              : '<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400"><span class="material-symbols-outlined text-[14px]">arrow_upward</span>Stock Out</span>'
            }
            ${t.isEdited ? '<span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">EDITED</span>' : ''}
          </div>
        </td>
        <td class="px-6 py-4 font-semibold text-slate-700 dark:text-slate-300">${t.type === 'in' ? '+' : '-'}${t.qty}</td>
        <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${formatDate(t.date)}</td>
        <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${escHtml(t.user)}</td>
        <td class="px-6 py-4">
          <div class="flex items-center gap-1">
            <button onclick="openTxnEditModal(${t.id})" class="p-1.5 text-slate-400 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"><span class="material-symbols-outlined text-base">edit</span></button>
            <button onclick="deleteTxn(${t.id})" class="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
        </td>
      </tr>
    `).join('');
  }

  // Team grid — fetch real employees from same location via Supabase
  const teamGrid = document.getElementById('team-grid');
  const teamAvatars = document.getElementById('team-avatars');
  if (selectedLocation) {
    teamGrid.innerHTML = '<div class="col-span-full p-6 text-center text-slate-400 dark:text-slate-500 text-sm">Loading team...</div>';
    const TEAM_COLORS = ['from-primary to-blue-400','from-emerald-500 to-teal-400','from-violet-500 to-purple-400','from-amber-500 to-orange-400','from-rose-500 to-pink-400','from-cyan-500 to-sky-400','from-indigo-500 to-blue-400','from-lime-500 to-green-400'];
    supabaseFetch('employees', 'select=*&location=eq.' + encodeURIComponent(selectedLocation) + '&order=name.asc')
      .then(members => {
        if (!members.length) {
          teamGrid.innerHTML = '<div class="col-span-full p-6 text-center text-slate-400 dark:text-slate-500 text-sm">No team members found</div>';
          teamAvatars.innerHTML = '';
          return;
        }
        teamGrid.innerHTML = members.map((m, i) => {
          const initials = m.name ? m.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2) : '??';
          const color = TEAM_COLORS[i % TEAM_COLORS.length];
          const memberData = encodeURIComponent(JSON.stringify(m));
          return `<div onclick="showTeamMemberModal(decodeURIComponent('${memberData}'), '${color}')" class="bg-white dark:bg-[#1c2631] p-6 flex items-center gap-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
            <div class="size-12 rounded-full bg-gradient-to-br ${color} flex items-center justify-center text-white font-bold text-sm flex-shrink-0">${initials}</div>
            <div class="min-w-0 flex-1">
              <p class="font-semibold text-slate-800 dark:text-white truncate">${escHtml(m.name)}</p>
              <p class="text-xs text-slate-500 dark:text-slate-400">${escHtml(m.role)}</p>
            </div>
            <span class="material-symbols-outlined text-slate-300 dark:text-slate-600 text-base">chevron_right</span>
          </div>`;
        }).join('');
        teamAvatars.innerHTML = members.map((m, i) => {
          const initials = m.name ? m.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2) : '??';
          const color = TEAM_COLORS[i % TEAM_COLORS.length];
          return `<div class="size-8 rounded-full bg-gradient-to-br ${color} flex items-center justify-center text-white text-[10px] font-bold border-2 border-white dark:border-[#161e27]" title="${escHtml(m.name)}">${initials}</div>`;
        }).join('');
        const teamCountLabel = document.getElementById('team-count-label');
        if (teamCountLabel) teamCountLabel.textContent = 'Team (' + members.length + ')';
      }).catch(() => {
        teamGrid.innerHTML = '<div class="col-span-full p-6 text-center text-red-400 text-sm">Failed to load team</div>';
      });
  } else {
    teamGrid.innerHTML = '<div class="col-span-full p-6 text-center text-slate-400 dark:text-slate-500 text-sm">Log in to see team members</div>';
    teamAvatars.innerHTML = '';
  }
}

function renderInventory() {
  const items = appData.inventory;
  if (items.length === 0) {
    document.getElementById('inventory-table').innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center"><div class="flex flex-col items-center text-slate-400 dark:text-slate-500"><span class="material-symbols-outlined text-5xl mb-3">inventory_2</span><p class="text-sm font-medium">No inventory items yet</p></div></td></tr>`;
    return;
  }
  document.getElementById('inventory-table').innerHTML = items.map(item => {
    let status, statusClass;
    if (item.qty <= 0) {
      status = 'Out of Stock'; statusClass = 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
    } else if (item.qty <= item.reorder) {
      status = 'Low Stock'; statusClass = 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
    } else {
      status = 'In Stock'; statusClass = 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    }
    return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
        <td class="px-6 py-4 font-medium text-slate-800 dark:text-slate-200">${escHtml(item.name)}</td>
        <td class="px-6 py-4 text-slate-500 dark:text-slate-400 font-mono text-xs">${escHtml(item.sku)}</td>
        <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${escHtml(item.category)}</td>
        <td class="px-6 py-4 font-semibold text-slate-700 dark:text-slate-300">${item.qty.toLocaleString()} ${escHtml(item.unit || 'No')}</td>
        <td class="px-6 py-4"><span class="py-1 px-2.5 rounded-full text-xs font-semibold ${statusClass}">${status}</span></td>
        <td class="px-6 py-4">
          <div class="flex items-center gap-2">
            <button onclick="openModal('edit', ${item.id})" class="p-1.5 text-slate-400 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"><span class="material-symbols-outlined text-base">edit</span></button>
            <button onclick="deleteItem(${item.id})" class="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderTransactions() {
  const txns = [...appData.transactions].sort((a, b) => new Date(b.date) - new Date(a.date));
  if (txns.length === 0) {
    document.getElementById('transactions-table').innerHTML = `<tr><td colspan="6" class="px-6 py-16 text-center"><div class="flex flex-col items-center text-slate-400 dark:text-slate-500"><span class="material-symbols-outlined text-5xl mb-3">swap_horiz</span><p class="text-sm font-medium">No transactions yet</p></div></td></tr>`;
    return;
  }
  document.getElementById('transactions-table').innerHTML = txns.map(t => `
    <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
      <td class="px-6 py-4">
        <div class="flex flex-col">
          <span class="font-medium text-slate-800 dark:text-slate-200">${escHtml(t.itemName)}</span>
          <span class="text-xs text-slate-400">${escHtml(t.sku)}</span>
        </div>
      </td>
      <td class="px-6 py-4">
        <div class="flex items-center gap-1.5 flex-wrap">
          ${t.type === 'in'
            ? '<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-full text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><span class="material-symbols-outlined text-[14px]">arrow_downward</span>Stock In</span>'
            : '<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400"><span class="material-symbols-outlined text-[14px]">arrow_upward</span>Stock Out</span>'
          }
          ${t.isEdited ? '<span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">EDITED</span>' : ''}
        </div>
      </td>
      <td class="px-6 py-4 font-semibold text-slate-700 dark:text-slate-300">${t.type === 'in' ? '+' : '-'}${t.qty}</td>
      <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${formatDate(t.date)}</td>
      <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${escHtml(t.user)}</td>
      <td class="px-6 py-4">
        <div class="flex items-center gap-1">
          <button onclick="openTxnEditModal(${t.id})" class="p-1.5 text-slate-400 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"><span class="material-symbols-outlined text-base">edit</span></button>
          <button onclick="deleteTxn(${t.id})" class="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"><span class="material-symbols-outlined text-base">delete</span></button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderSuppliers() {
  if (appData.suppliers.length === 0) {
    document.getElementById('suppliers-grid').innerHTML = `
      <div class="col-span-full flex flex-col items-center justify-center py-16 text-slate-400 dark:text-slate-500">
        <span class="material-symbols-outlined text-5xl mb-3">local_shipping</span>
        <p class="text-sm font-medium">No suppliers added yet</p>
      </div>`;
    return;
  }
  document.getElementById('suppliers-grid').innerHTML = appData.suppliers.map(s => `
    <div class="bg-white dark:bg-[#1c2631] p-6 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
      <div class="flex items-center justify-between mb-4">
        <span class="p-2 bg-primary/10 text-primary rounded-lg">
          <span class="material-symbols-outlined">local_shipping</span>
        </span>
        <span class="py-1 px-2.5 rounded-full text-xs font-semibold ${s.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}">${s.status === 'active' ? 'Active' : 'Inactive'}</span>
      </div>
      <h4 class="font-bold text-slate-800 dark:text-white mb-1">${escHtml(s.name)}</h4>
      <p class="text-sm text-slate-500 dark:text-slate-400 mb-3">${escHtml(s.items)}</p>
      <div class="space-y-1 text-sm">
        <div class="flex items-center gap-2 text-slate-500 dark:text-slate-400">
          <span class="material-symbols-outlined text-base">person</span>
          ${escHtml(s.contact)}
        </div>
        <div class="flex items-center gap-2 text-slate-500 dark:text-slate-400">
          <span class="material-symbols-outlined text-base">phone</span>
          ${escHtml(s.phone)}
        </div>
      </div>
    </div>
  `).join('');
}

function renderReports() {
  const now = new Date();
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // --- Admin branch filter ---
  const branchFilterEl = document.getElementById('report-branch-filter');
  const branchPicker = document.getElementById('report-branch-picker');
  const outOfStockBtn = document.getElementById('reports-out-of-stock-btn');

  let inv, txns;

  if (isHeadOffice) {
    // Show branch filter and populate options
    if (branchFilterEl) branchFilterEl.classList.remove('hidden');
    if (outOfStockBtn) outOfStockBtn.style.display = 'flex';

    const allEntries = adminData.entries;
    const allEmployees = adminData.employees;
    const branchesFromEntries = allEntries.map(e => e.location).filter(Boolean);
    const branchesFromEmployees = allEmployees.map(e => e.location).filter(Boolean);
    const allBranches = [...new Set([...branchesFromEntries, ...branchesFromEmployees])].filter(b => b !== 'Head Office').sort();

    // Populate branch picker (preserve current selection)
    if (branchPicker) {
      const currentVal = branchPicker.value;
      branchPicker.innerHTML = '<option value="all">All Branches</option>' +
        allBranches.map(b => `<option value="${escHtml(b)}">${escHtml(b)}</option>`).join('');
      if (currentVal && (currentVal === 'all' || allBranches.includes(currentVal))) {
        branchPicker.value = currentVal;
      }
    }

    const selectedBranchReport = branchPicker ? branchPicker.value : 'all';
    const filteredEntries = selectedBranchReport === 'all'
      ? allEntries
      : allEntries.filter(e => e.location === selectedBranchReport);

    // Build inventory from filtered entries
    inv = DEFAULT_INVENTORY.map(item => {
      let qty = 0;
      filteredEntries.forEach(e => {
        if (e.item_name === item.name) {
          if (e.entry_type === 'in') qty += e.quantity;
          else qty = Math.max(0, qty - e.quantity);
        }
      });
      return { ...item, qty };
    });

    // Build transactions from filtered entries
    txns = filteredEntries.map(e => ({
      id: e.id,
      itemName: e.item_name,
      sku: e.hsn_code,
      type: e.entry_type,
      qty: e.quantity,
      date: e.created_at,
      user: e.emp_name,
      location: e.location,
    }));
  } else {
    // Regular BOE mode
    if (branchFilterEl) branchFilterEl.classList.add('hidden');
    if (outOfStockBtn) outOfStockBtn.style.display = 'none';
    inv = appData.inventory;
    txns = appData.transactions;
  }

  // --- Read picker values or default to today / current month ---
  const datePicker = document.getElementById('report-date-picker');
  const monthPicker = document.getElementById('report-month-picker');

  // Default picker values on first render (use local date, not UTC)
  const localDateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const localMonthStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  if (datePicker && !datePicker.value) datePicker.value = localDateStr;
  if (monthPicker && !monthPicker.value) monthPicker.value = localMonthStr;

  const selectedDateStr = datePicker ? datePicker.value : localDateStr;
  const selectedMonthStr = monthPicker ? monthPicker.value : localMonthStr;

  // Parse selected date
  const selectedDate = new Date(selectedDateStr + 'T00:00:00');
  const selectedDateFormatted = `${dayNames[selectedDate.getDay()]}, ${selectedDate.getDate()} ${monthNames[selectedDate.getMonth()].slice(0,3)} ${selectedDate.getFullYear()}`;

  // Parse selected month
  const [selYear, selMonth] = selectedMonthStr.split('-').map(Number);
  const monthStart = new Date(selYear, selMonth - 1, 1);
  const monthEnd = new Date(selYear, selMonth, 0, 23, 59, 59, 999); // last day of month
  const selectedMonthName = monthNames[selMonth - 1];
  const daysInMonth = monthEnd.getDate();

  // --- Date report: transactions on selected date ---
  const dateTxns = txns.filter(t => {
    const d = new Date(t.date);
    const local = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return local === selectedDateStr;
  });
  const dateIn = dateTxns.filter(t => t.type === 'in');
  const dateOut = dateTxns.filter(t => t.type === 'out');
  const dateInQty = dateIn.reduce((s, t) => s + t.qty, 0);
  const dateOutQty = dateOut.reduce((s, t) => s + t.qty, 0);

  // --- Month report: transactions in selected month ---
  const monthTxns = txns.filter(t => {
    const d = new Date(t.date);
    return d >= monthStart && d <= monthEnd;
  });
  const monthIn = monthTxns.filter(t => t.type === 'in');
  const monthOut = monthTxns.filter(t => t.type === 'out');
  const monthInQty = monthIn.reduce((s, t) => s + t.qty, 0);
  const monthOutQty = monthOut.reduce((s, t) => s + t.qty, 0);

  // Closing stock (always current)
  const closingStock = inv.reduce((s, i) => s + i.qty, 0);
  const lowStockCount = inv.filter(i => i.qty <= i.reorder).length;

  function buildRow(label, value, accent) {
    const valClass = accent === 'green' ? 'text-green-500' : accent === 'red' ? 'text-red-500' : 'font-bold text-slate-800 dark:text-white';
    return `
      <div class="flex justify-between items-center py-3 border-b border-slate-100 dark:border-slate-800 last:border-b-0">
        <span class="text-sm text-slate-500 dark:text-slate-400">${label}</span>
        <span class="font-bold ${valClass}">${value}</span>
      </div>`;
  }

  function buildTxnList(list) {
    if (list.length === 0) return '<p class="text-sm text-slate-400 dark:text-slate-500 py-2 text-center">No transactions</p>';
    return list.map(t => `
      <div class="flex items-center justify-between py-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="material-symbols-outlined text-sm ${t.type === 'in' ? 'text-green-500' : 'text-red-400'}">${t.type === 'in' ? 'arrow_downward' : 'arrow_upward'}</span>
          <span class="text-sm text-slate-700 dark:text-slate-300 truncate">${escHtml(t.itemName)}${t.location ? ' <span class="text-slate-400 dark:text-slate-500 cursor-pointer hover:text-primary hover:underline" onclick="filterReportByBranch(\'' + escHtml(t.location).replace(/'/g, "\\'") + '\')">(' + escHtml(t.location) + ')</span>' : ''}</span>
        </div>
        <span class="text-sm font-semibold ${t.type === 'in' ? 'text-green-500' : 'text-red-400'} flex-shrink-0 ml-3">${t.type === 'in' ? '+' : '-'}${t.qty}</span>
      </div>
    `).join('');
  }

  let html = '';

  // --- Column 1: Date Report ---
  html += `
    <div id="report-today" class="bg-white dark:bg-[#1c2631] rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      <div class="p-6 border-b border-slate-200 dark:border-slate-800">
        <div class="flex items-center gap-3 mb-1">
          <span class="p-2 bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 rounded-lg">
            <span class="material-symbols-outlined">today</span>
          </span>
          <div>
            <h4 class="text-lg font-bold text-slate-800 dark:text-white">Daily Report</h4>
            <p class="text-xs text-slate-500 dark:text-slate-400">${selectedDateFormatted}</p>
          </div>
        </div>
      </div>
      <div class="p-6 space-y-0">
        ${buildRow('Total Transactions', dateTxns.length)}
        ${buildRow('Stock In (entries)', dateIn.length)}
        ${buildRow('Stock In (qty)', '+' + dateInQty.toLocaleString() + ' units', 'green')}
        ${buildRow('Stock Out (entries)', dateOut.length)}
        ${buildRow('Stock Out (qty)', '-' + dateOutQty.toLocaleString() + ' units', 'red')}
        ${buildRow('Net Movement', (dateInQty - dateOutQty >= 0 ? '+' : '') + (dateInQty - dateOutQty).toLocaleString() + ' units')}
      </div>
      <div class="px-6 pb-2">
        <p class="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2">Activity</p>
      </div>
      <div class="px-6 pb-6 max-h-48 overflow-y-auto">
        ${buildTxnList(dateTxns)}
      </div>
    </div>
  `;

  // --- Column 2: Monthly Report ---
  html += `
    <div id="report-mtd" class="bg-white dark:bg-[#1c2631] rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      <div class="p-6 border-b border-slate-200 dark:border-slate-800">
        <div class="flex items-center gap-3 mb-1">
          <span class="p-2 bg-primary/10 text-primary rounded-lg">
            <span class="material-symbols-outlined">date_range</span>
          </span>
          <div>
            <h4 class="text-lg font-bold text-slate-800 dark:text-white">Monthly Report</h4>
            <p class="text-xs text-slate-500 dark:text-slate-400">1 – ${daysInMonth} ${selectedMonthName.slice(0,3)} ${selYear}</p>
          </div>
        </div>
      </div>
      <div class="p-6 space-y-0">
        ${buildRow('Total Transactions', monthTxns.length)}
        ${buildRow('Stock In (entries)', monthIn.length)}
        ${buildRow('Stock In (qty)', '+' + monthInQty.toLocaleString() + ' units', 'green')}
        ${buildRow('Stock Out (entries)', monthOut.length)}
        ${buildRow('Stock Out (qty)', '-' + monthOutQty.toLocaleString() + ' units', 'red')}
        ${buildRow('Net Movement', (monthInQty - monthOutQty >= 0 ? '+' : '') + (monthInQty - monthOutQty).toLocaleString() + ' units')}
        ${buildRow('Closing Stock', closingStock.toLocaleString() + ' units')}
        ${buildRow('Low Stock Items', lowStockCount, lowStockCount > 0 ? 'red' : '')}
      </div>
      <div class="px-6 pb-2">
        <p class="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2">Monthly Activity</p>
      </div>
      <div class="px-6 pb-6 max-h-48 overflow-y-auto">
        ${buildTxnList(monthTxns)}
      </div>
    </div>
  `;

  document.getElementById('reports-content').innerHTML = html;
}

function filterReportByBranch(branch) {
  const picker = document.getElementById('report-branch-picker');
  if (picker) {
    picker.value = picker.value === branch ? 'all' : branch;
    renderReports();
  }
}

// --- KPI CLICK HANDLERS ---

function kpiClickClosingStock() {
  navigateTo('inventory');
}

function kpiClickLowStock() {
  navigateTo('inventory');
  const lowItems = appData.inventory.filter(i => i.qty <= i.reorder);
  renderFilteredInventory(lowItems);
  // Update header to indicate filter
  const header = document.querySelector('#page-inventory > div:first-child h2');
  if (header) header.textContent = 'Low Stock Items';
  const sub = document.querySelector('#page-inventory > div:first-child p');
  if (sub) sub.textContent = lowItems.length + ' items at or below reorder level';
}

function kpiClickStockIn() {
  navigateTo('transactions');
  const inTxns = appData.transactions.filter(t => t.type === 'in');
  renderFilteredTransactions(inTxns);
  const header = document.querySelector('#page-transactions > div:first-child h2');
  if (header) header.textContent = 'Stock In Transactions';
  const sub = document.querySelector('#page-transactions > div:first-child p');
  if (sub) sub.textContent = inTxns.length + ' stock in entries';
}

function kpiClickStockOut() {
  navigateTo('transactions');
  const outTxns = appData.transactions.filter(t => t.type === 'out');
  renderFilteredTransactions(outTxns);
  const header = document.querySelector('#page-transactions > div:first-child h2');
  if (header) header.textContent = 'Stock Out Transactions';
  const sub = document.querySelector('#page-transactions > div:first-child p');
  if (sub) sub.textContent = outTxns.length + ' stock out entries';
}

function renderFilteredTransactions(txns) {
  const sorted = [...txns].sort((a, b) => new Date(b.date) - new Date(a.date));
  document.getElementById('transactions-table').innerHTML = sorted.map(t => `
    <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
      <td class="px-6 py-4">
        <div class="flex flex-col">
          <span class="font-medium text-slate-800 dark:text-slate-200">${escHtml(t.itemName)}</span>
          <span class="text-xs text-slate-400">${escHtml(t.sku)}</span>
        </div>
      </td>
      <td class="px-6 py-4">
        ${t.type === 'in'
          ? '<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-full text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"><span class="material-symbols-outlined text-[14px]">arrow_downward</span>Stock In</span>'
          : '<span class="inline-flex items-center gap-1.5 py-1 px-2.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400"><span class="material-symbols-outlined text-[14px]">arrow_upward</span>Stock Out</span>'
        }
      </td>
      <td class="px-6 py-4 font-semibold text-slate-700 dark:text-slate-300">${t.type === 'in' ? '+' : '-'}${t.qty}</td>
      <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${formatDate(t.date)}</td>
      <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${escHtml(t.user)}</td>
      <td class="px-6 py-4">
        <div class="flex items-center gap-1">
          <button onclick="openTxnEditModal(${t.id})" class="p-1.5 text-slate-400 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"><span class="material-symbols-outlined text-base">edit</span></button>
          <button onclick="deleteTxn(${t.id})" class="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"><span class="material-symbols-outlined text-base">delete</span></button>
        </div>
      </td>
    </tr>
  `).join('');
}

// --- MODAL / CRUD ---

function openModal(mode, id) {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const form = document.getElementById('item-form');

  form.reset();
  document.getElementById('form-edit-id').value = '';

  if (mode === 'edit' && id) {
    const item = appData.inventory.find(i => i.id === id);
    if (!item) return;
    title.textContent = 'Edit Item';
    document.getElementById('form-name').value = item.name;
    document.getElementById('form-sku').value = item.sku;
    document.getElementById('form-category').value = item.category;
    document.getElementById('form-qty').value = item.qty;
    document.getElementById('form-reorder').value = item.reorder;
    document.getElementById('form-edit-id').value = item.id;
  } else {
    title.textContent = 'Add New Item';
  }

  overlay.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

document.getElementById('item-form').addEventListener('submit', function (e) {
  e.preventDefault();
  const editId = document.getElementById('form-edit-id').value;
  const item = {
    name: document.getElementById('form-name').value.trim(),
    sku: document.getElementById('form-sku').value.trim(),
    category: document.getElementById('form-category').value,
    qty: parseInt(document.getElementById('form-qty').value, 10),
    reorder: parseInt(document.getElementById('form-reorder').value, 10),
  };

  if (editId) {
    const idx = appData.inventory.findIndex(i => i.id === parseInt(editId, 10));
    if (idx !== -1) {
      appData.inventory[idx] = { ...appData.inventory[idx], ...item };
      showToast('Item updated successfully');
    }
  } else {
    item.id = Date.now();
    appData.inventory.push(item);
    showToast('Item added successfully');
  }

  saveData(appData);
  closeModal();
  renderPage(currentPage);
});

function deleteItem(id) {
  if (!confirm('Delete this item?')) return;
  appData.inventory = appData.inventory.filter(i => i.id !== id);
  saveData(appData);
  showToast('Item deleted', 'delete');
  renderPage(currentPage);
}

// --- DELETE TRANSACTION ---

async function deleteTxn(txnId) {
  if (!confirm('Delete this transaction?')) return;

  const txn = appData.transactions.find(t => t.id === txnId);

  try {
    // FIX #12: Delete first, then log — avoids phantom audit entries
    const res = await fetchWithRetry(SUPABASE_URL + '/rest/v1/stock_entries?id=eq.' + txnId, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + SUPABASE_ANON,
      },
    });
    if (!res.ok) throw new Error('Delete failed: ' + res.status);

    // Log deletion (best-effort, non-blocking)
    if (txn) {
      try {
        await supabaseInsert('deletion_log', [{
          stock_entry_id: txnId,
          item_name: txn.itemName,
          entry_type: txn.type,
          quantity: txn.qty,
          original_date: txn.date,
          emp_name: txn.user,
          deleted_by: currentEmployee ? currentEmployee.name : 'Unknown',
          employee_id: (currentEmployee && currentEmployee.id > 0) ? currentEmployee.id : null,
          branch: selectedLocation || null,
          deleted_at: new Date().toISOString(),
        }]);
      } catch (logErr) {
        console.error('Failed to log deletion:', logErr);
      }
    }

    showToast('Transaction deleted', 'delete');
    await loadFromSupabase();
    saveData(appData);
    renderPage(currentPage);
  } catch (err) {
    console.error('Failed to delete transaction:', err);
    showToast('Failed to delete transaction', 'delete');
  }
}

// --- TRANSACTION EDIT MODAL ---

function openTxnEditModal(txnId) {
  const txn = appData.transactions.find(t => t.id === txnId);
  if (!txn) return;

  const overlay = document.getElementById('txn-edit-modal-overlay');
  if (!overlay) return;

  document.getElementById('txn-edit-id').value = txn.id;
  document.getElementById('txn-edit-item').value = txn.itemName;
  document.getElementById('txn-edit-type').value = txn.type;
  document.getElementById('txn-edit-qty').value = txn.qty;

  overlay.classList.remove('hidden');
}

function closeTxnEditModal() {
  const overlay = document.getElementById('txn-edit-modal-overlay');
  if (overlay) overlay.classList.add('hidden');
}

async function saveTxnEdit(e) {
  e.preventDefault();

  const id = parseInt(document.getElementById('txn-edit-id').value, 10);
  const newType = document.getElementById('txn-edit-type').value;
  const newQty = parseInt(document.getElementById('txn-edit-qty').value, 10);

  if (!newQty || newQty <= 0) {
    showToast('Quantity must be greater than 0', 'delete');
    return;
  }

  // Capture old values before update
  const oldTxn = appData.transactions.find(t => t.id === id);
  if (!oldTxn) return;

  try {
    // Update the transaction + mark as edited
    await supabaseUpdate('stock_entries', id, {
      entry_type: newType,
      quantity: newQty,
      is_edited: true,
      edited_at: new Date().toISOString(),
    });

    // Insert edit log entry
    await supabaseInsert('edit_log', [{
      stock_entry_id: id,
      item_name: oldTxn.itemName,
      old_type: oldTxn.type,
      new_type: newType,
      old_qty: oldTxn.qty,
      new_qty: newQty,
      edited_by: currentEmployee ? currentEmployee.name : 'Unknown',
      employee_id: (currentEmployee && currentEmployee.id > 0) ? currentEmployee.id : null,
      branch: selectedLocation || null,
      edited_at: new Date().toISOString(),
    }]);

    showToast('Transaction updated successfully');
    closeTxnEditModal();

    // Reload from Supabase and re-render
    await loadFromSupabase();
    saveData(appData);
    renderPage(currentPage);
  } catch (err) {
    console.error('Failed to update transaction:', err);
    showToast('Failed to update transaction', 'delete');
  }
}

// --- HEADER BUTTONS ---

document.getElementById('new-entry-btn').addEventListener('click', () => {
  showEntryTypeModal();
});

function showEntryTypeModal() {
  document.getElementById('entry-type-modal-overlay').classList.remove('hidden');
}

function closeEntryTypeModal() {
  document.getElementById('entry-type-modal-overlay').classList.add('hidden');
}

function selectEntryType(type) {
  closeEntryTypeModal();
  navigateTo('newentry');
  setEntryType(type);
}

document.getElementById('notif-btn').addEventListener('click', () => {
  const panel = document.getElementById('notif-panel');
  panel.classList.toggle('hidden');
  renderNotifications();
});

function renderNotifications() {
  const list = document.getElementById('notif-list');
  if (appData.notifications.length === 0) {
    list.innerHTML = '<div class="p-4 text-sm text-slate-500 dark:text-slate-400 text-center">No notifications</div>';
    document.getElementById('notif-badge').classList.add('hidden');
    return;
  }
  document.getElementById('notif-badge').classList.remove('hidden');
  list.innerHTML = appData.notifications.map(n => `
    <div class="p-4 flex items-start gap-3">
      <span class="material-symbols-outlined text-base mt-0.5 ${n.type === 'alert' ? 'text-red-500' : 'text-primary'}">${n.type === 'alert' ? 'error' : 'info'}</span>
      <div class="min-w-0">
        <p class="text-sm text-slate-700 dark:text-slate-300">${escHtml(n.text)}</p>
        <p class="text-xs text-slate-400 mt-1">${escHtml(n.time)}</p>
      </div>
    </div>
  `).join('');
}

function clearNotifications() {
  appData.notifications = [];
  saveData(appData);
  renderNotifications();
}

// Close notif panel on outside click
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notif-panel');
  const btn = document.getElementById('notif-btn');
  if (!panel.contains(e.target) && !btn.contains(e.target)) {
    panel.classList.add('hidden');
  }
});

// --- SEARCH ---

document.getElementById('search-input').addEventListener('input', function () {
  const q = this.value.toLowerCase().trim();
  if (!q) {
    renderPage(currentPage);
    return;
  }
  // Search inventory and navigate there
  if (currentPage !== 'inventory') navigateTo('inventory');
  const filtered = appData.inventory.filter(i =>
    i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q) || i.category.toLowerCase().includes(q)
  );
  renderFilteredInventory(filtered);
});

function renderFilteredInventory(items) {
  document.getElementById('inventory-table').innerHTML = items.map(item => {
    let status, statusClass;
    if (item.qty <= 0) {
      status = 'Out of Stock'; statusClass = 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
    } else if (item.qty <= item.reorder) {
      status = 'Low Stock'; statusClass = 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
    } else {
      status = 'In Stock'; statusClass = 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
    }
    return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
        <td class="px-6 py-4 font-medium text-slate-800 dark:text-slate-200">${escHtml(item.name)}</td>
        <td class="px-6 py-4 text-slate-500 dark:text-slate-400 font-mono text-xs">${escHtml(item.sku)}</td>
        <td class="px-6 py-4 text-slate-500 dark:text-slate-400">${escHtml(item.category)}</td>
        <td class="px-6 py-4 font-semibold text-slate-700 dark:text-slate-300">${item.qty.toLocaleString()} ${escHtml(item.unit || 'No')}</td>
        <td class="px-6 py-4"><span class="py-1 px-2.5 rounded-full text-xs font-semibold ${statusClass}">${status}</span></td>
        <td class="px-6 py-4">
          <div class="flex items-center gap-2">
            <button onclick="openModal('edit', ${item.id})" class="p-1.5 text-slate-400 hover:text-primary hover:bg-primary/10 rounded-lg transition-colors"><span class="material-symbols-outlined text-base">edit</span></button>
            <button onclick="deleteItem(${item.id})" class="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// --- THEME ---

function toggleTheme() {
  const html = document.documentElement;
  html.classList.toggle('dark');
  const isDark = html.classList.contains('dark');
  const headerIcon = document.getElementById('header-theme-icon');
  if (headerIcon) headerIcon.textContent = isDark ? 'light_mode' : 'dark_mode';
}

// --- MOBILE MENU ---

document.getElementById('mobile-menu-btn').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// --- TOAST ---

function showToast(msg, type) {
  const toast = document.getElementById('toast');
  const icon = document.getElementById('toast-icon');
  const msgEl = document.getElementById('toast-msg');
  msgEl.textContent = msg;
  icon.textContent = type === 'delete' ? 'delete' : 'check_circle';
  toast.classList.remove('hidden', 'hide');
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => {
      toast.classList.remove('show', 'hide');
      toast.classList.add('hidden');
    }, 300);
  }, 2500);
}

// --- UTILS ---

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// FIX #6: Include year and add null safety
function formatDate(isoStr) {
  if (!isoStr) return '--';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '--';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatDateDDMMYYYY(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return parts[2] + '-' + parts[1] + '-' + parts[0];
}

// --- CALENDAR GRID ---
let calendarYear, calendarMonth, calendarSelectedDate;

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function renderCalendarGrid() {
  const grid = document.getElementById('calendar-grid');
  const label = document.getElementById('calendar-month-label');
  if (!grid || !label) return;

  label.textContent = MONTH_NAMES[calendarMonth] + ' ' + calendarYear;

  const firstDay = new Date(calendarYear, calendarMonth, 1).getDay();
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const today = new Date();
  const todayStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');

  let html = '';
  for (let i = 0; i < firstDay; i++) {
    html += '<div></div>';
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = calendarYear + '-' + String(calendarMonth + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const isSelected = dateStr === calendarSelectedDate;
    const isToday = dateStr === todayStr;
    let cls = 'w-9 h-9 mx-auto flex items-center justify-center rounded-full text-xs font-medium cursor-pointer transition-all ';
    if (isSelected) {
      cls += 'bg-primary text-white font-bold shadow-md';
    } else if (isToday) {
      cls += 'ring-2 ring-primary text-primary dark:text-blue-400 font-semibold hover:bg-primary/10';
    } else {
      cls += 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700';
    }
    html += '<div class="py-0.5"><div class="' + cls + '" onclick="selectCalendarDate(\'' + dateStr + '\')">' + d + '</div></div>';
  }
  grid.innerHTML = html;

  const preview = document.getElementById('entry-date-preview');
  if (preview) {
    preview.textContent = 'Entry will be saved for: ' + formatDateDDMMYYYY(calendarSelectedDate);
  }
}

function selectCalendarDate(dateStr) {
  calendarSelectedDate = dateStr;
  renderCalendarGrid();
}

function calendarPrevMonth() {
  calendarMonth--;
  if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
  renderCalendarGrid();
}

function calendarNextMonth() {
  calendarMonth++;
  if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
  renderCalendarGrid();
}

function initCalendar() {
  const today = new Date();
  calendarYear = today.getFullYear();
  calendarMonth = today.getMonth();
  calendarSelectedDate = calendarYear + '-' + String(calendarMonth + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  renderCalendarGrid();
}

// --- TEAM MEMBER MODAL ---

function showTeamMemberModal(jsonStr, color) {
  const m = JSON.parse(jsonStr);
  const initials = m.name ? m.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : '??';

  const overlay = document.getElementById('team-modal-overlay');
  overlay.innerHTML = `
    <div class="bg-white dark:bg-[#1c2631] rounded-xl border border-slate-200 dark:border-slate-800 shadow-2xl w-full max-w-sm overflow-hidden" onclick="event.stopPropagation()">
      <!-- Header with gradient -->
      <div class="relative bg-gradient-to-r ${color.replace('from-primary', 'from-[#137fec]')} px-6 pt-6 pb-14">
        <button onclick="closeTeamModal()" class="absolute top-4 right-4 text-white/70 hover:text-white">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <!-- Avatar -->
      <div class="relative z-10 flex flex-col items-center -mt-10 mb-2">
        <div class="size-20 rounded-2xl bg-gradient-to-br ${color} flex items-center justify-center text-white text-2xl font-bold ring-4 ring-white dark:ring-[#1c2631] shadow-lg">
          ${initials}
        </div>
        <h3 class="text-lg font-bold text-slate-800 dark:text-white mt-3">${escHtml(m.name || 'Unknown')}</h3>
        <span class="inline-flex items-center gap-1 mt-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-primary/10 text-primary">${escHtml(m.role || 'Staff')}</span>
      </div>
      <!-- Details -->
      <div class="grid grid-cols-2 gap-px bg-slate-100 dark:bg-slate-800 mt-4">
        <div class="bg-white dark:bg-[#1c2631] p-4 flex flex-col gap-1">
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Employee ID</span>
          <p class="text-sm font-semibold text-slate-800 dark:text-white font-mono">${escHtml(m.emp_id || '--')}</p>
        </div>
        <div class="bg-white dark:bg-[#1c2631] p-4 flex flex-col gap-1">
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Location</span>
          <p class="text-sm font-semibold text-slate-800 dark:text-white">${escHtml(m.location || '--')}</p>
        </div>
        <div class="bg-white dark:bg-[#1c2631] p-4 flex flex-col gap-1 col-span-2">
          <span class="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">Mobile</span>
          <p class="text-sm font-semibold text-slate-800 dark:text-white">${m.mobile ? `<a href="tel:${escHtml(m.mobile)}" class="text-primary hover:underline">${escHtml(m.mobile)}</a>` : '--'}</p>
        </div>
      </div>
    </div>
  `;
  overlay.classList.remove('hidden');
}

function closeTeamModal() {
  document.getElementById('team-modal-overlay').classList.add('hidden');
}

// --- EXPORT TO EXCEL ---

function exportTransactionsToExcel() {
  const txns = [...appData.transactions].sort((a, b) => new Date(b.date) - new Date(a.date));
  const rows = txns.map(t => ({
    'Item': t.itemName,
    'HSN Code': t.sku,
    'Type': t.type === 'in' ? 'Stock In' : 'Stock Out',
    'Quantity': t.qty,
    'Date & Time': formatDate(t.date),
    'User': t.user,
  }));
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ 'Item': 'No transactions' }]);
  ws['!cols'] = [{ wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions');
  XLSX.writeFile(wb, 'Transactions_' + new Date().toISOString().slice(0, 10) + '.xlsx');
  showToast('Transactions Excel downloaded');
}

function exportInventoryToExcel() {
  const rows = appData.inventory.map(item => ({
    'Item Name': item.name,
    'HSN Code': item.sku,
    'Category': item.category,
    'Quantity': item.qty,
    'Unit': item.unit || 'No',
    'Rate (Excl. Tax)': item.rate || '',
    'GST %': item.gst || '',
    'Reorder Level': item.reorder,
    'Status': item.qty <= 0 ? 'Out of Stock' : item.qty <= item.reorder ? 'Low Stock' : 'In Stock',
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 28 }, { wch: 12 }, { wch: 18 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 8 }, { wch: 14 }, { wch: 14 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
  XLSX.writeFile(wb, 'Inventory_' + new Date().toISOString().slice(0, 10) + '.xlsx');
  showToast('Excel file downloaded');
}

function exportReportsToExcel() {
  const now = new Date();

  const datePicker = document.getElementById('report-date-picker');
  const monthPicker = document.getElementById('report-month-picker');
  const branchPicker = document.getElementById('report-branch-picker');
  const selectedDateStr = datePicker && datePicker.value ? datePicker.value : now.toISOString().slice(0, 10);
  const selectedMonthStr = monthPicker && monthPicker.value ? monthPicker.value : now.toISOString().slice(0, 7);

  const [selYear, selMonth] = selectedMonthStr.split('-').map(Number);
  const monthStart = new Date(selYear, selMonth - 1, 1);
  const monthEnd = new Date(selYear, selMonth, 0, 23, 59, 59, 999);

  // Build unified txns source. Admin uses adminData.entries (all branches); BOE uses appData.transactions.
  let txns;
  let scopeLabel;
  let inventorySource;
  if (isHeadOffice) {
    const selectedBranchReport = branchPicker ? branchPicker.value : 'all';
    const sourceEntries = selectedBranchReport === 'all'
      ? adminData.entries
      : adminData.entries.filter(e => e.location === selectedBranchReport);
    txns = sourceEntries.map(e => ({
      itemName: e.item_name,
      sku: e.hsn_code,
      type: e.entry_type,
      qty: e.quantity,
      date: e.created_at,
      user: e.emp_name,
      location: e.location,
    }));
    scopeLabel = selectedBranchReport === 'all' ? 'All_Branches' : selectedBranchReport.replace(/[^a-z0-9]/gi, '_');
    inventorySource = DEFAULT_INVENTORY.map(item => {
      let qty = 0;
      sourceEntries.forEach(e => {
        if (e.item_name === item.name) {
          if (e.entry_type === 'in') qty += e.quantity;
          else qty = Math.max(0, qty - e.quantity);
        }
      });
      return { ...item, qty };
    });
  } else {
    txns = appData.transactions.map(t => ({ ...t, location: selectedLocation || '' }));
    scopeLabel = (selectedLocation || 'Reports').replace(/[^a-z0-9]/gi, '_');
    inventorySource = appData.inventory;
  }

  const dateTxns = txns.filter(t => {
    const d = new Date(t.date);
    const local = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return local === selectedDateStr;
  });
  const monthTxns = txns.filter(t => {
    const d = new Date(t.date);
    return d >= monthStart && d <= monthEnd;
  });

  const rowFor = t => {
    const r = { 'Branch': t.location || '' };
    r['Item'] = t.itemName;
    r['HSN Code'] = t.sku;
    r['Type'] = t.type === 'in' ? 'Stock In' : 'Stock Out';
    r['Quantity'] = t.qty;
    r['Date & Time'] = formatDate(t.date);
    r['User'] = t.user;
    return r;
  };

  // Sort rows by branch then date for readability
  const sortByBranchDate = (a, b) => (a.location || '').localeCompare(b.location || '') || new Date(a.date) - new Date(b.date);
  const dateRows = [...dateTxns].sort(sortByBranchDate).map(rowFor);
  const monthRows = [...monthTxns].sort(sortByBranchDate).map(rowFor);

  const dateInQty = dateTxns.filter(t => t.type === 'in').reduce((s, t) => s + t.qty, 0);
  const dateOutQty = dateTxns.filter(t => t.type === 'out').reduce((s, t) => s + t.qty, 0);
  const monthInQty = monthTxns.filter(t => t.type === 'in').reduce((s, t) => s + t.qty, 0);
  const monthOutQty = monthTxns.filter(t => t.type === 'out').reduce((s, t) => s + t.qty, 0);
  const closingStock = inventorySource.reduce((s, i) => s + i.qty, 0);
  const lowStock = inventorySource.filter(i => i.qty <= i.reorder).length;

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  const summaryRows = [
    { 'Metric': `Date (${selectedDateStr}) - Total Transactions`, 'Value': dateTxns.length },
    { 'Metric': `Date (${selectedDateStr}) - Stock In (qty)`, 'Value': dateInQty },
    { 'Metric': `Date (${selectedDateStr}) - Stock Out (qty)`, 'Value': dateOutQty },
    { 'Metric': `Date (${selectedDateStr}) - Net Movement`, 'Value': dateInQty - dateOutQty },
    { 'Metric': `${monthNames[selMonth - 1]} ${selYear} - Total Transactions`, 'Value': monthTxns.length },
    { 'Metric': `${monthNames[selMonth - 1]} ${selYear} - Stock In (qty)`, 'Value': monthInQty },
    { 'Metric': `${monthNames[selMonth - 1]} ${selYear} - Stock Out (qty)`, 'Value': monthOutQty },
    { 'Metric': `${monthNames[selMonth - 1]} ${selYear} - Net Movement`, 'Value': monthInQty - monthOutQty },
    { 'Metric': 'Closing Stock', 'Value': closingStock },
    { 'Metric': 'Low Stock Items', 'Value': lowStock },
  ];

  // Per-branch breakdown sheet (admin + all branches only)
  let perBranchRows = null;
  if (isHeadOffice && (branchPicker ? branchPicker.value : 'all') === 'all') {
    const branchSet = new Set(txns.map(t => t.location).filter(Boolean));
    perBranchRows = [...branchSet].sort().map(br => {
      const dIn = dateTxns.filter(t => t.location === br && t.type === 'in').reduce((s, t) => s + t.qty, 0);
      const dOut = dateTxns.filter(t => t.location === br && t.type === 'out').reduce((s, t) => s + t.qty, 0);
      const mIn = monthTxns.filter(t => t.location === br && t.type === 'in').reduce((s, t) => s + t.qty, 0);
      const mOut = monthTxns.filter(t => t.location === br && t.type === 'out').reduce((s, t) => s + t.qty, 0);
      return {
        'Branch': br,
        [`Daily In (${selectedDateStr})`]: dIn,
        [`Daily Out (${selectedDateStr})`]: dOut,
        'Daily Net': dIn - dOut,
        [`Monthly In (${monthNames[selMonth - 1]} ${selYear})`]: mIn,
        [`Monthly Out (${monthNames[selMonth - 1]} ${selYear})`]: mOut,
        'Monthly Net': mIn - mOut,
      };
    });
  }

  const wb = XLSX.utils.book_new();
  const colWidths = [{ wch: 22 }, { wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 20 }, { wch: 20 }];

  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 40 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  if (perBranchRows && perBranchRows.length) {
    const wsBr = XLSX.utils.json_to_sheet(perBranchRows);
    wsBr['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 22 }, { wch: 22 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsBr, 'Per Branch');
  }

  const wsDate = XLSX.utils.json_to_sheet(dateRows.length ? dateRows : [{ 'Branch': '', 'Item': 'No transactions on ' + selectedDateStr }]);
  wsDate['!cols'] = colWidths;
  XLSX.utils.book_append_sheet(wb, wsDate, 'Daily (' + selectedDateStr + ')');

  const wsMonth = XLSX.utils.json_to_sheet(monthRows.length ? monthRows : [{ 'Branch': '', 'Item': 'No transactions in ' + selectedMonthStr }]);
  wsMonth['!cols'] = colWidths;
  XLSX.utils.book_append_sheet(wb, wsMonth, monthNames[selMonth - 1] + ' ' + selYear);

  XLSX.writeFile(wb, 'Reports_' + scopeLabel + '_' + selectedDateStr + '.xlsx');
  showToast('Reports Excel downloaded');
}

async function copyReportImages() {
  const todayEl = document.getElementById('report-today');
  const mtdEl = document.getElementById('report-mtd');

  if (!todayEl || !mtdEl) {
    showToast('Please open the Reports page first', 'delete');
    return;
  }

  showToast('Copying images...');

  try {
    const isDark = document.documentElement.classList.contains('dark');
    const canvasOpts = {
      scale: 2,
      useCORS: true,
      backgroundColor: isDark ? '#1c2631' : '#ffffff',
    };

    const [todayCanvas, mtdCanvas] = await Promise.all([
      html2canvas(todayEl, canvasOpts),
      html2canvas(mtdEl, canvasOpts),
    ]);

    // Combine both canvases into one image
    const gap = 24;
    const combinedCanvas = document.createElement('canvas');
    combinedCanvas.width = todayCanvas.width + mtdCanvas.width + gap;
    combinedCanvas.height = Math.max(todayCanvas.height, mtdCanvas.height);
    const ctx = combinedCanvas.getContext('2d');
    ctx.fillStyle = isDark ? '#101922' : '#fefce8';
    ctx.fillRect(0, 0, combinedCanvas.width, combinedCanvas.height);
    ctx.drawImage(todayCanvas, 0, 0);
    ctx.drawImage(mtdCanvas, todayCanvas.width + gap, 0);

    const blob = await new Promise(r => combinedCanvas.toBlob(r, 'image/png'));

    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob })
    ]);

    showToast('Report images copied to clipboard');
  } catch (err) {
    console.error('Copy failed:', err);
    showToast('Failed to copy images', 'delete');
  }
}

async function shareReports() {
  const todayEl = document.getElementById('report-today');
  const mtdEl = document.getElementById('report-mtd');

  if (!todayEl || !mtdEl) {
    showToast('Please open the Reports page first', 'delete');
    return;
  }

  showToast('Preparing images...');

  try {
    const isDark = document.documentElement.classList.contains('dark');
    const canvasOpts = {
      scale: 2,
      useCORS: true,
      backgroundColor: isDark ? '#1c2631' : '#ffffff',
    };

    const [todayCanvas, mtdCanvas] = await Promise.all([
      html2canvas(todayEl, canvasOpts),
      html2canvas(mtdEl, canvasOpts),
    ]);

    const todayBlob = await new Promise(r => todayCanvas.toBlob(r, 'image/png'));
    const mtdBlob = await new Promise(r => mtdCanvas.toBlob(r, 'image/png'));

    const todayFile = new File([todayBlob], 'Todays_Report.png', { type: 'image/png' });
    const mtdFile = new File([mtdBlob], 'Month_to_Date_Report.png', { type: 'image/png' });

    if (navigator.canShare && navigator.canShare({ files: [todayFile, mtdFile] })) {
      await navigator.share({
        title: 'Stock Reports',
        text: 'Today\'s Report & Month to Date Report - ' + (selectedLocation || 'StockRegister'),
        files: [todayFile, mtdFile],
      });
    } else {
      // Fallback: download both images
      const link = document.createElement('a');
      link.download = 'Todays_Report.png';
      link.href = todayCanvas.toDataURL('image/png');
      link.click();

      setTimeout(() => {
        link.download = 'Month_to_Date_Report.png';
        link.href = mtdCanvas.toDataURL('image/png');
        link.click();
      }, 500);

      showToast('Share not supported — images downloaded instead');
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Share failed:', err);
      showToast('Failed to share reports', 'delete');
    }
  }
}

// --- NEW ENTRY PAGE ---

function renderNewEntryPage() {
  renderCategoryTabs();
  renderEntryCards();
  updateBottomBar();
}

function renderCategoryTabs() {
  const container = document.getElementById('category-tabs');
  if (!container) return;

  container.innerHTML = CATEGORIES.map(cat => {
    const count = cat === 'All'
      ? appData.inventory.length
      : appData.inventory.filter(i => i.category === cat).length;
    const isActive = activeCategory === cat;
    return `
      <button onclick="filterCategory('${cat}')"
        class="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-colors
          ${isActive
            ? 'bg-primary text-white shadow-sm'
            : 'bg-white dark:bg-[#1c2631] text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
          }">
        ${escHtml(cat)}
        <span class="text-xs ${isActive ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'} px-1.5 py-0.5 rounded-full">${count}</span>
      </button>
    `;
  }).join('');
}

function renderEntryCards() {
  const container = document.getElementById('entry-cards-grid');
  if (!container) return;

  const items = activeCategory === 'All'
    ? appData.inventory
    : appData.inventory.filter(i => i.category === activeCategory);

  if (items.length === 0) {
    container.innerHTML = `
      <div class="col-span-full flex flex-col items-center justify-center py-16 text-slate-400 dark:text-slate-500">
        <span class="material-symbols-outlined text-5xl mb-3">inventory_2</span>
        <p class="text-sm font-medium">No items in this category</p>
      </div>
    `;
    return;
  }

  container.innerHTML = items.map(item => {
    const qty = entryCart[item.id] || 0;
    const isSelected = qty > 0;
    const isOutOfStock = item.qty <= 0;
    const isLowStock = item.qty > 0 && item.qty <= item.reorder;
    const isDisabled = entryType === 'out' && isOutOfStock;
    const rate = item.rate || 0;
    const gst = item.gst || 0;

    let stockBadge = '';
    if (isOutOfStock) {
      stockBadge = '<span class="stock-warning inline-flex items-center gap-1 text-[10px] font-bold uppercase bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400 px-2 py-0.5 rounded-full">Out of Stock</span>';
    } else if (isLowStock) {
      stockBadge = '<span class="stock-warning inline-flex items-center gap-1 text-[10px] font-bold uppercase bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400 px-2 py-0.5 rounded-full">Low Stock</span>';
    }

    return `
      <div class="entry-card ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}
        bg-white dark:bg-[#1c2631] rounded-xl border-2 ${isSelected ? 'border-primary' : 'border-slate-200 dark:border-slate-800'} p-5 cursor-pointer"
        data-item-id="${item.id}">

        <!-- Header: Name + Stock Badge -->
        <div class="mb-3">
          <div class="flex items-start justify-between gap-2 mb-1">
            <h4 class="font-semibold text-slate-800 dark:text-white text-sm leading-snug">${escHtml(item.name)}</h4>
            ${stockBadge ? `<div class="shrink-0">${stockBadge}</div>` : ''}
          </div>
          <p class="text-xs text-slate-400 font-mono mt-0.5">HSN: ${escHtml(item.sku)}</p>
        </div>

        <!-- Stock Level -->
        <div class="flex items-center gap-2 mb-3">
          <span class="material-symbols-outlined text-sm text-slate-400">inventory</span>
          <span class="text-sm text-slate-600 dark:text-slate-400">Stock: <strong class="text-slate-800 dark:text-white">${item.qty} ${escHtml(item.unit || 'No')}</strong></span>
        </div>

        <!-- Quantity Controls -->
        <div class="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800">
          <span class="text-xs font-medium text-slate-500 dark:text-slate-400">${entryType === 'in' ? 'Add Qty' : 'Remove Qty'}</span>
          <div class="flex items-center gap-3">
            <button onclick="event.stopPropagation(); updateEntryQty(${item.id}, -1)"
              class="size-8 flex items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors text-lg font-bold ${qty <= 0 ? 'opacity-40 pointer-events-none' : ''}">
              &minus;
            </button>
            <span id="qty-display-${item.id}" class="qty-display text-lg font-bold text-slate-800 dark:text-white w-8 text-center">${qty}</span>
            <button onclick="event.stopPropagation(); updateEntryQty(${item.id}, 1)"
              class="size-8 flex items-center justify-center rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-lg font-bold ${isDisabled ? 'opacity-40 pointer-events-none' : ''}">
              +
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function filterCategory(cat) {
  activeCategory = cat;
  renderCategoryTabs();
  renderEntryCards();
}

function setEntryType(type) {
  entryType = type;
  entryCart = {};

  // Update toggle UI
  const inBtn = document.getElementById('entry-type-in');
  const outBtn = document.getElementById('entry-type-out');
  if (type === 'in') {
    inBtn.className = 'px-4 py-2 rounded-md text-sm font-semibold transition-colors bg-green-500 text-white';
    outBtn.className = 'px-4 py-2 rounded-md text-sm font-semibold transition-colors text-slate-500 dark:text-slate-400';
  } else {
    inBtn.className = 'px-4 py-2 rounded-md text-sm font-semibold transition-colors text-slate-500 dark:text-slate-400';
    outBtn.className = 'px-4 py-2 rounded-md text-sm font-semibold transition-colors bg-red-500 text-white';
  }

  renderEntryCards();
  updateBottomBar();
}

function updateEntryQty(itemId, delta) {
  const item = appData.inventory.find(i => i.id === itemId);
  if (!item) return;

  const current = entryCart[itemId] || 0;
  let newQty = current + delta;

  // Bounds checking
  if (newQty < 0) newQty = 0;
  if (entryType === 'out' && newQty > item.qty) newQty = item.qty;

  if (newQty === 0) {
    delete entryCart[itemId];
  } else {
    entryCart[itemId] = newQty;
  }

  // Bump animation on the qty display
  const display = document.getElementById('qty-display-' + itemId);
  if (display) {
    display.textContent = newQty;
    display.classList.remove('bump');
    void display.offsetWidth; // force reflow
    display.classList.add('bump');
  }

  // Update card selection visual
  const card = document.querySelector(`.entry-card[data-item-id="${itemId}"]`);
  if (card) {
    if (newQty > 0) {
      card.classList.add('selected');
      card.classList.remove('border-slate-200', 'dark:border-slate-800');
      card.classList.add('border-primary');
    } else {
      card.classList.remove('selected', 'border-primary');
      card.classList.add('border-slate-200', 'dark:border-slate-800');
    }
  }

  // Update minus button opacity
  const minusBtn = card?.querySelector('button');
  if (minusBtn) {
    if (newQty <= 0) {
      minusBtn.classList.add('opacity-40', 'pointer-events-none');
    } else {
      minusBtn.classList.remove('opacity-40', 'pointer-events-none');
    }
  }

  updateBottomBar();
}

function updateBottomBar() {
  const bar = document.getElementById('entry-bottom-bar');
  const countEl = document.getElementById('entry-bar-count');
  if (!bar || !countEl) return;

  const selectedCount = Object.keys(entryCart).length;
  const totalQty = Object.values(entryCart).reduce((s, q) => s + q, 0);

  if (selectedCount > 0) {
    bar.classList.add('visible');
    countEl.textContent = `${selectedCount} item${selectedCount !== 1 ? 's' : ''} selected (${totalQty} units)`;
  } else {
    bar.classList.remove('visible');
  }
}

function clearEntryCart() {
  entryCart = {};
  renderEntryCards();
  updateBottomBar();
}

function confirmEntry() {
  const itemIds = Object.keys(entryCart);
  if (itemIds.length === 0) {
    showToast('No items selected', 'delete');
    return;
  }

  // Set type label
  const typeLabelEl = document.getElementById('entry-date-type-label');
  if (typeLabelEl) {
    if (entryType === 'in') {
      typeLabelEl.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400';
      typeLabelEl.textContent = 'Stock In';
    } else {
      typeLabelEl.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-100 dark:bg-slate-700/50 text-slate-700 dark:text-slate-300';
      typeLabelEl.textContent = 'Stock Out';
    }
  }

  // Init calendar with today selected
  initCalendar();
  document.getElementById('entry-date-modal-overlay').classList.remove('hidden');
}

function showEntryDateModal() {
  document.getElementById('entry-date-modal-overlay').classList.remove('hidden');
}

function closeEntryDateModal() {
  document.getElementById('entry-date-modal-overlay').classList.add('hidden');
}

async function confirmEntryWithDate() {
  const dateValue = calendarSelectedDate;
  if (!dateValue) { showToast('Please select a date', 'delete'); return; }
  // Build local datetime string (NOT UTC) so date.slice(0,10) matches the selected date
  const now = new Date();
  const timeStr = String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0') + ':' +
    String(now.getSeconds()).padStart(2, '0');
  // FIX #2: Use UTC ISO string for consistent timestamps
  const localISO = new Date(dateValue + 'T' + timeStr).toISOString();
  closeEntryDateModal();
  await executeEntry(localISO);
}

async function executeEntry(selectedDateISO) {
  const itemIds = Object.keys(entryCart);
  if (itemIds.length === 0) {
    showToast('No items selected', 'delete');
    return;
  }

  const now = selectedDateISO;
  const user = currentEmployee ? currentEmployee.name : 'Unknown';

  // FIX #11: Build Supabase rows WITHOUT modifying local state first
  const supabaseRows = [];
  itemIds.forEach(idStr => {
    const itemId = parseInt(idStr, 10);
    const qty = entryCart[itemId];
    const item = appData.inventory.find(i => i.id === itemId);
    if (!item || !qty) return;

    supabaseRows.push({
      item_name: item.name,
      hsn_code: item.sku,
      category: item.category,
      entry_type: entryType,
      quantity: qty,
      unit: item.unit || 'No',
      rate: item.rate || null,
      gst: item.gst || null,
      employee_id: (currentEmployee && currentEmployee.id > 0) ? currentEmployee.id : null,
      emp_name: user,
      location: selectedLocation || null,
      created_at: now,
    });
  });

  if (supabaseRows.length === 0) {
    showToast('No valid items to save', 'delete');
    return;
  }

  // Insert to Supabase first, then update local state on success
  try {
    await supabaseInsert('stock_entries', supabaseRows);
  } catch (err) {
    console.error('Supabase save error:', err);
    console.error('Payload that failed:', JSON.stringify(supabaseRows, null, 2));
    showToast('Failed to save: ' + err.message, 'delete');
    return;
  }

  entryCart = {};
  const typeLabel = entryType === 'in' ? 'Stock In' : 'Stock Out';
  showToast(`${typeLabel} recorded for ${supabaseRows.length} item${supabaseRows.length !== 1 ? 's' : ''}`);

  // Reload from Supabase to get authoritative state
  await loadFromSupabase();
  saveData(appData);
  navigateTo('transactions');
}

// --- INIT ---

// Check if already logged in
if (checkSession()) {
  if (isHeadOffice) {
    loadAdminData().then(() => navigateTo('admin'));
  } else {
    loadFromSupabase().then(() => {
      saveData(appData);
      renderDashboard();
    });
  }
} else {
  // No session — redirect to hub login
  window.location.href = 'index.html';
}

document.addEventListener('DOMContentLoaded', function() {
  const dateModal = document.getElementById('entry-date-modal-overlay');
  if (dateModal) {
    dateModal.addEventListener('click', function(e) {
      if (e.target === dateModal) closeEntryDateModal();
    });
  }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && dateModal && !dateModal.classList.contains('hidden')) {
      closeEntryDateModal();
    }
  });
});
