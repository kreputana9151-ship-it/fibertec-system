// npm run cert -> self-signed certificate for https://<APP_HOST> and localhost (development only)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const dir = path.join(__dirname, '..', 'certs');
fs.mkdirSync(dir, { recursive: true });

const host = process.env.APP_HOST || 'localhost';
const pems = selfsigned.generate([{ name: 'commonName', value: host }], {
  days: 365,
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [
    { name: 'basicConstraints', cA: false },
    { name: 'subjectAltName', altNames: [
      { type: 2, value: host },
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      { type: 7, ip: '::1' }
    ] }
  ]
});

fs.writeFileSync(path.join(dir, 'localhost-key.pem'), pems.private);
fs.writeFileSync(path.join(dir, 'localhost.pem'), pems.cert);
console.log('Created certs/localhost-key.pem and certs/localhost.pem (valid 365 days).');
