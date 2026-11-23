// Real email through Brevo's HTTP API (works on Render's free plan, where SMTP ports are blocked).
// Set these in Render > Environment:  BREVO_API_KEY (API key, not the SMTP key),
//   MAIL_FROM_EMAIL (a sender you VERIFIED in Brevo > Senders), MAIL_FROM_NAME (optional)
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendEmail(to, subject, text, opts = {}) {
  const key = process.env.BREVO_API_KEY, from = process.env.MAIL_FROM_EMAIL;
  if (!key || !from) { console.error('[EMAIL NOT SENT] BREVO_API_KEY or MAIL_FROM_EMAIL is not set'); return false; }
  const html = opts.html || `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.55;max-width:560px">
    <div style="background:#013f70;color:#fff;padding:14px 18px;font-size:18px;font-weight:bold">FiberTec IT Solutions</div>
    <div style="padding:16px 18px;border:1px solid #dde">${esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</div></div>`;
  const body = { sender: { email: from, name: process.env.MAIL_FROM_NAME || 'FiberTec IT Solutions' }, to: [{ email: to }], subject, textContent: text, htmlContent: html };
  if (opts.attachments && opts.attachments.length) body.attachment = opts.attachments.map(a => ({ name: a.name, content: a.content }));
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', signal: ctl.signal, body: JSON.stringify(body),
      headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' } });
    if (!r.ok) {
      const responseBody = await r.text().catch(e => `[response body read failed: ${e.message}]`);
      console.error(`[EMAIL FAILED] Brevo HTTP ${r.status} ${r.statusText}; response body: ${responseBody}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[EMAIL FAILED] Brevo request error:', e);
    return false;
  } finally { clearTimeout(t); }
}
module.exports = { sendEmail };
