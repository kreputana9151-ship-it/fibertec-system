require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { startJobs } = require('./jobs');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/client',   require('./routes/client'));
app.use('/api/staff',    require('./routes/staff'));
app.use('/api/admin',    require('./routes/admin'));
app.use('/api/paymongo', require('./routes/paymongo'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

const port = process.env.PORT || 3000;
app.listen(port, () => { console.log(`FiberTec API on http://localhost:${port}`); startJobs(); });
