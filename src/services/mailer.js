const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendEmail(to, subject, text, opts = {}) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('[EMAIL NOT SENT] RESEND_API_KEY is not set');
    return false;
  }

  const html = opts.html || `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.55;max-width:560px">
    <div style="background:#013f70;color:#fff;padding:14px 18px;font-size:18px;font-weight:bold">FiberTec IT Solutions</div>
    <div style="padding:16px 18px;border:1px solid #dde">${esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</div></div>`;

  const body = {
    from: `${process.env.MAIL_FROM_NAME || 'FiberTec Billing'} <onboarding@resend.dev>`,
    to: [to],
    subject,
    text,
    html,
  };

  if (opts.attachments && opts.attachments.length) {
    body.attachments = opts.attachments.map(a => ({
      filename: a.name,
      content: a.content,
    }));
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.error(`[EMAIL FAILED] Resend HTTP ${r.status}:`, await r.text());
      return false;
    }
    console.log(`[EMAIL SENT] Resend API to ${to}`);
    return true;
  } catch (e) {
    console.error('[EMAIL FAILED] Resend error:', e);
    return false;
  }
}

module.exports = { sendEmail };