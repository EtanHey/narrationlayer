import { test, expect } from 'bun:test';
import { nodeSpawnChecked } from './support/spawn.js';
const TEST_BUDGET_MS = 60_000, CHILD_BUDGET_MS = 45_000;
test('Python publisher admission and deploy wiring fixtures', () => {
  const result = nodeSpawnChecked('python3', ['-m', 'unittest', 'discover', '-s', 'packages/dashboard-publish', '-p', 'test_*.py', '-v'], { timeout: CHILD_BUDGET_MS });
  expect(result.stdout + result.stderr).toContain('OK');
  expect(result.status).toBe(0);
}, TEST_BUDGET_MS);
