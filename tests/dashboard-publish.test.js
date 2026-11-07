import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
test('Python publisher admission and deploy wiring fixtures', () => {
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'packages/dashboard-publish', '-p', 'test_*.py', '-v'], { encoding: 'utf8' });
  expect(result.stdout + result.stderr).toContain('OK');
  expect(result.status).toBe(0);
});
