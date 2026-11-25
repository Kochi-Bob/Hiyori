import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';

const catalog = JSON.parse(await readFile(new URL('../../app/public/packs/catalog.json', import.meta.url), 'utf8')) as {
  packs: { id: string; version: string }[];
};

test.beforeEach(async ({ context, baseURL }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === baseURL
    ? route.continue()
    : route.abort());
});

test('installs the bundled books, searches across textbooks and keeps learning records after reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '今天，也学一点日语。' })).toBeVisible();
  const nav = page.locator('.sidebar nav');
  await nav.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '内容与备份' }).click();
  for (const pack of catalog.packs) await expect(page.getByText(`${pack.id} · v${pack.version}`, { exact: true })).toBeVisible();

  await nav.getByRole('button', { name: '知识检索' }).click();
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByRole('navigation', { name: '检索分页' })).toContainText('第 2 /');
  await page.getByRole('textbox', { name: '搜索词汇或语法' }).fill('ｶﾞｸｾｲ');
  await page.getByRole('combobox', { name: '教材筛选' }).selectOption('beginner-1');
  await page.getByRole('button', { name: /^学生 がくせい / }).click();

  const detail = page.getByRole('dialog', { name: '知识手记' });
  const course = detail.getByRole('region', { name: '新版标准日本语 初级上' });
  const red = detail.getByRole('region', { name: /红宝书/ });
  await expect(course.getByRole('heading', { name: '（大）学生' })).toBeVisible();
  await expect(red.getByRole('heading', { name: '学生', exact: true })).toBeVisible();
  for (const block of [course, red]) {
    await expect(block.locator('.sources')).toContainText(/PDF \d+/);
    await expect(block.locator('.sources').getByRole('link').or(block.locator('.sources').getByRole('button'))).toHaveCount(0);
  }
  await detail.getByRole('button', { name: '收藏', exact: true }).click();
  await expect(detail.getByRole('button', { name: '收藏', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const note = detail.getByRole('textbox', { name: '我的笔记' });
  await note.fill('课后复习');
  await note.blur();
  await expect(page.getByText('笔记已保存', { exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: /^日本語 01 .*第 1 课/ }).click();
  const reading = page.locator('.reading-paper');
  await expect(reading.getByRole('heading', { name: '基本课文' })).toBeVisible();
  await expect(reading.locator('.sources')).toContainText(/PDF \d+/);
  await expect(reading.locator('.sources').getByRole('link').or(reading.locator('.sources').getByRole('button'))).toHaveCount(0);
  await reading.getByRole('button', { name: '学生', exact: true }).first().click();
  await expect(detail.getByRole('button', { name: '收藏', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(note).toHaveValue('课后复习');
  await detail.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('button', { name: '本课小测验' }).click();
  const quiz = page.getByRole('dialog', { name: '练习一下' });
  const answer = quiz.getByRole('textbox', { name: '填写答案' });
  await answer.fill('学');
  await page.reload();
  await page.getByRole('button', { name: /继续未完成的测验/ }).click();
  await expect(answer).toHaveValue('学');
  await answer.fill('会社');
  await quiz.getByRole('button', { name: '关闭' }).click();
  await expect(quiz).toBeHidden();
  const reopened = await page.context().newPage();
  await reopened.goto('/');
  await reopened.getByRole('button', { name: /继续未完成的测验/ }).click();
  await expect(reopened.getByRole('textbox', { name: '填写答案' })).toHaveValue('会社');
  await reopened.close();
  await page.getByRole('button', { name: /继续未完成的测验/ }).click();
  await answer.fill('学生');
  await quiz.getByRole('button', { name: '检查答案' }).click();
  await expect(quiz.getByText('答案：会社員')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /继续未完成的测验/ }).click();
  await expect(answer).toHaveValue('学生');
  await expect(quiz.getByText('答案：会社員')).toBeVisible();
  await quiz.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('button', { name: '开始今日复习' }).click();
  const review = page.getByRole('dialog', { name: '专注复习' });
  await expect(review.getByRole('button', { name: '记得', exact: true })).toHaveCount(0);
  await review.getByRole('button', { name: '揭晓答案' }).click();
  for (const name of ['忘记', '困难', '记得', '轻松']) {
    await expect(review.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await review.getByRole('button', { name: '记得', exact: true }).click();
  await expect(review.getByText(/^2 \/ /)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /继续未完成的卡片/ }).click();
  await expect(review.getByText(/^2 \/ /)).toBeVisible();
  await review.getByRole('button', { name: '关闭' }).click();

  await nav.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '错题本' }).click();
  await expect(page.getByText('李さんは（　）ですか。—はい、会社員です。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '内容与备份' }).click();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份' }).click();
  const download = await downloadReady;
  const files = unzipSync(await readFile((await download.path())!));
  const backup = JSON.parse(strFromU8(files['backup.json']));
  expect(backup.profile.notes['vocab-gakusei-student']).toBe('课后复习');
  expect(backup.profile.reviews).toMatchObject([{ rating: 3 }]);
  expect(backup.profile.answers).toMatchObject([{ quizId: 'lesson01-fill1', correct: false }]);
  expect(backup.requiredPacks).toHaveLength(catalog.packs.length);
});
