const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendEmail(to, subject, text, opts = {}) {
  const webhook = process.env.GMAIL_WEBHOOK_URL;
  if (!webhook) {
    console.error('[EMAIL NOT SENT] GMAIL_WEBHOOK_URL is not set');
    return false;
  }

  const html = opts.html || `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.55;max-width:560px">
    <div style="background:#013f70;color:#fff;padding:14px 18px;font-size:18px;font-weight:bold">FiberTec IT Solutions</div>
    <div style="padding:16px 18px;border:1px solid #dde">${esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</div></div>`;

  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        subject,
        text,
        html,
        fromName: process.env.MAIL_FROM_NAME || 'FiberTec IT Solutions',
        attachments: opts.attachments || [],
      }),
    });
    const body = await r.text();
    if (!r.ok || !body.includes('"ok":true')) {
      console.error(`[EMAIL FAILED] Gmail Webhook HTTP ${r.status}:`, body);
      return false;
    }
    console.log(`[EMAIL SENT] Gmail Webhook to ${to}`);
    return true;
  } catch (e) {
    console.error('[EMAIL FAILED] Gmail Webhook error:', e);
    return false;
  }
}

module.exports = { sendEmail };