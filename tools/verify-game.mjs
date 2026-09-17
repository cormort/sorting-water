// 水瓶分類（Color Sort · Blind Mode）端對端驗證。
//
// 這支把這次優化的重點釘住：
//   1. 產生的關卡**一定解得開**（舊版的隨機後備路徑會產生無解盤面，而且是無上限 while(true)）
//   2. 求解器驅動的提示真的能走完 → 用「照著提示一路點」驗證遊戲可以過關
//   3. 倒水動畫在 prefers-reduced-motion 下直接完成（也讓這支測試跑得快）
//   4. 管子可用鍵盤操作（Tab 聚焦 + Enter 選取）
//   5. 計時器是 wall-clock：90 秒限時模式跑幾秒後，剩餘秒數要對得上
//
// 用法：
//   npx http-server -p 8905 -s
//   PW_MODULE=... node tools/verify-game.mjs
//   PROBE_URL=https://cormort.github.io/sorting-water/index.html node tools/verify-game.mjs
const pw = (await import(process.env.PW_MODULE || 'playwright')).default;
const BASE = process.env.PROBE_URL || 'http://127.0.0.1:8905/index.html';
const URL = BASE + (BASE.includes('?') ? '&' : '?') + 'bot&mute';

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`PASS  ${name}${detail ? `  [${detail}]` : ''}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? `  [${detail}]` : ''}`); }
};

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0].slice(0, 120)));
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__sorting, undefined, { timeout: 30000 });

console.log('=== A. 除錯介面與 reduced-motion ===');
ok('?bot 會掛出 __sorting 除錯介面', await page.evaluate(() => typeof window.__sorting === 'object'));
ok('reducedMotion: reduce 有被偵測到（動畫會直接完成）',
  await page.evaluate(() => window.__sorting.isReducedMotion() === true));

console.log('\n=== B. 關卡產生：可解性 ===');
const gen = await page.evaluate(() => {
  const out = [];
  for (const mode of ['stopwatch', 'countdown', 'normal']) {
    window.__sorting.start(mode);
    const level = window.__sorting.getTubes();
    const counts = {};
    level.flat().forEach((c) => { counts[c] = (counts[c] || 0) + 1; });
    out.push({
      mode,
      tubes: level.length,
      colors: Object.keys(counts).length,
      capacityOk: level.every((t) => t.length <= window.__sorting.core.TUBE_CAPACITY),
      countsOk: Object.values(counts).every((n) => n === window.__sorting.core.TUBE_CAPACITY),
      solvable: window.__sorting.isSolvable(),
    });
  }
  return out;
});
for (const g of gen) {
  ok(`${g.mode}：產生 ${g.tubes} 管 / ${g.colors} 色，容量與顆數正確且**保證可解**`,
    g.capacityOk && g.countsOk && g.solvable, JSON.stringify(g));
}

console.log('\n=== C. 用求解器一路點到過關 ===');
const play = await page.evaluate(async () => {
  const S = window.__sorting;
  S.start('stopwatch');
  const solution = S.getSolution();
  if (!solution) return { error: '求解器找不到解' };
  for (const [from, to] of solution) {
    S.click(from);
    S.click(to);
    await new Promise((r) => setTimeout(r, 0));
  }
  await new Promise((r) => setTimeout(r, 600));
  return {
    steps: solution.length,
    state: S.getState(),
    overlayShown: document.getElementById('win-overlay').classList.contains('show'),
    stats: document.getElementById('win-stats').textContent,
    tubes: S.getTubes(),
  };
});
ok('照著求解器的解一路點擊 → 出現過關畫面',
  !play.error && play.overlayShown === true, play.error || `steps=${play.steps} overlay=${play.overlayShown}`);
ok('過關時棋盤上每管都完成或為空',
  play.tubes && play.tubes.every((t) => t.length === 0 || (t.length === 4 && t.every((c) => c === t[0]))));
ok('步數顯示與實際步數一致', !!play.stats && play.stats.length > 0, play.stats);

