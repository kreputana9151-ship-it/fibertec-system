// one place to write activity_log + account_status_log + notices
async function logActivity(c, userId, branchCode, description) {
  await c.query(
    'INSERT INTO activity_log (user_id, branch_code, description) VALUES ($1,$2,$3)',
    [userId, branchCode || null, description]
  );
}

async function changeStatus(c, accountNo, newStatus, reason, userId, extra = {}) {
  const { rows } = await c.query('SELECT status FROM clients WHERE account_no=$1 FOR UPDATE', [accountNo]);
  if (!rows.length) throw new Error('Client not found');
  const old = rows[0].status;
  const savedReason = newStatus === 'Under Review'
    ? (String(reason || '').trim() || 'Flagged for account review')
    : reason;
  if (old === newStatus) {
    if (newStatus === 'Under Review') {
      await c.query(
        `UPDATE clients
            SET status_reason=COALESCE(NULLIF(BTRIM(status_reason), ''), $2::varchar(60)),
                flagged_date=COALESCE(flagged_date, $3::date,
                  (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)
          WHERE account_no=$1::char(8)`,
        [accountNo, savedReason, extra.flagged || null]
      );
    }
    return old;
  }
  await c.query(
    `UPDATE clients SET status=$2::varchar(15), status_reason=$3::varchar(60),
       flagged_date=CASE WHEN $2::varchar(15)='Under Review'
                         THEN COALESCE($4::date, (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date)
                         ELSE $4::date END,
       grace_end_date=$5::date,
       termination_date=COALESCE($6::date, CASE WHEN $2::varchar(15)='Terminated' THEN (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date END),
       termination_reason=$7::varchar(60),
       current_balance=COALESCE((
         SELECT SUM(GREATEST(s.amount - COALESCE(v.verified_paid, 0), 0))
           FROM statements s
           LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(p.amount), 0) AS verified_paid
               FROM payments p
              WHERE p.statement_id=s.statement_id AND p.status='Verified'
           ) v ON TRUE
          WHERE s.account_no=$1::char(8)
       ), 0)
     WHERE account_no=$1::char(8)`,
    [accountNo, newStatus, savedReason, extra.flagged || null, extra.graceEnd || null,
     extra.termDate || null, extra.termReason || null]
  );
  await c.query(
    'INSERT INTO account_status_log (account_no, old_status, new_status, reason, changed_by) VALUES ($1,$2,$3,$4,$5)',
    [accountNo, old, newStatus, savedReason, userId || null]
  );
  return old;
}

async function addNotice(c, { accountNo, statementId, type, channel = 'Email', status = 'Pending', message = null }) {
  const { rows } = await c.query('SELECT email FROM clients WHERE account_no=$1', [accountNo]);
  const recipient = channel === 'Email' ? rows[0].email : 'Client Portal Bell';
  const r = await c.query(
    `INSERT INTO notices (account_no, statement_id, notice_date, channel, recipient, notice_type, delivery_status, message)
     VALUES ($1,$2,current_date,$3,$4,$5,$6,$7) RETURNING notice_id`,
    [accountNo, statementId || null, channel, recipient, type, status, message]
  );
  return r.rows[0].notice_id;
}

module.exports = { logActivity, changeStatus, addNotice };
