// Email stub: only prints to the console for now.
// Later: install nodemailer, put SMTP settings in .env, and send for real here.
async function sendEmail(to, subject, body) {
  console.log(`[EMAIL] to=${to} | ${subject}\n${body}\n`);
  return true; // return false to simulate a Failed delivery
}
module.exports = { sendEmail };
