export const config = { runtime: 'edge' };

const SUPABASE_URL = "https://qolkgzbjrufrzbvsvjfh.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvbGtnemJqcnVmcnpidnN2amZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzNzA1MzIsImV4cCI6MjA4ODk0NjUzMn0.kY2btpEcRcbDMj10v5ZyLa_J2PnKsJQw4Yi9wp7LFD0";

export default async function handler(req) {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'check';
  const hwid = url.searchParams.get('hwid');

  if (!hwid) {
    return new Response(JSON.stringify({ ok: false, message: "Missing hwid" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    if (action === 'check') {
      return await checkLicense(hwid);
    } else if (action === 'register') {
      return await registerLicense(url.searchParams);
    } else if (action === 'renew') {
      return await renewLicense(url.searchParams);
    } else {
      return jsonResponse({ ok: false, message: "Unknown action" });
    }
  } catch (e) {
    return jsonResponse({ ok: false, message: e.message });
  }
}

async function checkLicense(hwid) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/licenses?hwid=eq.${hwid}&select=*`,
    {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    }
  );

  const data = await res.json();
  
  if (!data || data.length === 0) {
    return jsonResponse({ ok: false, message: "NotFound" });
  }

  const license = data[0];
  const expireDate = new Date(license.expire_date);
  const now = new Date();
  const isExpired = expireDate < now;

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

async function registerLicense(params) {
  const hwid = params.get('hwid');
  const licenseKey = params.get('license_key');
  const days = parseInt(params.get('days')) || 30;
  
  if (!licenseKey) {
    return jsonResponse({ ok: false, message: "Missing license_key" });
  }

  const expireDate = new Date();
  expireDate.setDate(expireDate.getDate() + days);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/licenses`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      hwid: hwid,
      license_key: licenseKey,
      expire_date: expireDate.toISOString().split('T')[0],
      customer_name: params.get('customer_name') || '',
      customer_phone: params.get('customer_phone') || '',
      status: 'active'
    })
  });

  if (!res.ok) {
    const error = await res.json();
    if (error.code === '23505') { // duplicate key
      return jsonResponse({ ok: false, message: "hwid.already.registered" });
    }
    return jsonResponse({ ok: false, message: error.message });
  }

  const data = await res.json();
  return jsonResponse({
    ok: true,
    message: "Registered",
    data: data[0]
  });
}

async function renewLicense(params) {
  const hwid = params.get('hwid');
  const days = parseInt(params.get('days')) || 30;

  // Get current license
  const getRes = await fetch(
    `${SUPABASE_URL}/rest/v1/licenses?hwid=eq.${hwid}&select=*`,
    {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    }
  );

  const licenses = await getRes.json();
  if (!licenses || licenses.length === 0) {
    return jsonResponse({ ok: false, message: "NotFound" });
  }

  const license = licenses[0];
  const currentExpire = new Date(license.expire_date);
  const now = new Date();
  const baseDate = currentExpire > now ? currentExpire : now;
  baseDate.setDate(baseDate.getDate() + days);

  // Update license
  const updateRes = await fetch(
    `${SUPABASE_URL}/rest/v1/licenses?hwid=eq.${hwid}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        expire_date: baseDate.toISOString().split('T')[0],
        status: 'active'
      })
    }
  );

  const updated = await updateRes.json();
  return jsonResponse({
    ok: true,
    message: "Renewed",
    data: updated[0]
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
