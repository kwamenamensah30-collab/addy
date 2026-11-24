// Creates a self-signed certificate in ./certs so phones on the same Wi-Fi can use GPS over https://.
// Needs the openssl program (it ships with Git for Windows).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'certs');
fs.mkdirSync(dir, { recursive: true });
const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4').map(i => i.address);
const san = ['DNS:localhost', ...ips.map(ip => 'IP:' + ip)].join(',');
const candidates = ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe'];
let done = false;
for (const bin of candidates) {
  try {
    execFileSync(bin, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825', '-subj', '/CN=Addy',
      '-addext', `subjectAltName=${san}`, '-addext', 'extendedKeyUsage=serverAuth',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'pipe', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    done = true; break;
  } catch { /* try the next location */ }
}
if (!done) { console.error('Could not find openssl. Install Git for Windows, or put key.pem and cert.pem in ./certs yourself.'); process.exit(1); }
console.log(`Certificate written to ${dir}`);
console.log(`Valid for: ${san}`);
console.log('Restart the server. On each phone, open the https:// address once and accept the browser warning (it is your own certificate).');
console.log('If this computer gets a new Wi-Fi address later, run "npm run cert" again.');
