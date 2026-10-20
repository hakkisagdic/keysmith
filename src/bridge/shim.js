#!/usr/bin/env node
/**
 * The MCP server a CLI starts for the bridge (design §3, U6): `node src/bridge/shim.js`, with
 * KEYSMITH_BRIDGE_SOCK (the gateway's Unix socket) and KEYSMITH_BRIDGE_TOKEN (its session's
 * token) in its environment, both written by keysmith into the session's agent file.
 *
 * It knows nothing about MCP. It connects, sends one hello line with the token, and from then on
 * copies bytes both ways — stdin to the socket, the socket to stdout — so the gateway's hub
 * (src/bridge/hub.js) is the MCP server the CLI talks to. When either side ends, it ends: a
 * refused token is a closed socket, and the CLI sees its MCP server exit.
 *
 * It prints nothing of what it carries, and never the token.
 */
import net from 'node:net';

const sock = process.env.KEYSMITH_BRIDGE_SOCK;
const token = process.env.KEYSMITH_BRIDGE_TOKEN;
if (!sock || !token) {
  process.stderr.write('keysmith bridge shim: KEYSMITH_BRIDGE_SOCK and KEYSMITH_BRIDGE_TOKEN must be set (keysmith writes them into the agent file)\n');
  process.exit(2);
}

const conn = net.connect(sock);
let connected = false;
conn.on('connect', () => {
  connected = true;
  conn.write(JSON.stringify({ keysmith_bridge: 1, token }) + '\n');
  process.stdin.pipe(conn);
  conn.pipe(process.stdout);
});
conn.on('error', (e) => {
  // Once connected, an error is the gateway closing the connection (a refused token, a closed
  // session): 'close' follows, and ends this the same way.
  if (connected) return;
  process.stderr.write(`keysmith bridge shim: ${e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'the gateway is not listening on its bridge socket' : `socket error ${e.code || ''}`.trim()}\n`);
  process.exit(1);
});
// The gateway closed the session (or refused it): there is nothing left to serve. Stop reading,
// and let the process end once what is on its way to stdout is written (a pipe is written
// asynchronously on macOS: process.exit() here could drop the last response).
conn.on('close', () => {
  process.stdin.unpipe(conn);
  process.stdin.destroy();
});
// The CLI closed our stdin: it is done with this server.
process.stdin.on('end', () => conn.end());
process.stdout.on('error', () => process.exit(0));
