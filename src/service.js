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
 * install hands over explicitly: a hand-started gateway in the pidfile is stopped
 * after the agent is loaded (never launchd's own, which writes the same pidfile),
 * and launchd's throttled retry picks the port up.
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

/**
 * A binary or PATH directory as launchd should keep it: a path that still leads to the same
 * program after the shell that installed the agents is gone, and after an upgrade it follows.
 *  - fnm: a per-shell multishell link (`…/fnm_multishells/<pid>_<ts>/…`) disappears with its
 *    shell, and `node-versions/<v>/…` stays on <v> after `fnm default` moves on. A path in the
 *    version the default alias points to is written through it (`<fnmDir>/aliases/default/…`),
 *    one in any other version as that version's own path.
 *  - Homebrew: a keg (`…/Cellar/node/26.12.0/…`, which is what process.execPath reports) is
 *    gone after `brew upgrade`; it is written through `…/opt/<formula>/…` while that points at it.
 *  - Anything else as written — a Homebrew `bin/` link, `~/.local/bin/…` — except a multishell
 *    link fnm does not keep versions behind (`fnm use system`): that one is its real path.
 * `fnmDir` is where fnm keeps its versions: $FNM_DIR, else ~/.local/share/fnm.
 */
export function stablePath(p, { fnmDir = process.env.FNM_DIR || path.join(os.homedir(), '.local', 'share', 'fnm') } = {}) {
  const real = realpathOr(p);
  if (!real) return p;
  const versions = realpathOr(path.join(fnmDir, 'node-versions'));
  if (versions && real.startsWith(versions + path.sep)) {
    const [version, installation, ...tail] = real.slice(versions.length + 1).split(path.sep);
    const home = path.join(versions, version, installation || '');
    return realpathOr(path.join(fnmDir, 'aliases', 'default')) === home ? path.join(fnmDir, 'aliases', 'default', ...tail) : real;
  }
  const keg = /^(.+)\/Cellar\/([^/]+)\/([^/]+)(\/.*)?$/.exec(real);
  if (keg) {
    const [, prefix, formula, version, tail = ''] = keg;
    const opt = path.join(prefix, 'opt', formula);
    if (realpathOr(opt) === path.join(prefix, 'Cellar', formula, version)) return opt + tail;
  }
  return /(^|\/)fnm_multishells\//.test(p) ? real : p;
}

function realpathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** A binary for launchd to run: stablePath(), never an fnm multishell shim. */
function resolveBin(bin) {
  return stablePath(bin);
}

/** A PATH that actually finds the user's CLIs under launchd's minimal env, each directory as stablePath() keeps it. */
export function servicePath(pathVar = process.env.PATH, opts = {}) {
  const seen = new Set();
  const dirs = [...(pathVar || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].map((d) => (d ? stablePath(d, opts) : d));
  return dirs.filter((d) => d && !seen.has(d) && seen.add(d)).join(':');
}

/**
 * 077: a log that launchd re-creates — after it was deleted, or rotated away by newsyslog —
 * is opened 0600 instead of 0644, and every CLI the gateway spawns inherits the same mask.
 * Pre-creating the files at install time only covers the first open.
 */
export const PRIVATE_UMASK = 0o077;

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
  <key>Umask</key>
  <integer>${PRIVATE_UMASK}</integer>
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

/** launchctl, returning its stdout; a non-zero exit throws, with launchctl's own stderr on it. */
function launchctl(args) {
  return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function bootout(label, run = launchctl) {
  try {
    run(['bootout', `gui/${uid()}/${label}`]);
    return true;
  } catch {
    return false;
  }
}

export function isLoaded(label, run = launchctl) {
  try {
    run(['print', `gui/${uid()}/${label}`]);
    return true;
  } catch {
    return false;
  }
}

/** The pid launchd reports for a loaded agent's running process; null when it is not loaded or not running. */
export function launchdPid(label, run = launchctl) {
  try {
    const m = /^\tpid = (\d+)$/m.exec(run(['print', `gui/${uid()}/${label}`]));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** What launchctl said on stderr, first line ("Bootstrap failed: 5: Input/output error"). */
function launchctlError(e) {
  return String(e?.stderr || e?.message || e).trim().split('\n')[0];
}

/**
 * Replace a loaded agent with `file`. bootout returns while launchd may still hold the label —
 * the old process is closing — and a bootstrap in that window fails ("Bootstrap failed: 5:
 * Input/output error"), which leaves the agent down. So: wait until `launchctl print` no longer
 * finds the label, then bootstrap, again every `intervalMs` until it takes. Past `timeoutMs` it
 * gives up with the command that finishes the job by hand. `run` stands in for launchctl in tests.
 */
export async function reloadAgent(label, file, { run = launchctl, timeoutMs = 30_000, intervalMs = 1000 } = {}) {
  const domain = `gui/${uid()}`;
  const deadline = Date.now() + timeoutMs;
  const wait = () => new Promise((resolve) => setTimeout(resolve, intervalMs));
  bootout(label, run);
  while (isLoaded(label, run)) {
    if (Date.now() >= deadline) {
      throw new Error(`${label}: launchd still holds the old agent ${timeoutMs / 1000}s after bootout — once \`launchctl print ${domain}/${label}\` fails, load the new one: launchctl bootstrap ${domain} ${file}`);
    }
    await wait();
  }
  for (;;) {
    try {
      run(['bootstrap', domain, file]);
      return;
    } catch (e) {
      if (Date.now() >= deadline) {
        throw new Error(`${label} did not load (${launchctlError(e)}), retried for ${timeoutMs / 1000}s — load it by hand: launchctl bootstrap ${domain} ${file}`);
      }
      await wait();
    }
  }
}

/**
 * Write + load the agents. `nodeBin` and `cloudflared` should be absolute paths
 * (e.g. process.execPath and tunnel.cloudflaredBin()). A named tunnel config
 * yields two agents; otherwise only the gateway. An agent that did not load is in
 * `failed` ({ label, error }); the others are loaded all the same.
 */
export async function installService({ nodeBin, entry, port, cloudflared = null, tunnelName = null, tunnelConfig = null }, reload = {}) {
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

  const failed = [];
  for (const file of written) {
    const label = path.basename(file).replace(/\.plist$/, '');
    try {
      await reloadAgent(label, file, reload);
    } catch (e) {
      failed.push({ label, error: e.message });
    }
  }
  return { files: written, tunnel: tunnelFile != null, failed };
}

/**
 * The gateway the handover stops once the agents are loaded: the pidfile's process when it is
 * alive and is not the one launchd runs for the gateway agent (`launchdPid`). Both write the same
 * pidfile, so a record alone does not say which; stopping launchd's own would take down the
 * gateway just started. Null when there is nothing to stop.
 */
export function handoverPid(rec, { launchdPid = null, alive }) {
  const pid = Number(rec?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid === launchdPid) return null;
  return alive(pid) ? pid : null;
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
