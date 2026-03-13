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
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Allow-Headers': '*' }
    });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  // Parse body: read as text first (stream consumed once)
  let body = {};
  let rawBody = '';
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      rawBody = await req.text();
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch(e) {
          rawBody.split('&').forEach(p => {
            const eq = p.indexOf('=');
            if (eq > 0) body[decodeURIComponent(p.substring(0, eq))] = decodeURIComponent(p.substring(eq + 1));
          });
        }
      }
    } catch(e) {}
  }

  // Merge query params (body priority)
  url.searchParams.forEach((v, k) => { if (!(k in body)) body[k] = v; });

  const action = body.action || url.searchParams.get('action');

  try {
    // DEBUG endpoint - echo back what app sends
    if (path.includes('/api/debug')) {
      return json({ method: req.method, path, body, rawBody, headers: Object.fromEntries(req.headers) });
    }

    // Route by path - SPECIFIC first
    if (path.includes('/api/license/check-payment')) return await checkPayment(body, path);
    if (path.includes('/api/license/check-hwid'))    return await checkByHwid(body);
    if (path.includes('/api/license/check'))          return await checkByHwid(body);
    if (path.includes('/api/license/login'))           return await loginWithKey(body);
    if (path.includes('/api/license/register-payment')) return await register(body);
    if (path.includes('/api/licenses/register'))        return await register(body);
    if (path.includes('/api/license/renew-request'))    return await renewRequest(body);

    // Action param fallback
    if (action === 'check')    return await checkByHwid(body);
    if (action === 'login')    return await loginWithKey(body);
    if (action === 'register') return await register(body);
    if (action === 'payment')  return await register(body);
    if (action === 'activate') return await activateLicense(body);

    if (body.hwid) return await checkByHwid(body);
    return json({ ok: false, message: 'Unknown endpoint' });
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
// UNIFIED REGISTER (trial + payment in one)
// ==========================================
async function register(body) {
  const hwid = body.hwid;
  const name = body.customer_name || body.name || '';
  const email = body.customer_email || body.email || '';
  const phone = body.customer_phone || body.phone || '';

  if (!hwid) return json({ ok: false, status: 'error', message: 'Missing hwid' });

  // Detect package from all possible fields
  const months = detectMonths(body);
  const pkg = months > 0 ? PACKAGES[months] : null;
  const isTrial = !pkg;

  // Check existing HWID
  const existing = await getByHwid(hwid);
  if (existing && isTrial) {
    return json({ ok: false, status: 'exists', message: 'Trial already used on this device' });
  }

  const licenseKey = body.license_key || (existing ? existing.license_key : generateLicenseKey());

  if (!existing) {
    // Create license
    const expDays = pkg ? pkg.days : 1;
    const expireDate = new Date();
    expireDate.setDate(expireDate.getDate() + expDays);

    const res = await supabasePost('licenses', {
      hwid, license_key: licenseKey,
      expire_date: fmtDate(expireDate),
      customer_name: name, customer_email: email, customer_phone: phone,
      status: pkg ? 'pending' : 'active',
      trial_used: true, is_trial: isTrial,
      package_months: months
    });

    if (!res.ok) {
      const err = await res.json();
      if (err.code === '23505') return json({ ok: false, status: 'exists', message: 'hwid.already.registered' });
      return json({ ok: false, message: err.message || 'Register failed' });
    }
  }

  // If paid package → create payment + QR
  if (pkg) {
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
      license_token: licenseKey,
      customer_name: name,
      payment_code: paymentCode,
      payment_info: {
        payment_code: paymentCode,
        amount: pkg.amount,
        formatted_amount: pkg.amount.toLocaleString('vi-VN') + ' VND',
        amount_formatted: pkg.amount.toLocaleString('vi-VN') + ' VND',
        qr_code_url: qrUrl
      },
      bank_info: {
        bank_name: 'MBBank',
        account_number: BANK_ACCOUNT,
        account_name: BANK_NAME
      },
      qr_code_url: qrUrl,
      qr_url: qrUrl,
      qr_code: qrUrl,
      package_type: months,
      package_label: pkg.label,
      package_days: pkg.days,
      amount: pkg.amount,
      amount_formatted: pkg.amount.toLocaleString('vi-VN') + ' VND',
      custom_months: months,
      days_remaining: pkg.days
    });
  }

  // Trial (no package)
  return json({
    ok: true,
    status: 'success',
    license_key: licenseKey,
    license_token: licenseKey,
    expire_date: fmtDate(new Date(Date.now() + 86400000)),
    customer_name: name,
    days_remaining: 1
  });
}

// Detect months from any field the app might send
function detectMonths(body) {
  // Direct months field
  let m = parseInt(body.custom_months || body.months || body.package_months);
  if (m && PACKAGES[m]) return m;

  // package_days → months
  let d = parseInt(body.package_days);
  if (d >= 300) return 12;
  if (d >= 150) return 6;
  if (d >= 60) return 3;
  if (d >= 20) return 1;

  // package_type as months (1, 3, 6, 12)
  let pt = body.package_type;
  if (pt !== undefined && pt !== null) {
    let ptNum = parseInt(pt);
    if (PACKAGES[ptNum]) return ptNum;
    // package_type as index (1=1mo, 2=3mo, 3=6mo, 4=12mo)
    const pkgKeys = [1, 3, 6, 12];
    if (ptNum >= 1 && ptNum <= 4) return pkgKeys[ptNum - 1];
    // string match
    if (typeof pt === 'string') {
      const s = pt.toLowerCase();
      if (s.includes('nam') || s.includes('year') || s.includes('annual')) return 12;
      if (s.includes('6')) return 6;
      if (s.includes('3') || s.includes('quarter')) return 3;
      if (s.includes('1') || s.includes('month')) return 1;
    }
  }

  // Reverse lookup from amount
  let amt = parseInt(body.amount);
  if (amt) {
    for (const [months, pkg] of Object.entries(PACKAGES)) {
      if (pkg.amount === amt) return parseInt(months);
    }
  }

  return 0; // no package = trial
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
