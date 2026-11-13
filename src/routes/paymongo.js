// PayMongo placeholder. Turn on later with PAYMONGO_ENABLED=true + your keys.
// The payments table already has paymongo_payment_id / paymongo_status for this.
const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { query } = require('../db');

const enabled = () => process.env.PAYMONGO_ENABLED === 'true';

// POST /api/paymongo/checkout  { statementId }  -> would create a PayMongo payment link
router.post('/checkout', requireAuth, requireRole('client'), (req, res) => {
  if (!enabled()) return res.status(503).json({ error: 'Online payment is not enabled yet. Pay via GCash reference or cash.' });
  // TODO: POST https://api.paymongo.com/v1/links with Basic auth (secret key), amount in centavos
  res.status(501).json({ error: 'Not implemented yet' });
});

// POST /api/paymongo/webhook  -> PayMongo calls this when a payment succeeds
router.post('/webhook', async (req, res) => {
  if (!enabled()) return res.sendStatus(404);
  // TODO: verify the Paymongo-Signature header, then mark the matching payment Verified
  // and call applyVerifiedPayment() from services/billing.js
  res.sendStatus(200);
});

module.exports = router;
