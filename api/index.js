export const config = { runtime: 'edge' };

const SUPABASE_URL = "https://qolkgzbjrufrzbvsvjfh.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvbGtnemJqcnVmcnpidnN2amZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNzA1MzIsImV4cCI6MjA4ODk0NjUzMn0.kY2btpEcRcbDMj10v5ZyLa_J2PnKsJQw4Yi9wp7LFD0";

const BANK_CODE = "MB";
const BANK_ACCOUNT = "0388906356";
const BANK_NAME = "NGUYEN KHAC TRUNG KHAI";

const PACKAGES = {
  1:  { months: 1,  days: 30,  amount: 100000,  label: "1 tháng - 100,000 VNĐ" },
  3:  { months: 3,  days: 90,  amount: 250000,  label: "3 tháng - 250,000 VNĐ" },
  6:  { months: 6,  days: 180, amount: 450000,  label: "6 tháng - 450,000 VNĐ" },
  12: { months: 12, days: 365, amount: 800000,  label: "1 năm - 800,000 VNĐ" }
};

// ==========================================
// MAIN HANDLER - route by URL path + POST body
// ==========================================
export default async function handler(req) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*' }
    });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  // Parse body: read as text first (stream can only be consumed once)
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      const raw = await req.text();
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch(e) {
          // Try form-urlencoded
          raw.split('&').forEach(p => {
            const eq = p.indexOf('=');
            if (eq > 0) {
              body[decodeURIComponent(p.substring(0, eq))] = decodeURIComponent(p.substring(eq + 1));
            }
          });
        }
      }
    } catch(e) {}
  }

  // Merge query params (body takes priority)
  url.searchParams.forEach((v, k) => { if (!(k in body)) body[k] = v; });

  const action = body.action || url.searchParams.get('action');

  try {
    // Route by path - SPECIFIC paths first to avoid partial matches
    if (path.includes('/api/license/check-payment')) {
      return await checkPayment(body, path);
    }
    if (path.includes('/api/license/check-hwid')) {
      return await checkByHwid(body);
    }
    if (path.includes('/api/license/check')) {
      return await checkByHwid(body);
    }
    if (path.includes('/api/license/login')) {
      return await loginWithKey(body);
    }
    if (path.includes('/api/license/register-payment')) {
      return await registerPayment(body);
    }
    if (path.includes('/api/licenses/register')) {
      return await registerTrial(body);
    }
    if (path.includes('/api/license/renew-request')) {
      return await renewRequest(body);
    }

    // Route by action param (for browser/manual testing)
    if (action === 'check') return await checkByHwid(body);
    if (action === 'login') return await loginWithKey(body);
    if (action === 'register') return await registerTrial(body);
    if (action === 'payment') return await registerPayment(body);
    if (action === 'activate') return await activateLicense(body);
    if (action === 'packages') return json({ ok: true, data: PACKAGES });

    // Default: check by hwid
    if (body.hwid) return await checkByHwid(body);

    return json({ ok: false, message: "Unknown endpoint" });
  } catch (e) {
    return json({ ok: false, message: e.message });
  }
}

// ==========================================
// CHECK BY HWID (app calls on startup)
// ==========================================
async function checkByHwid(body) {
  const hwid = body.hwid;
  if (!hwid) return json({ ok: false, status: 'error', message: 'Missing hwid' });

  const license = await getByHwid(hwid);
  if (!license) {
    return json({
      ok: false,
      status: 'not_found',
      need_action: 'register',
      message: 'NotFound'
    });
  }

  const now = new Date();
  const expDate = new Date(license.expire_date);
  const isExpired = expDate < now;
  const daysRemaining = Math.max(0, Math.ceil((expDate - now) / 86400000));

  if (license.status !== 'active' || isExpired) {
    return json({
      ok: false,
      status: 'expired',
      need_action: 'renew',
      license_key: license.license_key,
      expire_date: license.expire_date,
      customer_name: license.customer_name,
      days_remaining: 0,
      message: 'License expired or inactive'
    });
  }

  return json({
    ok: true,
    status: 'active',
    license_key: license.license_key,
    license_token: license.license_key,
    expire_date: license.expire_date,
    customer_name: license.customer_name,
    customer_email: license.customer_email || '',
    customer_phone: license.customer_phone || '',
    days_remaining: daysRemaining,
    server_time: now.toISOString(),
    renewal_packages: Object.values(PACKAGES).map(p => ({
      days: p.days, price: p.amount, label: p.label
    }))
  });
}