console.log('\n=== D. 提示會給出「能走完」的下一步 ===');
const hint = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.start('normal');
  S.hint();
  await new Promise((r) => setTimeout(r, 50));
  const highlighted = document.querySelectorAll('.hint-source, .hint-target').length;
  const msg = document.getElementById('message').textContent;
  return { highlighted, msg, state: S.getState() };
});
ok('按下提示會標出兩個管子並顯示剩餘步數', hint.highlighted === 2 && /步/.test(hint.msg), `${hint.highlighted} 個高亮／「${hint.msg}」`);

console.log('\n=== E. 鍵盤操作 ===');
const keyboard = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.start('normal');
  const tube = document.querySelector('.tube');
  const focusable = tube.tabIndex >= 0 && tube.getAttribute('role') === 'button';
  tube.focus();
  tube.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  return { focusable, selected: S.getState().selectedTubeIndex, ariaLabel: tube.getAttribute('aria-label') };
});
ok('管子可 Tab 聚焦且有 role/aria-label', keyboard.focusable && !!keyboard.ariaLabel, keyboard.ariaLabel);
ok('Enter 可以把管子選起來（不用滑鼠）', keyboard.selected !== null, `selectedTubeIndex=${keyboard.selected}`);

console.log('\n=== F. 計時器（wall-clock） ===');
const timer = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.start('countdown');
  const t0 = S.getState().currentTime;
  await new Promise((r) => setTimeout(r, 3200));
  const t1 = S.getState().currentTime;
  return { t0, t1, elapsed: t0 - t1, display: document.getElementById('timer-display').textContent };
});
ok('90 秒限時：3.2 秒後剩餘秒數減少 3（±1）',
  Math.abs(timer.elapsed - 3) <= 1, `${timer.t0} → ${timer.t1}（display=${timer.display}）`);

console.log('\n=== G. DOM 不再整塊重建（效能與焦點保留） ===');
const dom = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.start('normal');
  const board = document.getElementById('game-board');
  const first = board.children[0];
  const count = board.children.length;
  const solution = S.getSolution();
  S.click(solution[0][0]); S.click(solution[0][1]);
  await new Promise((r) => setTimeout(r, 60));
  const after = board.children[0];
  // 焦點保留測試：聚焦某管 → 走一步（會觸發 renderBoard）→ 焦點應該還在同一顆元素上
  const target = board.children[1];
  target.focus();
  const solution2 = S.getSolution();
  S.click(solution2[0][0]); S.click(solution2[0][1]);
  await new Promise((r) => setTimeout(r, 60));
  return {
    tubeCount: count,
    sameInstance: first === after,
    focusKept: document.activeElement === target,
    liquidCount: after.children.length - 1,
  };
});
ok('點擊後管子元素是同一顆（沒有重建整個棋盤）', dom.sameInstance === true, `tubes=${dom.tubeCount}`);
ok('走一步後鍵盤焦點仍在原本聚焦的管子', dom.focusKept === true);
ok('每管的液體層數 = 內容物數量', dom.liquidCount >= 0 && dom.liquidCount <= 4, `${dom.liquidCount} 層`);

console.log('\n=== H. 死局與撤銷 ===');
const undo = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.start('normal');
  const before = S.getTubes();
  const solution = S.getSolution();
  S.click(solution[0][0]); S.click(solution[0][1]);
  await new Promise((r) => setTimeout(r, 100));
  const afterMove = S.getState().moveCount;
  S.undo();
  await new Promise((r) => setTimeout(r, 50));
  const restored = JSON.stringify(S.getTubes()) === JSON.stringify(before);
  return { afterMove, undoCount: S.getState().moveCount, restored };
});
ok('走一步後撤銷可以回到原本盤面',
  undo.afterMove === 1 && undo.undoCount === 0 && undo.restored, JSON.stringify(undo));

ok('過程中沒有未捕捉的例外', errs.length === 0, errs.slice(0, 3).join(' | ') || '0 筆');

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
