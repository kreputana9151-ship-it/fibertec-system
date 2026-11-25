// npm run seed  -> replaces the placeholder password hashes from the SQL file with real bcrypt hashes
require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool, query } = require('./db');

(async () => {
  const pw = process.env.SEED_PASSWORD || 'ChangeMe123!';
  const hash = await bcrypt.hash(pw, 10);
  const r = await query("UPDATE users SET password_hash=$1 WHERE password_hash LIKE '%REPLACE_WITH_BCRYPT_HASH'", [hash]);
  console.log(`Updated ${r.rowCount} accounts. Login as rguerrero or bagongilog, caniogan, palatiw, maybungabliss3, maybungabliss1, nagpayong with password: ${pw}`);
  await pool.end();
})();
