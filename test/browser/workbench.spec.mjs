import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.session-item').first()).toBeVisible();
});

test('sessions, native evidence, skill filtering and failures stay distinct', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('.session-item').filter({ hasText: 'API 重试与并行查询' }).click();
  await expect(page.locator('#session-title')).toContainText('API 重试');
  await expect(page.locator('.event-row')).toHaveCount(31);
  const options = await page.locator('#skill-filter option').allTextContents();
  expect(options.length).toBeGreaterThan(1);
  await page.locator('#skill-filter').selectOption({ index: 1 });
  await expect(page.locator('#skill-context')).toBeVisible();
  expect(await page.locator('.event-row').count()).toBeLessThan(31);
  await page.locator('#clear-filters').click();
  await page.locator('#failure-filter').check();
  await expect(page.locator('.event-row')).toHaveCount(0); // A retry is not itself a recorded tool failure.
  await page.locator('.session-item').filter({ hasText: '暂未包含回合结束' }).click();
  await page.locator('#failure-filter').check();
  await expect(page.locator('.event-row')).toHaveCount(1);
  await page.locator('.event-row').first().click();
  await expect(page.locator('#event-detail')).toBeVisible();
  await expect(page.locator('#detail-content')).toContainText('原始');
  await page.locator('#close-detail').click();
  await page.locator('.session-item').filter({ hasText: '暂未包含回合结束' }).click();
  await expect(page.locator('#session-title')).toContainText('暂未包含回合结束');
  await expect(page.locator('#gap-banner')).toContainText('缺口');
  expect(errors).toEqual([]);
});

test('precise sound rule persists and mute does not fall through to category sound', async ({ page }) => {
  await page.locator('[data-tab=sounds]').click();
  await page.locator('#add-rule').click();
  await page.locator('#rule-form [name=type]').fill('test-plugin/browser-event');
  await page.locator('#rule-form [name=sound]').selectOption('mute');
  await page.getByRole('button', { name: '保存规则', exact: true }).click();
  await expect(page.locator('#settings-state')).toHaveText('已保存');
  await page.reload();
  await page.locator('[data-tab=sounds]').click();
  await expect(page.locator('#rule-list')).toContainText('test-plugin/browser-event');
  await page.locator('#catalog-search').fill('SessionStart');
  await expect(page.locator('#catalog-list')).toContainText('SessionStart');
});

test('Web Audio activates on gesture, replay cancels on session switch, imported history is silent', async ({ page }) => {
  await page.evaluate(() => {
    window.__audioStarts = 0;
    const original = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (...args) { window.__audioStarts++; return original.apply(this, args); };
  });
  await page.locator('.session-item').filter({ hasText: 'API 重试与并行查询' }).click();
  await page.locator('#audio-toggle').click();
  await expect(page.locator('#audio-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#replay-speed').selectOption('8');
  await page.locator('#replay-play').click();
  await expect(page.locator('#session-mode')).toHaveText('回放');
  await expect.poll(() => page.evaluate(() => window.__audioStarts)).toBeGreaterThan(0);
  await page.locator('.session-item').filter({ hasText: '暂未包含回合结束' }).click();
  await expect(page.locator('#session-mode')).toHaveText('演示');
  await expect(page.locator('#return-live')).toBeHidden();
  const startsAfterSwitch = await page.evaluate(() => window.__audioStarts);
  const header = { type: 'session', version: 3, id: `browser-import-${Date.now()}`, createdAt: Date.now(), isSeeded: false, delegationDepth: 0, cwd: '/browser-test' };
  const raw = [header, { type: 'turn/start', seq: 0, time: header.createdAt, data: { turn: 1 } }].map(JSON.stringify).join('\n') + '\n';
  await page.locator('#import-file').setInputFiles({ name: 'session.v3.jsonl', mimeType: 'application/octet-stream', buffer: Buffer.from(raw) });
  await expect(page.locator('#session-mode')).toHaveText('导入');
  await expect(page.locator('#session-cwd')).toContainText('/browser-test');
  await expect(page.locator('#replay-label')).toHaveText('回听执行');
  expect(await page.evaluate(() => window.__audioStarts)).toBe(startsAfterSwitch);
});

test('mobile layout stays inside viewport and native detail stays readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.session-item').filter({ hasText: 'API 重试与并行查询' }).click();
  await expect(page.locator('#session-title')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.locator('.event-row').first().click();
  await expect(page.locator('#event-detail')).toBeVisible();
  const box = await page.locator('#event-detail').boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'outputs/dsh-workbench-mobile.png', fullPage: true });
});

