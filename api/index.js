export const config = { runtime: 'edge' };

const KEY = 'L1.20260313.FOREVER';
const EXP = '2099-12-31';

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' }
    });
  }

  // Always return active license, no matter what endpoint or body
  return new Response(JSON.stringify({
    ok: true,
    status: 'active',
    license_key: KEY,
    license_token: KEY,
    expire_date: EXP,
    customer_name: 'Licensed User',
    customer_email: '',
    customer_phone: '',
    days_remaining: 99999,
    server_time: new Date().toISOString(),
    device_transferred: false,
    expired: false,
    not_found: false,
    paid: true,
    need_action: null,
    renewal_packages: [
      { days: 30, price: 0, label: 'Free' },
      { days: 365, price: 0, label: 'Free' }
    ]
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*'
    }
  });
}
