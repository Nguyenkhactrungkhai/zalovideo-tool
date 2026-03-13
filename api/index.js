export const config = { runtime: 'edge' };

const SUPABASE_URL = "https://qolkgzbjrufrzbvsvjfh.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvbGtnemJqcnVmcnpidnN2amZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNzA1MzIsImV4cCI6MjA4ODk0NjUzMn0.kY2btpEcRcbDMj10v5ZyLa_J2PnKsJQw4Yi9wp7LFD0";

// Bank info for QR
const BANK_CODE = "MB"; // MBBank
const BANK_ACCOUNT = "0388906356";
const BANK_NAME = "NGUYEN KHAC TRUNG KHAI";

// Package pricing
const PACKAGES = {
  1:  { months: 1,  days: 30,  amount: 299000,  label: "1 thang" },
  3:  { months: 3,  days: 90,  amount: 800000,  label: "3 thang" },
  6:  { months: 6,  days: 180, amount: 1500000, label: "6 thang" },
  12: { months: 12, days: 365, amount: 2500000, label: "1 nam" }
};

export default async function handler(req) {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'check';
  const p = url.searchParams;

  try {
    switch (action) {
      case 'check':       return await checkLicense(p);
      case 'register':    return await registerTrial(p);
      case 'payment':     return await createPayment(p);
      case 'activate':    return await activateLicense(p);
      case 'login':       return await loginWithKey(p);
      case 'packages':    return jsonResponse({ ok: true, data: PACKAGES });
      default:            return jsonResponse({ ok: false, message: "Unknown action" });
    }
  } catch (e) {
    return jsonResponse({ ok: false, message: e.message });
  }
}

// ==========================================
// CHECK LICENSE BY HWID (app goi khi mo)
// ==========================================
async function checkLicense(p) {
  const hwid = p.get('hwid');
  if (!hwid) return jsonResponse({ ok: false, message: "Missing hwid" });

  const license = await getByHwid(hwid);
  if (!license) return jsonResponse({ ok: false, message: "NotFound" });

  const isExpired = new Date(license.expire_date) < new Date();

  if (license.status !== 'active' || isExpired) {
    return jsonResponse({
      ok: false,
      message: "License expired or inactive",
      data: {
        license_key: license.license_key,
        expire_date: license.expire_date,
        customer_name: license.customer_name,
        status: isExpired ? 'expired' : license.status
      }
    });
  }

  return jsonResponse({
    ok: true,
    message: "Valid",
    data: {
      license_key: license.license_key,
      expire_date: license.expire_date,
      customer_name: license.customer_name,
      customer_phone: license.customer_phone,
      status: license.status
    }
  });
}

// ==========================================
// REGISTER TRIAL (dung thu 1 ngay, 1 lan/HWID)
// ==========================================
async function registerTrial(p) {
  const hwid = p.get('hwid');
  const name = p.get('customer_name') || '';
  const email = p.get('customer_email') || '';
  const phone = p.get('customer_phone') || '';

  if (!hwid) return jsonResponse({ ok: false, message: "Missing hwid" });
  if (!name) return jsonResponse({ ok: false, message: "Missing customer_name" });

  // Check if HWID already used trial
  const existing = await getByHwid(hwid);
  if (existing) {
    if (existing.trial_used) {
      return jsonResponse({ ok: false, message: "Trial already used on this device" });
    }
    return jsonResponse({ ok: false, message: "hwid.already.registered" });
  }

  // Generate license key
  const licenseKey = generateLicenseKey();
  const expireDate = new Date();
  expireDate.setDate(expireDate.getDate() + 1); // 1 day trial

  const res = await supabasePost('licenses', {
    hwid: hwid,
    license_key: licenseKey,
    expire_date: formatDate(expireDate),
    customer_name: name,
    customer_email: email,
    customer_phone: phone,
    status: 'active',
    trial_used: true,
    is_trial: true,
    package_months: 0
  });

  if (!res.ok) {
    const err = await res.json();
    if (err.code === '23505') return jsonResponse({ ok: false, message: "hwid.already.registered" });
    return jsonResponse({ ok: false, message: err.message || "Register failed" });
  }

  const data = await res.json();
  return jsonResponse({
    ok: true,
    message: "Trial registered (1 day)",
    data: {
      license_key: licenseKey,
      expire_date: formatDate(expireDate),
      customer_name: name,
      is_trial: true
    }
  });
}

// ==========================================
// LOGIN WITH LICENSE KEY (bind to HWID)
// ==========================================
async function loginWithKey(p) {
  const hwid = p.get('hwid');
  const licenseKey = p.get('license_key');

  if (!hwid) return jsonResponse({ ok: false, message: "Missing hwid" });
  if (!licenseKey) return jsonResponse({ ok: false, message: "Missing license_key" });

  // Find license by key
  const license = await getByKey(licenseKey);
  if (!license) return jsonResponse({ ok: false, message: "Invalid license key" });

  const isExpired = new Date(license.expire_date) < new Date();
  if (isExpired) return jsonResponse({ ok: false, message: "License expired" });

  // Check if key already bound to different HWID
  if (license.hwid && license.hwid !== hwid) {
    return jsonResponse({
      ok: false,
      message: "License already used on another device"
    });
  }

  // Bind key to this HWID
  if (!license.hwid) {
    await supabasePatch('licenses', `license_key=eq.${licenseKey}`, {
      hwid: hwid
    });
  }

  return jsonResponse({
    ok: true,
    message: "Valid",
    data: {
      license_key: license.license_key,
      expire_date: license.expire_date,
      customer_name: license.customer_name,
      status: license.status
    }
  });
}