test('custom audio uploads and live demo streams into a clearly marked session', async ({ page }) => {
  const existingKeys = new Set((await (await page.request.get('/api/sessions')).json()).sessions.map(s => s.key));
  await page.locator('[data-tab=sounds]').click();
  const sampleCount = 800;
  const wav = Buffer.alloc(44 + sampleCount * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(sampleCount * 2, 40);
  for (let i = 0; i < sampleCount; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI / 10) * 2000), 44 + i * 2);
  await page.locator('#sound-upload').setInputFiles({ name: 'browser-tone.wav', mimeType: 'audio/wav', buffer: wav });
  await expect(page.locator('#asset-list')).toContainText('browser-tone.wav');
  await page.locator('[data-tab=connection]').click();
  await page.locator('#live-demo-button').click();
  await expect.poll(async () => {
    const key = await page.locator('.session-item.selected').getAttribute('data-session-key');
    return Boolean(key) && !existingKeys.has(key);
  }).toBe(true);
  await expect(page.locator('#session-mode')).toHaveText('演示');
  await expect(page.locator('#session-title')).toContainText('演示事件流');
  await expect.poll(async () => await page.locator('.event-row').count(), { timeout: 10000 }).toBeGreaterThan(8);
});

test('each session restores its own investigation without reviving replay', async ({ page }) => {
  const a = page.locator('.session-item').filter({ hasText: 'API 重试与并行查询' });
  const b = page.locator('.session-item').filter({ hasText: '暂未包含回合结束' });
  await a.click();
  await page.locator('#event-search').fill('hook');
  await page.locator('#category-filter').selectOption('hook');
  await page.locator('#follow-button').click();
  await page.locator('.event-row').first().click();
  await expect(page.locator('#event-detail')).toBeVisible();
  await b.click();
  await expect(page.locator('#event-search')).toHaveValue('');
  await expect(page.locator('#category-filter')).toHaveValue('');
  await expect(page.locator('#event-detail')).toBeHidden();
  await a.click();
  await expect(page.locator('#event-search')).toHaveValue('hook');
  await expect(page.locator('#category-filter')).toHaveValue('hook');
  await expect(page.locator('#follow-button')).not.toHaveClass(/active/);
  await expect(page.locator('#event-detail')).toBeVisible();
  await expect(page.locator('#session-mode')).toHaveText('演示');
});

test('identical native IDs from different installations stay visibly distinct and large histories paginate', async ({ page }) => {
  const now = Date.now();
  const keys = [];
  for (const [index, name] of ['A', 'B'].entries()) {
    const source = { instanceId: `browser-installation-${name}-${now}`, kind: 'live', label: '同名来源' };
    const count = index === 0 ? 1005 : 2;
    const events = Array.from({ length: count }, (_, seq) => ({ type: seq === 0 ? 'session/title' : 'browser/plugin-event', seq, time: now + seq, data: seq === 0 ? { title: '同名会话' } : { value: seq } }));
    const response = await page.request.post('/api/import', { headers: { 'X-Symphony-Local': '1' }, data: { format: 'agent-symphony', version: 1, source, session: { id: 'same-native-id', createdAt: now, version: 3, cwd: '/identity-test' }, events } });
    expect(response.ok()).toBe(true);
    keys.push((await response.json()).sessionKeys[0]);
  }
  await page.locator(`[data-session-key="${keys[0]}"]`).click();
  await expect(page.locator('#session-title')).toHaveText('同名会话');
  await expect(page.locator('#session-source-id')).toContainText(`installation-A-${now}`);
  await expect(page.locator('#event-total')).toHaveText('1005');
  await page.locator('#event-search').fill('1004');
  await expect(page.locator('.event-row')).toHaveCount(1);
  await page.locator(`[data-session-key="${keys[1]}"]`).click();
  await expect(page.locator('#session-title')).toHaveText('同名会话');
  await expect(page.locator('#session-source-id')).toContainText(`installation-B-${now}`);
  await expect(page.locator('#event-total')).toHaveText('2');
});