// ==========================================
// LOGIN WITH LICENSE KEY
// ==========================================
async function loginWithKey(body) {
  const hwid = body.hwid;
  const licenseKey = body.license_key || body.code;

  if (!hwid) return json({ ok: false, status: 'error', message: 'Missing hwid' });
  if (!licenseKey) return json({ ok: false, status: 'error', message: 'Missing license_key' });

  const license = await getByKey(licenseKey);
  if (!license) return json({ ok: false, status: 'not_found', message: 'Invalid license key' });

  const isExpired = new Date(license.expire_date) < new Date();
  if (isExpired) return json({ ok: false, status: 'expired', message: 'License expired' });

  // 1 key - 1 device
  if (license.hwid && license.hwid !== hwid) {
    return json({
      ok: false,
      status: 'device_transferred',
      device_transferred: true,
      message: 'License already used on another device'
    });
  }

  // Bind key to HWID
  if (!license.hwid || license.hwid === '') {
    await supabasePatch('licenses', `license_key=eq.${licenseKey}`, { hwid });
  }

  const daysRemaining = Math.max(0, Math.ceil((new Date(license.expire_date) - new Date()) / 86400000));

  return json({
    ok: true,
    status: 'active',
    license_key: license.license_key,
    license_token: license.license_key,
    expire_date: license.expire_date,
    customer_name: license.customer_name,
    days_remaining: daysRemaining
  });
}

// ==========================================
// REGISTER TRIAL (1 day, 1 time per HWID)
// ==========================================
async function registerTrial(body) {
  const hwid = body.hwid;
  const name = body.customer_name || '';
  const email = body.customer_email || '';
  const phone = body.customer_phone || '';
  const packageType = body.package_type;
  const customMonths = parseInt(body.custom_months) || 0;

  if (!hwid) return json({ ok: false, status: 'error', message: 'Missing hwid' });

  // Check existing
  const existing = await getByHwid(hwid);
  if (existing) {
    if (existing.trial_used) {
      return json({ ok: false, status: 'exists', message: 'Trial already used on this device' });
    }
    return json({ ok: false, status: 'exists', message: 'hwid.already.registered' });
  }

  const licenseKey = generateLicenseKey();
  const expireDate = new Date();
  expireDate.setDate(expireDate.getDate() + 1);

  const res = await supabasePost('licenses', {
    hwid, license_key: licenseKey,
    expire_date: fmtDate(expireDate),
    customer_name: name, customer_email: email, customer_phone: phone,
    status: 'active', trial_used: true, is_trial: true, package_months: 0
  });

  if (!res.ok) {
    const err = await res.json();
    if (err.code === '23505') return json({ ok: false, status: 'exists', message: 'hwid.already.registered' });
    return json({ ok: false, message: err.message || 'Register failed' });
  }

  return json({
    ok: true,
    status: 'success',
    license_key: licenseKey,
    license_token: licenseKey,
    expire_date: fmtDate(expireDate),
    customer_name: name,
    days_remaining: 1
  });
}

// ==========================================
// REGISTER PAYMENT (create QR)
// ==========================================
async function registerPayment(body) {
  const hwid = body.hwid || '';
  const name = body.customer_name || '';
  const email = body.customer_email || '';
  const phone = body.customer_phone || '';
  const packageType = body.package_type;
  const months = parseInt(body.custom_months || body.months) || 1;

  const pkg = PACKAGES[months];
  if (!pkg) return json({ ok: false, message: 'Invalid package' });

  const licenseKey = body.license_key || generateLicenseKey();
  const paymentCode = `ZVT${licenseKey.replace(/\./g, '')}`;
  const qrUrl = `https://img.vietqr.io/image/${BANK_CODE}-${BANK_ACCOUNT}-compact.png?amount=${pkg.amount}&addInfo=${encodeURIComponent(paymentCode)}&accountName=${encodeURIComponent(BANK_NAME)}`;

  await supabasePost('payments', {
    license_key: licenseKey, hwid,
    customer_name: name, customer_email: email, customer_phone: phone,
    package_months: months, amount: pkg.amount,
    transfer_content: paymentCode, payment_status: 'pending'
  });

  return json({
    ok: true,
    status: 'pending',
    license_key: licenseKey,
    payment_code: paymentCode,
    payment_info: {
      payment_code: paymentCode,
      amount: pkg.amount,
      formatted_amount: pkg.amount.toLocaleString('vi-VN') + ' VND',
      amount_formatted: pkg.amount.toLocaleString('vi-VN') + ' VND'
    },
    bank_info: {
      bank_name: 'MBBank',
      account_number: BANK_ACCOUNT,
      account_name: BANK_NAME
    },
    qr_code_url: qrUrl,
    qr_url: qrUrl,
    qr_code: qrUrl,
    package_label: pkg.label,
    package_days: pkg.days
  });
}