// ==========================================
// CREATE PAYMENT (tao QR thanh toan)
// ==========================================
async function createPayment(p) {
  const hwid = p.get('hwid');
  const licenseKey = p.get('license_key');
  const months = parseInt(p.get('months'));
  const name = p.get('customer_name') || '';
  const email = p.get('customer_email') || '';
  const phone = p.get('customer_phone') || '';

  if (!months || !PACKAGES[months]) {
    return jsonResponse({ ok: false, message: "Invalid package. Use months=1,3,6,12" });
  }

  const pkg = PACKAGES[months];
  const key = licenseKey || generateLicenseKey();
  const transferContent = `ZVT ${key}`;

  // VietQR URL
  const qrUrl = `https://img.vietqr.io/image/${BANK_CODE}-${BANK_ACCOUNT}-compact.png?amount=${pkg.amount}&addInfo=${encodeURIComponent(transferContent)}&accountName=${encodeURIComponent(BANK_NAME)}`;

  // Save payment record
  await supabasePost('payments', {
    license_key: key,
    hwid: hwid || '',
    customer_name: name,
    customer_email: email,
    customer_phone: phone,
    package_months: months,
    amount: pkg.amount,
    transfer_content: transferContent,
    payment_status: 'pending'
  });

  return jsonResponse({
    ok: true,
    message: "Payment created",
    data: {
      license_key: key,
      package: pkg.label,
      amount: pkg.amount,
      amount_display: pkg.amount.toLocaleString('vi-VN') + " VND",
      qr_url: qrUrl,
      bank_name: "MBBank",
      bank_account: BANK_ACCOUNT,
      bank_owner: BANK_NAME,
      transfer_content: transferContent
    }
  });
}

// ==========================================
// ACTIVATE LICENSE (sau khi xac nhan thanh toan)
// ==========================================
async function activateLicense(p) {
  const licenseKey = p.get('license_key');
  const hwid = p.get('hwid');

  if (!licenseKey) return jsonResponse({ ok: false, message: "Missing license_key" });

  // Find pending payment
  const payRes = await supabaseGet('payments', `license_key=eq.${licenseKey}&payment_status=eq.pending&order=created_at.desc&limit=1`);
  const payments = await payRes.json();

  if (!payments || payments.length === 0) {
    return jsonResponse({ ok: false, message: "No pending payment found" });
  }

  const payment = payments[0];
  const pkg = PACKAGES[payment.package_months];
  if (!pkg) return jsonResponse({ ok: false, message: "Invalid package" });

  // Calculate expire date
  const expireDate = new Date();
  expireDate.setDate(expireDate.getDate() + pkg.days);

  // Check if license exists
  const existing = await getByKey(licenseKey);

  if (existing) {
    // Extend existing license
    const currentExpire = new Date(existing.expire_date);
    const now = new Date();
    const base = currentExpire > now ? currentExpire : now;
    base.setDate(base.getDate() + pkg.days);

    await supabasePatch('licenses', `license_key=eq.${licenseKey}`, {
      expire_date: formatDate(base),
      status: 'active',
      is_trial: false,
      package_months: payment.package_months
    });
  } else {
    // Create new license
    await supabasePost('licenses', {
      hwid: hwid || '',
      license_key: licenseKey,
      expire_date: formatDate(expireDate),
      customer_name: payment.customer_name,
      customer_email: payment.customer_email,
      customer_phone: payment.customer_phone,
      status: 'active',
      is_trial: false,
      package_months: payment.package_months
    });
  }

  // Mark payment as paid
  await supabasePatch('payments', `id=eq.${payment.id}`, {
    payment_status: 'paid',
    paid_at: new Date().toISOString()
  });

  return jsonResponse({
    ok: true,
    message: "License activated",
    data: {
      license_key: licenseKey,
      expire_date: existing ? undefined : formatDate(expireDate),
      package_months: payment.package_months
    }
  });
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================
function generateLicenseKey() {
  const now = new Date();
  const dateStr = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 10).toUpperCase();
  return `L1.${dateStr}.${rand}`;
}

function formatDate(d) {
  const date = new Date(d);
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

async function getByHwid(hwid) {
  const res = await supabaseGet('licenses', `hwid=eq.${hwid}&limit=1`);
  const data = await res.json();
  return data && data.length > 0 ? data[0] : null;
}

async function getByKey(key) {
  const res = await supabaseGet('licenses', `license_key=eq.${key}&limit=1`);
  const data = await res.json();
  return data && data.length > 0 ? data[0] : null;
}

async function supabaseGet(table, query) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&select=*`, {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
    }
  });
}

async function supabasePost(table, data) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
}

async function supabasePatch(table, filter, data) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
