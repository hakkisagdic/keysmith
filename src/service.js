import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { logDir, precreatePrivateLogs } from './logfiles.js';

/**
 * launchd persistence (macOS). Two agents, deliberately separate:
 *
 *   dev.keysmith.gateway  node cli.js serve   — dies → restart, boot → start
 *   dev.keysmith.tunnel   cloudflared run     — dies → restart, boot → start
 *
 * Separate so a tunnel restart never takes the gateway down with it, and so the
 * tunnel agent can be absent entirely when only a quick tunnel is configured
 * (a quick tunnel's hostname is random per start; persisting it buys nothing).
 *
 * `keysmith start` (nohup) and these agents fight over the same port, so
 * install hands over explicitly: old pidfile process is stopped after the
 * agent is loaded, and launchd's throttled retry picks the port up.
 */

export function launchAgentsDir() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

export { logDir };

/** The two files launchd opens for the agents' stdout/stderr. */
export function launchdLogFiles(dir = logDir()) {
  return [path.join(dir, 'launchd-gateway.log'), path.join(dir, 'launchd-tunnel.log')];
}

const GATEWAY_LABEL = 'dev.keysmith.gateway';
const TUNNEL_LABEL = 'dev.keysmith.tunnel';

export const labels = { gateway: GATEWAY_LABEL, tunnel: TUNNEL_LABEL };

/** Realpath a binary: launchd must not be pointed at an fnm multishell shim. */
function resolveBin(bin) {
  try {
    return realpathSync(bin);
  } catch {
    return bin;
  }
}

/** A PATH that actually finds the user's CLIs under launchd's minimal env. */
function servicePath() {
  const seen = new Set();
  const dirs = [...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return dirs.filter((d) => d && !seen.has(d) && seen.add(d)).join(':');
}

/** Minimal plist builder — enough for a LaunchAgent, no dependency needed. */
export function plist({ label, programArguments, workingDirectory, standardOutPath, standardErrorPath, processType = null }) {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((a) => `    <string>${esc(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(servicePath())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
${processType ? `  <key>ProcessType</key>\n  <string>${esc(processType)}</string>\n` : ''}  <key>StandardOutPath</key>
  <string>${esc(standardOutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(standardErrorPath)}</string>
</dict>
</plist>
`;
}

export function gatewayPlist({ nodeBin, entry, port }) {
  const log = launchdLogFiles()[0];
  return plist({
    label: GATEWAY_LABEL,
    programArguments: [resolveBin(nodeBin), entry, 'serve', '--port', String(port)],
    workingDirectory: path.dirname(entry),
    standardOutPath: log,
    standardErrorPath: log,
    // A job with no ProcessType gets launchd's "light resource limits": it, and every CLI
    // it spawns, runs at utility priority (20, not 31) with throttled I/O. On a busy
    // machine that is most of the wait: agy's first token took 9-30 s under the default
    // and 3.9-5.0 s as Interactive, same code, same config, calls interleaved. The gateway
    // answers someone who is waiting, which is what launchd means by Interactive. The
    // tunnel only forwards bytes and was not measured, so it keeps the default.
    processType: 'Interactive',
  });
}

export function tunnelPlist({ cloudflared, name, configFile }) {
  const log = launchdLogFiles()[1];
  return plist({
    label: TUNNEL_LABEL,
    programArguments: [resolveBin(cloudflared), 'tunnel', '--no-autoupdate', '--config', configFile, 'run', name],
    workingDirectory: path.dirname(configFile),
    standardOutPath: log,
    standardErrorPath: log,
  });
}

function uid() {
  return process.getuid();
}

function bootout(label) {
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid()}/${label}`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function bootstrap(file) {
  execFileSync('launchctl', ['bootstrap', `gui/${uid()}`, file], { stdio: ['ignore', 'pipe', 'pipe'] });
}

export function isLoaded(label) {
  try {
    execFileSync('launchctl', ['print', `gui/${uid()}/${label}`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write + load the agents. `nodeBin` and `cloudflared` should be absolute paths
 * (e.g. process.execPath and tunnel.cloudflaredBin()). A named tunnel config
 * yields two agents; otherwise only the gateway.
 */
export function installService({ nodeBin, entry, port, cloudflared = null, tunnelName = null, tunnelConfig = null }) {
  const dir = launchAgentsDir();
  fs.mkdirSync(dir, { recursive: true });
  // launchd creates a missing StandardOutPath with the default umask — 0644, readable by
  // every account on the machine. Created here first, 0600 in a 0700 directory, it is
  // opened as it is.
  precreatePrivateLogs(launchdLogFiles());

  const written = [];
  const gwFile = path.join(dir, `${GATEWAY_LABEL}.plist`);
  fs.writeFileSync(gwFile, gatewayPlist({ nodeBin, entry, port }));
  written.push(gwFile);

  let tunnelFile = null;
  if (tunnelName && tunnelConfig && cloudflared) {
    tunnelFile = path.join(dir, `${TUNNEL_LABEL}.plist`);
    fs.writeFileSync(tunnelFile, tunnelPlist({ cloudflared, name: tunnelName, configFile: tunnelConfig }));
    written.push(tunnelFile);
  }

  for (const file of written) {
    bootout(path.basename(file).replace(/\.plist$/, ''));
    bootstrap(file);
  }
  return { files: written, tunnel: tunnelFile != null };
}

export function uninstallService() {
  const dir = launchAgentsDir();
  const removed = [];
  for (const label of [GATEWAY_LABEL, TUNNEL_LABEL]) {
    bootout(label);
    const file = path.join(dir, `${label}.plist`);
    try {
      fs.unlinkSync(file);
      removed.push(file);
    } catch {}
  }
  return removed;
}
