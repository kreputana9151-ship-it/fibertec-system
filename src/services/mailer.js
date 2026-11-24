const nodemailer = require('nodemailer');

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendEmail(to, subject, text, opts = {}) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    console.error('[EMAIL NOT SENT] GMAIL_USER or GMAIL_APP_PASSWORD is not set');
    return false;
  }

  const html = opts.html || `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.55;max-width:560px">
    <div style="background:#013f70;color:#fff;padding:14px 18px;font-size:18px;font-weight:bold">FiberTec IT Solutions</div>
    <div style="padding:16px 18px;border:1px solid #dde">${esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</div></div>`;

  const mailOptions = {
    from: `"${process.env.MAIL_FROM_NAME || 'FiberTec IT Solutions'}" <${user}>`,
    to,
    subject,
    text,
    html,
  };

  if (opts.attachments && opts.attachments.length) {
    mailOptions.attachments = opts.attachments.map(a => ({
      filename: a.name,
      content: a.content,
      encoding: 'base64',
    }));
  }

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[EMAIL SENT] Gmail SMTP ID ${info.messageId} to ${to}`);
    return true;
  } catch (e) {
    console.error('[EMAIL FAILED] Gmail SMTP error:', e);
    return false;
  }
}

module.exports = { sendEmail };