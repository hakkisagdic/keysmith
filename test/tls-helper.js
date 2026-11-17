/**
 * A throwaway https server for tests: a self-signed certificate for 127.0.0.1 made with openssl at
 * run time (nothing secret is committed), trusted by a child process through NODE_EXTRA_CA_CERTS.
 */
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let made = null;

/** { key, cert, file }: the PEM texts, and the certificate's path (for NODE_EXTRA_CA_CERTS). */
export function selfSigned() {
  if (made) return made;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-tls-'));
  const keyFile = path.join(dir, 'k.pem');
  const file = path.join(dir, 'c.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', file, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl could not make a test certificate: ${r.stderr}`);
  made = { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(file, 'utf8'), file };
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return made;
}

/** Starts an https server on 127.0.0.1; returns it listening. */
export async function httpsServer(handler) {
  const { key, cert } = selfSigned();
  const srv = https.createServer({ key, cert }, handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return srv;
}
