require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { startJobs } = require('./jobs');

const ROOT = path.join(__dirname, '..');
const port = process.env.PORT || 3000;
const useHttps = Boolean(process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH);
const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
const host = process.env.APP_HOST || 'localhost';
const defaultPort = useHttps ? 443 : 80;
const address = `${useHttps ? 'https' : 'http'}://${host}${Number(port) === defaultPort ? '' : ':' + port}`;
process.env.APP_URL = process.env.APP_URL || address;                // used in password-reset emails

const app = express();

// Always trust Render / reverse proxy headers in production so secure cookies and req.secure work
if (process.env.TRUST_PROXY === 'true' || isProd) {
  app.set('trust proxy', 1);
}

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src-attr': ["'unsafe-inline'"],                        // pages use inline onclick/onsubmit
      'upgrade-insecure-requests': (useHttps || isProd) ? [] : null  // upgrade when serving https or behind Render TLS
    }
  },
  strictTransportSecurity: useHttps || isProd || process.env.FORCE_HTTPS === 'true'
}));

if (process.env.FORCE_HTTPS === 'true') {                            // for hosting that terminates TLS (Render, Railway, ...)
  app.use((req, res, next) => req.secure ? next() : res.redirect(301, `https://${req.headers.host}${req.originalUrl}`));
}
if (process.env.CORS_ORIGIN) {
  app.use(cors({ origin: process.env.CORS_ORIGIN.split(','), credentials: true }));
}
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/client',   require('./routes/client'));
app.use('/api/staff',    require('./routes/staff'));
app.use('/api/admin',    require('./routes/admin'));
app.use('/api/paymongo', require('./routes/paymongo'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(ROOT, 'public')));                  // frontend, same origin as the API

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

function createServer() {
  if (!useHttps) return http.createServer(app);
  try {
    return https.createServer({
      key: fs.readFileSync(path.resolve(ROOT, process.env.SSL_KEY_PATH)),
      cert: fs.readFileSync(path.resolve(ROOT, process.env.SSL_CERT_PATH))
    }, app);
  } catch (e) {
    console.error(`Cannot read the SSL certificate (${e.message}).\nRun "npm run cert" first, or remove SSL_KEY_PATH / SSL_CERT_PATH from .env to use plain http.`);
    process.exit(1);
  }
}

createServer().listen(port, () => {
  console.log(`FiberTec running on ${address}`);
  startJobs();
});