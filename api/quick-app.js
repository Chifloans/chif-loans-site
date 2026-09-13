// Vercel serverless function — handles Quick App submissions.
// Runs server-side so the browser never talks to Supabase directly
// (client-side calls to *.supabase.co get silently blocked by many
// ad blockers / privacy extensions, which is why submissions were vanishing).

const SUPABASE_URL = process.env.SUPABASE_URL || "https://zwoknvgmciqghjyyhoki.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp3b2tudmdtY2lxZ2hqeXlob2tpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYzNzQ2OTIsImV4cCI6MjEwMTk1MDY5Mn0.2aNIYwsP40EKvmKvunvK9Mc27IgC2R3qB0kF8cEnBEc";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "info@chifhomes.com";
const RESEND_FROM = process.env.RESEND_FROM || "CHIF Loans <onboarding@resend.dev>";

const REQUIRED_FIELDS = [
  "loan_type", "transaction_type", "property_value", "loan_amount",
  "property_address", "property_city", "property_state",
  "borrowing_as", "credit_score", "experience",
  "full_name", "phone", "email"
];

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY not set — skipping email send");
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + RESEND_API_KEY
      },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, html })
    });
    if (!res.ok) {
      console.error("Resend error", res.status, await res.text());
    }
  } catch (err) {
    console.error("Resend request failed", err);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  const body = req.body || {};

  // Honeypot: real users never fill this hidden field, bots often do.
  if (body._hp) {
    res.status(200).json({ ok: true });
    return;
  }

  for (const field of REQUIRED_FIELDS) {
    if (!body[field] || !String(body[field]).trim()) {
      res.status(400).json({ ok: false, error: "missing_field", field });
      return;
    }
  }

  const payload = {
    loan_type: String(body.loan_type).trim(),
    transaction_type: String(body.transaction_type).trim(),
    property_value: String(body.property_value).trim(),
    loan_amount: String(body.loan_amount).trim(),
    property_address: String(body.property_address).trim(),
    property_city: String(body.property_city).trim(),
    property_state: String(body.property_state).trim(),
    borrowing_as: String(body.borrowing_as).trim(),
    credit_score: String(body.credit_score).trim(),
    experience: String(body.experience).trim(),
    target_close_date: body.target_close_date ? String(body.target_close_date).trim() : null,
    full_name: String(body.full_name).trim(),
    phone: String(body.phone).trim(),
    email: String(body.email).trim(),
    notes: body.notes ? String(body.notes).trim() : null
  };

  try {
    const dbRes = await fetch(SUPABASE_URL + "/rest/v1/quick_app_submissions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(payload)
    });

    if (!dbRes.ok) {
      const errText = await dbRes.text();
      console.error("Supabase insert failed", dbRes.status, errText);
      res.status(502).json({ ok: false, error: "db_insert_failed" });
      return;
    }
  } catch (err) {
    console.error("Supabase request failed", err);
    res.status(502).json({ ok: false, error: "db_request_failed", debug: String(err && err.stack || err), hasFetch: typeof fetch });
    return;
  }

  const rows = [
    ["Loan type", payload.loan_type],
    ["Transaction", payload.transaction_type],
    ["Purchase price / est. value", payload.property_value],
    ["Loan amount requested", payload.loan_amount],
    ["Property address", payload.property_address],
    ["City", payload.property_city],
    ["State", payload.property_state],
    ["Borrowing as", payload.borrowing_as],
    ["Estimated credit score", payload.credit_score],
    ["Investing experience", payload.experience],
    ["Target close date", payload.target_close_date || "—"],
    ["Full name", payload.full_name],
    ["Phone", payload.phone],
    ["Email", payload.email],
    ["Notes", payload.notes || "—"]
  ];
  const internalHtml =
    "<h2>New Quick App submission</h2><table cellpadding=\"6\" style=\"border-collapse:collapse\">" +
    rows.map(function (r) {
      return "<tr><td style=\"font-weight:bold;border:1px solid #ddd\">" + escapeHtml(r[0]) +
        "</td><td style=\"border:1px solid #ddd\">" + escapeHtml(r[1]) + "</td></tr>";
    }).join("") + "</table>";

  const applicantHtml =
    "<p>Hi " + escapeHtml(payload.full_name.split(" ")[0] || "there") + ",</p>" +
    "<p>Thanks for submitting your Quick App to CHIF Loans. We've got your info and we review every " +
    "application the same day. If it looks bankable, we'll call or email you with real terms.</p>" +
    "<p>If anything comes up in the meantime, reach us at " +
    "<a href=\"tel:19544710235\">954-471-0235</a> or reply to this email.</p>" +
    "<p>— CHIF Loans</p>";

  await Promise.all([
    sendEmail(NOTIFY_EMAIL, "New Quick App: " + payload.full_name + " (" + payload.loan_type + ")", internalHtml),
    sendEmail(payload.email, "We received your Quick App — CHIF Loans", applicantHtml)
  ]);

  res.status(200).json({ ok: true });
};
