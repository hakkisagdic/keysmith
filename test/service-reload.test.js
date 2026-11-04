/**
 * How `keysmith install-service` swaps a loaded agent for the new one, and which gateway its
 * handover stops. launchctl is a fake that answers the way launchd did live: the label still
 * there for a while after bootout, a bootstrap in that window refused with "5". Nothing is loaded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reloadAgent, launchdPid, handoverPid } from '../src/service.js';

const LABEL = 'dev.keysmith.gateway';
const FILE = '/Users/x/Library/LaunchAgents/dev.keysmith.gateway.plist';
const fast = { timeoutMs: 200, intervalMs: 1 };

function refused(stderr) {
  return Object.assign(new Error('Command failed: launchctl'), { stderr });
}

/** launchctl that keeps the label `held` prints after bootout, and refuses the first `refusals` bootstraps. */
function fakeLaunchctl({ held = 0, refusals = 0 } = {}) {
  const calls = [];
  let loaded = true;
  const run = (args) => {
    calls.push(args[0]);
    if (args[0] === 'bootout') return '';
    if (args[0] === 'print') {
      if (loaded && held-- > 0) return `${LABEL} = {\n\tstate = running\n}\n`;
      loaded = false;
      throw refused(`Bad request.\nCould not find service "${LABEL}" in domain for user gui: 501\n`);
    }
    if (args[0] === 'bootstrap') {
      if (refusals-- > 0) throw refused('Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.\n');
      return '';
    }
    throw new Error(`unexpected launchctl ${args.join(' ')}`);
  };
  return { run, calls };
}

test('reloadAgent bootstraps only once launchd has let go of the old agent', async () => {
  const { run, calls } = fakeLaunchctl({ held: 3 });
  await reloadAgent(LABEL, FILE, { run, ...fast });
  assert.deepEqual(calls, ['bootout', 'print', 'print', 'print', 'print', 'bootstrap']);
});

test('reloadAgent tries the bootstrap again when launchd refuses it with "5"', async () => {
  const { run, calls } = fakeLaunchctl({ refusals: 2 });
  await reloadAgent(LABEL, FILE, { run, ...fast });
  assert.deepEqual(calls.filter((c) => c === 'bootstrap'), ['bootstrap', 'bootstrap', 'bootstrap']);
});

test('reloadAgent gives up past the deadline with the command that finishes the job', async () => {
  const stuck = fakeLaunchctl({ held: Infinity });
  await assert.rejects(reloadAgent(LABEL, FILE, { run: stuck.run, ...fast }), (e) => {
    assert.match(e.message, /dev\.keysmith\.gateway: launchd still holds the old agent/);
    assert.match(e.message, /launchctl bootstrap gui\/\d+ \/Users\/x\/Library\/LaunchAgents\/dev\.keysmith\.gateway\.plist/);
    return true;
  });
  assert.ok(!stuck.calls.includes('bootstrap'), 'no bootstrap while the old agent is still there');

  const refusing = fakeLaunchctl({ refusals: Infinity });
  await assert.rejects(reloadAgent(LABEL, FILE, { run: refusing.run, ...fast }), (e) => {
    assert.match(e.message, /dev\.keysmith\.gateway did not load \(Bootstrap failed: 5: Input\/output error\)/);
    assert.doesNotMatch(e.message, /re-running the command as root/, 'first line of launchctl\'s stderr only');
    assert.match(e.message, /load it by hand: launchctl bootstrap gui\/\d+ /);
    return true;
  });
});

test('launchdPid reads the running process off `launchctl print`', () => {
  const print = (body) => () => `${LABEL} = {\n\tactive count = 1\n${body}\tendpoints = {\n\t\tpid = 777\n\t}\n}\n`;
  assert.equal(launchdPid(LABEL, print('\tstate = running\n\tpid = 39109\n')), 39109);
  assert.equal(launchdPid(LABEL, print('\tstate = spawn scheduled\n')), null, 'loaded, not running; a nested pid is not the job\'s');
  assert.equal(launchdPid(LABEL, () => { throw refused('Could not find service'); }), null, 'not loaded');
});

test('handoverPid stops a gateway started by hand, never the one launchd runs', () => {
  const live = new Set([100, 200]);
  const alive = (pid) => live.has(pid);
  assert.equal(handoverPid({ pid: 100, port: 8787 }, { launchdPid: 200, alive }), 100, 'keysmith start\'s gateway');
  assert.equal(handoverPid({ pid: 100, port: 8787 }, { launchdPid: null, alive }), 100, 'no agent running yet');
  assert.equal(handoverPid({ pid: 200, port: 8787 }, { launchdPid: 200, alive }), null, 'the new agent already wrote the pidfile');
  assert.equal(handoverPid({ pid: 300, port: 8787 }, { launchdPid: 200, alive }), null, 'gone already');
  assert.equal(handoverPid(null, { launchdPid: 200, alive }), null);
  assert.equal(handoverPid({ pid: 'x' }, { launchdPid: null, alive: () => true }), null);
  assert.equal(handoverPid({ pid: 0 }, { launchdPid: null, alive: () => true }), null, 'kill(0) would signal the whole group');
});
