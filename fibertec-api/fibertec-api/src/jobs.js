const cron = require('node-cron');
const { query } = require('./db');
const { generateStatementsForToday, sendPendingStatements, runStatusEngine } = require('./services/billing');

function startJobs() {
  // every day 00:05 Manila time: statements -> send -> status changes -> purge old history
  cron.schedule('5 0 * * *', async () => {
    try {
      const created = await generateStatementsForToday();
      const sent = await sendPendingStatements();
      const st = await runStatusEngine();
      await query('SELECT purge_old_records()');           // deletes anything older than 6 months
      console.log('[daily]', { created, sent, st });
    } catch (e) { console.error('[daily job failed]', e); }
  }, { timezone: 'Asia/Manila' });
}
module.exports = { startJobs };
