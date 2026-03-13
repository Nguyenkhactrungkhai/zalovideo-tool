// Proxy to Google Apps Script
// Replace YOUR_GOOGLE_APPS_SCRIPT_URL with your actual deployed Apps Script URL

const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwbTyG67Gmc2dr3PNs-RTabqIqPkrXaz-5lBjN8ZjxO32JLvNL4K03W5e27gdSfYW1-QA/exec";

export default async function handler(req) {
  try {
    // Forward all query params to Google Apps Script
    const url = new URL(req.url, `https://${req.headers.get("host")}`);
    const params = url.searchParams.toString();

    // Also handle POST body
    let body = null;
    if (req.method === "POST") {
      body = await req.text();
      // Parse body params and append to query
      const bodyParams = new URLSearchParams(body);
      bodyParams.forEach((value, key) => {
        url.searchParams.set(key, value);
      });
    }

    const targetUrl = `${GOOGLE_SCRIPT_URL}?${url.searchParams.toString()}`;
    
    const response = await fetch(targetUrl, {
      method: "GET", // Apps Script works best with GET
      headers: { "Accept": "application/json" },
      redirect: "follow"
    });

    const data = await response.text();

    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, message: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
