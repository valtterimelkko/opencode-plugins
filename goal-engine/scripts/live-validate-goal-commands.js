#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const socketPath = arg('--socket', `${os.homedir()}/.pi-web-ui/internal-api.sock`);
const tokenPath = arg('--token-path', `${os.homedir()}/.pi-web-ui/internal-api-token`);
const cwd = arg('--cwd', '/root/opencode-plugins');
const model = arg('--model', 'zai-coding-plan/glm-5.1');
const token = (await fs.readFile(tokenPath, 'utf8')).trim();

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: route,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk.toString(); });
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`${method} ${route} failed: ${res.statusCode} ${raw}`));
          return;
        }
        resolve(raw.trim() ? JSON.parse(raw) : {});
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function prompt(sessionId, message) {
  return request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompt`, {
    message,
    verbosity: 'answers',
    mode: 'prompt',
  });
}

async function goalState(nativeSessionId) {
  const file = path.join(os.homedir(), '.opencode', 'goal-engine', `${nativeSessionId}.goal.json`);
  try {
    return { file, state: JSON.parse(await fs.readFile(file, 'utf8')) };
  } catch {
    return { file, state: null };
  }
}

function assertStep(condition, label, details = '') {
  if (!condition) throw new Error(`FAIL ${label}${details ? ` — ${details}` : ''}`);
  console.log(`PASS ${label}${details ? ` — ${details}` : ''}`);
}

const created = await request('POST', '/api/v1/sessions', {
  runtime: 'opencode',
  cwd,
  model,
  ephemeral: false,
});
const sessionId = created.sessionId;
let nativeSessionId;

try {
  await prompt(sessionId, 'Use the goal_engine tool now: action="start", objective="Quick live validation of goal command actions. Stay active until explicitly cleared; each incomplete response should end with Status: CONTINUING.", max_turns=20. After calling it, reply briefly with Status: CONTINUING.');
  let info = await request('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/info`);
  nativeSessionId = info.nativeSessionId;
  assertStep(nativeSessionId?.startsWith('ses_'), 'native OpenCode session id exposed', nativeSessionId);
  assertStep(info.model === model, 'requested model persisted', info.model);

  let { state } = await goalState(nativeSessionId);
  assertStep(state?.objective?.includes('Quick live validation'), 'start action persisted objective');
  assertStep(state?.status === 'running', 'start action leaves goal running', state?.status);

  await prompt(sessionId, '/goal status hide');
  ({ state } = await goalState(nativeSessionId));
  assertStep(state?.showWidget === false, '/goal status hide updates widget state');

  await prompt(sessionId, '/goal status show');
  ({ state } = await goalState(nativeSessionId));
  assertStep(state?.showWidget === true, '/goal status show updates widget state');

  const report = await prompt(sessionId, '/goal report');
  assertStep(String(report.content ?? '').includes('Quick live validation'), '/goal report returns active goal text');

  await prompt(sessionId, 'Use the goal_engine tool now: action="set_limit", max_turns=7. Reply briefly.');
  ({ state } = await goalState(nativeSessionId));
  assertStep(state?.maxTurns === 7, 'set_limit action persists maxTurns', String(state?.maxTurns));

  await prompt(sessionId, 'Use the goal_engine tool now: action="pause_now". Reply briefly.');
  ({ state } = await goalState(nativeSessionId));
  assertStep(state?.status === 'paused', 'pause_now action pauses goal', state?.status);

  await prompt(sessionId, 'Use the goal_engine tool now: action="resume". Reply briefly with Status: CONTINUING.');
  ({ state } = await goalState(nativeSessionId));
  assertStep(state?.status === 'running', 'resume action resumes goal', state?.status);

  await prompt(sessionId, 'Use the goal_engine tool now: action="pause". Reply briefly.');
  ({ state } = await goalState(nativeSessionId));
  assertStep(state?.status === 'paused' || state?.status === 'wrapping-up', 'pause action requests/enters paused state', state?.status);

  await prompt(sessionId, 'Use the goal_engine tool now: action="clear", confirmed=true. Reply briefly.');
  ({ state } = await goalState(nativeSessionId));
  assertStep(!state || state.status === 'idle' || !state.objective, 'clear action removes active goal');

  console.log(JSON.stringify({ success: true, sessionId, nativeSessionId, model }, null, 2));
} finally {
  if (sessionId) {
    await request('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}`).catch(() => undefined);
  }
}