// ==========================================
// CHECK PAYMENT STATUS
// ==========================================
async function checkPayment(body, path) {
  // Extract payment code from path: /api/license/check-payment/ZVT...
  const parts = path.split('/');
  const code = parts[parts.length - 1] || body.payment_code || body.code;

  if (!code || code === 'check-payment') {
    return json({ ok: false, status: 'error', message: 'Missing payment code' });
  }

  const payRes = await supabaseGet('payments', `transfer_content=eq.${code}&order=created_at.desc&limit=1`);
  const payments = await payRes.json();

  if (!payments || payments.length === 0) {
    return json({ ok: false, status: 'not_found', message: 'Payment not found' });
  }

  const payment = payments[0];
  return json({
    ok: true,
    status: payment.payment_status,
    license_key: payment.license_key,
    amount: payment.amount
  });
}

// ==========================================
// RENEW REQUEST
// ==========================================
async function renewRequest(body) {
  const hwid = body.hwid;
  const months = parseInt(body.months || body.custom_months) || 1;

  if (!hwid) return json({ ok: false, message: 'Missing hwid' });

  const license = await getByHwid(hwid);
  if (!license) return json({ ok: false, status: 'not_found', message: 'License not found' });

  const pkg = PACKAGES[months];
  if (!pkg) return json({ ok: false, message: 'Invalid package' });

  const paymentCode = `ZVT${license.license_key.replace(/\./g, '')}`;
  const qrUrl = `https://img.vietqr.io/image/${BANK_CODE}-${BANK_ACCOUNT}-compact.png?amount=${pkg.amount}&addInfo=${encodeURIComponent(paymentCode)}&accountName=${encodeURIComponent(BANK_NAME)}`;

  await supabasePost('payments', {
    license_key: license.license_key, hwid,
    customer_name: license.customer_name,
    customer_email: license.customer_email || '',
    customer_phone: license.customer_phone || '',
    package_months: months, amount: pkg.amount,
    transfer_content: paymentCode, payment_status: 'pending'
  });

  return json({
    ok: true,
    status: 'pending',
    license_key: license.license_key,
    payment_code: paymentCode,
    qr_url: qrUrl,
    qr_code_url: qrUrl,
    bank_info: {
      bank_name: 'MBBank',
      account_number: BANK_ACCOUNT,
      account_name: BANK_NAME
    },
    payment_info: {
      payment_code: paymentCode,
      amount: pkg.amount,
      formatted_amount: pkg.amount.toLocaleString('vi-VN') + ' VND'
    }
  });
}

// ==========================================
// ACTIVATE (manual, admin use)
// ==========================================
async function activateLicense(body) {
  const licenseKey = body.license_key;
  if (!licenseKey) return json({ ok: false, message: 'Missing license_key' });

  const payRes = await supabaseGet('payments', `license_key=eq.${licenseKey}&payment_status=eq.pending&order=created_at.desc&limit=1`);
  const payments = await payRes.json();
  if (!payments || payments.length === 0) return json({ ok: false, message: 'No pending payment' });

  const payment = payments[0];
  const pkg = PACKAGES[payment.package_months];
  if (!pkg) return json({ ok: false, message: 'Invalid package' });

  const existing = await getByKey(licenseKey);
  const expireDate = new Date();
  expireDate.setDate(expireDate.getDate() + pkg.days);

  if (existing) {
    const base = new Date(existing.expire_date) > new Date() ? new Date(existing.expire_date) : new Date();
    base.setDate(base.getDate() + pkg.days);
    await supabasePatch('licenses', `license_key=eq.${licenseKey}`, {
      expire_date: fmtDate(base), status: 'active', is_trial: false, package_months: payment.package_months
    });
  } else {
    await supabasePost('licenses', {
      hwid: body.hwid || '', license_key: licenseKey,
      expire_date: fmtDate(expireDate),
      customer_name: payment.customer_name, customer_email: payment.customer_email || '',
      customer_phone: payment.customer_phone || '',
      status: 'active', is_trial: false, package_months: payment.package_months
    });
  }

  await supabasePatch('payments', `id=eq.${payment.id}`, { payment_status: 'paid', paid_at: new Date().toISOString() });

  return json({ ok: true, status: 'success', license_key: licenseKey, message: 'License activated' });
}

// ==========================================
// HELPERS
// ==========================================
function generateLicenseKey() {
  const now = new Date();
  const d = now.getFullYear().toString() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0');
  const r = Math.random().toString(36).substring(2,10).toUpperCase();
  return `L1.${d}.${r}`;
}

function fmtDate(d) {
  const dt = new Date(d);
  return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
}

async function getByHwid(hwid) {
  const r = await supabaseGet('licenses', `hwid=eq.${hwid}&limit=1`);
  const d = await r.json(); return d && d.length > 0 ? d[0] : null;
}

async function getByKey(key) {
  const r = await supabaseGet('licenses', `license_key=eq.${key}&limit=1`);
  const d = await r.json(); return d && d.length > 0 ? d[0] : null;
}

async function supabaseGet(table, query) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&select=*`, {
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
  });
}

async function supabasePost(table, data) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(data)
  });
}

async function supabasePatch(table, filter, data) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(data)
  });
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*' }
  });
}
