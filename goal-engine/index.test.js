import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGoalStartOptions,
  parseSlashGoalCommand,
  stripWrappingQuotes,
} from './index.js';

test('stripWrappingQuotes handles straight and smart wrapping quotes', () => {
  assert.equal(stripWrappingQuotes('"Refactor auth"'), 'Refactor auth');
  assert.equal(stripWrappingQuotes('“Refactor auth”'), 'Refactor auth');
  assert.equal(stripWrappingQuotes("'Refactor auth'"), 'Refactor auth');
});

test('parseGoalStartOptions matches Pi /goal flags for quoted objectives', () => {
  const parsed = parseGoalStartOptions('"Refactor auth module" --max-turns 7 --verify "npm test -- --runInBand"');
  assert.deepEqual(parsed, {
    objective: 'Refactor auth module',
    maxTurns: 7,
    verifyCommand: 'npm test -- --runInBand',
  });
});

test('parseSlashGoalCommand supports status show/hide and bare quoted objectives', () => {
  assert.deepEqual(parseSlashGoalCommand('/goal status hide'), {
    kind: 'status',
    mode: 'hide',
  });
  assert.deepEqual(parseSlashGoalCommand('/goal “Write docs” --max-turns 2'), {
    kind: 'start',
    options: { objective: 'Write docs', maxTurns: 2, verifyCommand: null },
  });
});
