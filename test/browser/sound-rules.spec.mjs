import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.session-item').first()).toBeVisible();
});

test('keyword template previews dissonance, persists and remains usable on mobile', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    window.__previewFrequencies = [];
    const scheduled = new WeakMap();
    const setValue = AudioParam.prototype.setValueAtTime;
    AudioParam.prototype.setValueAtTime = function (value, ...args) {
      scheduled.set(this, value);
      return setValue.call(this, value, ...args);
    };
    const start = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (...args) {
      // AudioParam.value can still be the initial 440 Hz until the audio clock advances.
      if (this instanceof OscillatorNode) window.__previewFrequencies.push(scheduled.get(this.frequency));
      return start.apply(this, args);
    };
  });
  await page.locator('[data-tab=sounds]').click();
  const previousCount = await page.locator('.rule-item').count();
  await page.locator('#add-watch-rule').click();
  await expect(page.locator('#rule-form [name=callContains]')).toHaveValue('gstack');
  await expect(page.locator('#rule-form [name=sound]')).toHaveValue('dissonance');
  await page.locator('#preview-rule').click();
  await expect.poll(() => page.evaluate(() => window.__previewFrequencies.length)).toBe(2);
  const frequencies = await page.evaluate(() => window.__previewFrequencies);
  expect(frequencies[0]).toBeCloseTo(330);
  expect(frequencies[1]).toBeCloseTo(349.23);
  await page.screenshot({ path: testInfo.outputPath('keyword-rule-desktop.png') });
  await page.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect(page.locator('#settings-state')).toHaveText('已保存');
  await page.reload();
  await page.locator('[data-tab=sounds]').click();
  await expect(page.locator('.rule-item')).toHaveCount(previousCount + 1);
  await expect(page.locator('.rule-item').first()).toContainText('调用关键词 包含 gstack');
  await expect(page.locator('.rule-item').first()).toContainText('不和谐音');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.rule-item').first().getByRole('button', { name: '编辑规则' }).click();
  await expect(page.locator('#rule-form [name=callContains]')).toHaveValue('gstack');
  expect(await page.locator('#rule-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.getByRole('button', { name: '保存规则', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '保存规则', exact: true })).toBeInViewport();
  await page.locator('#rule-dialog').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('keyword-rule-mobile.png') });
});

test('name modes survive editing and keyword evidence identifies arguments without classifying mentions', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('[data-tab=sounds]').click();
  await page.locator('#add-rule').click();
  await page.locator('#rule-form [name=toolNameMode]').selectOption('contains');
  await page.locator('#rule-form [name=toolName]').fill('GSTACK');
  await page.locator('#rule-form [name=sound]').selectOption('dissonance');
  await page.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect(page.locator('#settings-state')).toHaveText('已保存');
  await page.reload();
  await page.locator('[data-tab=sounds]').click();
  await page.locator('.rule-item').first().getByRole('button', { name: '编辑规则' }).click();
  await expect(page.locator('#rule-form [name=toolNameMode]')).toHaveValue('contains');
  await expect(page.locator('#rule-form [name=toolName]')).toHaveValue('GSTACK');
  await page.locator('#rule-form [name=toolName]').fill('');
  await page.locator('#rule-form [name=skillName]').fill('review');
  await expect(page.locator('#rule-form [name=skillNameMode]')).toHaveValue('equals');
  await page.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect(page.locator('#settings-state')).toHaveText('已保存');
  await page.locator('#add-watch-rule').click();
  await page.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect(page.locator('#settings-state')).toHaveText('已保存');

  const now = Date.now();
  const raw = (type, seq, data) => ({ type, seq, time: now + seq * 1000, data });
  const path = `/skills/${'long-prefix/'.repeat(40)}gstack/review/SKILL.md`;
  const imported = await page.request.post('/api/import', { headers: { 'X-Symphony-Local': '1' }, data: {
    format: 'agent-symphony', version: 1,
    source: { instanceId: `keyword-browser-${now}`, kind: 'demo', label: '关键词测试' },
    session: { id: `keyword-${now}`, createdAt: now, version: 3, cwd: '/keyword-test' },
    events: [
      raw('tool/call', 0, { turn: 1, step: 1, callId: 'read-1', name: 'read', arguments: JSON.stringify({ path }) }),
      raw('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'Do not use gstack' }] }),
      raw('tool/call', 2, { turn: 1, step: 1, callId: 'skill-1', name: 'skill', arguments: { name: 'review' } }),
      raw('tool/call', 3, { turn: 1, step: 1, callId: 'ordinary', name: 'read', arguments: { path: '/project/readme.md' } }),
    ],
  } });
  expect(imported.ok()).toBe(true);
  const key = (await imported.json()).sessionKeys[0];
  await page.locator(`[data-session-key="${key}"]`).click();
  await page.locator('[data-tab=events]').click();
  await expect(page.locator('.event-row')).toHaveCount(4);
  await expect(page.locator('.event-row').nth(0).locator('.event-sound')).toContainText('不和谐音');
  await expect(page.locator('.event-row').nth(1).locator('.event-sound')).not.toContainText('不和谐音');
  await expect(page.locator('.event-row').nth(2).locator('.event-sound')).toContainText('不和谐音');
  await expect(page.locator('.event-row').nth(3).locator('.event-sound')).not.toContainText('不和谐音');
  await page.locator('.event-row').first().click();
  await expect(page.locator('.match-evidence')).toContainText('调用参数包含「gstack」');
  await expect(page.locator('.match-evidence')).toContainText('gstack/review/SKILL.md');
  await page.locator('#close-detail').click();
  await page.locator('.event-row').nth(2).click();
  await expect(page.locator('.match-evidence')).toContainText('Skill精确匹配「review」');
  expect(errors).toEqual([]);
});
