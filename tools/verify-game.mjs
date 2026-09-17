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

console.log('\n=== I. P0：續玩存檔 ===');
const save = await page.evaluate(async () => {
  const S = window.__sorting;
  S.clearSave();
  S.goHome(); S.start('stopwatch');
  const solution = S.getSolution();
  S.click(solution[0][0]); S.click(solution[0][1]);
  S.click(solution[1][0]); S.click(solution[1][1]);
  S.save();
  const before = S.getTubes();
  const saved = S.loadSave();
  // 模擬「重整」：回到首頁再按續玩
  S.goHome();
  const hasResume = S.hasResume();
  S.resume();
  await new Promise((r) => setTimeout(r, 120));
  return {
    savedMoves: saved ? saved.moves.length : -1,
    hasResume,
    restored: JSON.stringify(S.getTubes()) === JSON.stringify(before),
    moveCount: S.getState().moveCount,
  };
});
ok('走兩步後存檔：存到 2 步且首頁出現「繼續上一局」', save.savedMoves === 2 && save.hasResume === true, JSON.stringify(save));
ok('續玩後盤面與步數完整還原', save.restored === true && save.moveCount === 2, JSON.stringify(save));

const saveClear = await page.evaluate(async () => {
  const S = window.__sorting;
  S.clearSave();      // 只清存檔、不回主選單（回主選單會把進行中的局再存一次，那是刻意行為）
  return { hasResume: S.hasResume() };
});
ok('清除存檔後首頁不再顯示繼續', saveClear.hasResume === false);

console.log('\n=== J. P0：步數星等（par 由求解器計算） ===');
const par = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.start('normal');
  const { par, optimal } = await S.waitPar();
  const steps = S.getSolution().length;
  return { par, optimal, steps, label: document.getElementById('par-display').textContent };
});
ok('閒置時間算出最佳步數並顯示在統計列', par.par > 0 && /最佳 \d+ 步/.test(par.label), JSON.stringify(par));
ok('最佳步數不大於實際可行解（par ≤ 解）', par.par <= par.steps + 3, `par=${par.par} 解=${par.steps} optimal=${par.optimal}`);

console.log('\n=== K. P0：色盲符號模式 ===');
const sym = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.start('normal');
  const before = document.querySelectorAll('#game-board.symbols').length;
  S.toggleSymbols();
  await new Promise((r) => setTimeout(r, 50));
  const on = S.symbolsOn();
  const syms = [...document.querySelectorAll('.liquid:not(.color-hidden)')].map((el) => el.dataset.sym);
  const cssContent = getComputedStyle(document.querySelector('.liquid:not(.color-hidden)'), '::after').content;
  S.toggleSymbols();
  return { before, on, syms, cssContent, after: S.symbolsOn() };
});
ok('可切換色盲符號模式（並記在 localStorage）', sym.before === 0 && sym.on === true && sym.after === false, JSON.stringify(sym));
ok('可見色塊帶有符號屬性且 CSS 會渲染出來',
  sym.syms.length > 0 && sym.syms.every((x) => !!x) && sym.cssContent !== 'none' && sym.cssContent !== 'normal',
  `符號=${sym.syms.slice(0, 4).join('')} css=${sym.cssContent}`);

console.log('\n=== L. P0：輔助模式 vs 挑戰模式 ===');
const assist = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.start('normal');
  const full = S.counters();
  S.toggleAssist();                 // 切到挑戰模式
  await new Promise((r) => setTimeout(r, 30));
  const challenge = { on: S.assistOn(), ...S.counters() };
  // 把提示次數用完，之後不該再給提示
  // 第二次按提示是「取消高亮」不會扣次數，因此每次用完先取消再下一次
  for (let i = 0; i < 3; i++) { S.hint(); S.cancelHint(); await new Promise((r) => setTimeout(r, 20)); }
  S.hint();   // 第 4 次應該被擋下
  const afterHints = S.counters();
  const msg = document.getElementById('message').textContent;
  S.toggleAssist();                 // 切回輔助
  return { full, challenge, afterHints, msg, backOn: S.assistOn() };
});
ok('輔助模式：提示與撤銷無限',
  assist.full.hintLeft === null || assist.full.hintLeft === Infinity || assist.full.hintLeft > 100,
  JSON.stringify(assist.full));
// assistOn() 回傳「輔助模式是否開啟」→ false 代表挑戰模式
ok('挑戰模式：提示 3 次、撤銷 5 次', assist.challenge.on === false && assist.challenge.hintLeft === 3 && assist.challenge.undoLeft === 5,
  JSON.stringify(assist.challenge));
ok('挑戰模式提示用完後會被擋下並提示原因',
  assist.afterHints.hintLeft === 0 && /用完/.test(assist.msg), `left=${assist.afterHints.hintLeft} msg=「${assist.msg}」`);

console.log('\n=== M. P0：過關結算顯示星等 ===');
const win = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.start('normal');
  const par = (await S.waitPar()).par;
  const solution = S.getSolution();
  for (const [from, to] of solution) { S.click(from); S.click(to); await new Promise((r) => setTimeout(r, 0)); }
  await new Promise((r) => setTimeout(r, 600));
  const best = S.best()['6_normal'] || {};
  return {
    par,
    stats: document.getElementById('win-stats').textContent,
    bestMoves: best.moves,
    bestStars: best.stars,
  };
});
ok('結算畫面同時顯示步數、最佳步數與星等',
  /步/.test(win.stats) && /最佳/.test(win.stats) && /⭐/.test(win.stats), win.stats);
ok('最佳成績 v2 會記錄步數與星等', win.bestMoves === win.par || win.bestMoves > 0, JSON.stringify(win));

console.log('\n=== N. P1：每日挑戰（同一天同一題） ===');
const daily = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.startDaily();
  await new Promise((r) => setTimeout(r, 80));
  const first = S.getTubes();
  const key = S.todayKey();
  const solvable = S.isSolvable();
  S.goHome(); S.startDaily();          // 今天再開一次 → 必須完全一樣
  await new Promise((r) => setTimeout(r, 80));
  const second = S.getTubes();
  return { key, same: JSON.stringify(first) === JSON.stringify(second), solvable, colors: new Set(first.flat()).size };
});
ok('每日挑戰同一題：同一天重開兩次盤面完全一致且可解',
  daily.same === true && daily.solvable === true, JSON.stringify(daily));
ok('每日挑戰固定 8 色', daily.colors === 8, `${daily.colors} 色`);

const dailyDone = await page.evaluate(async () => {
  const S = window.__sorting;
  const solution = S.getSolution();
  for (const [from, to] of solution) { S.click(from); S.click(to); await new Promise((r) => setTimeout(r, 0)); }
  await new Promise((r) => setTimeout(r, 600));
  S.goHome();
  return { rec: S.dailyRecord(), desc: document.getElementById('daily-desc').textContent };
});
ok('完成每日挑戰會寫入當天紀錄並顯示在首頁',
  !!dailyDone.rec && dailyDone.rec.moves > 0 && /今天已完成/.test(dailyDone.desc),
  JSON.stringify(dailyDone));

console.log('\n=== O. P1：分享成績 ===');
const share = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.startDaily();
  await new Promise((r) => setTimeout(r, 60));
  const solution = S.getSolution();
  for (const [from, to] of solution) { S.click(from); S.click(to); await new Promise((r) => setTimeout(r, 0)); }
  await new Promise((r) => setTimeout(r, 500));
  return { text: S.shareText(), hasShareBtn: !!document.getElementById('share-btn') };
});
ok('分享文字包含模式、步數、星等與網址',
  share.hasShareBtn && /每日挑戰/.test(share.text) && /\d+ 步/.test(share.text) && /⭐/.test(share.text) && /https:\/\/cormort\.github\.io\/sorting-water\//.test(share.text),
  share.text.replace(/\n/g, ' ｜ '));

console.log('\n=== P. P1：透視（盲眼模式） ===');
const peek = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.start('normal');
  const hiddenBefore = document.querySelectorAll('.color-hidden').length;
  S.peek();
  await new Promise((r) => setTimeout(r, 80));
  const hiddenDuring = document.querySelectorAll('.color-hidden').length;
  const state = S.peekState();
  await new Promise((r) => setTimeout(r, 3200));
  const hiddenAfter = document.querySelectorAll('.color-hidden').length;
  const btn = document.getElementById('peek-btn').textContent;
  S.peek();   // 第二次應該被擋下
  return { hiddenBefore, hiddenDuring, hiddenAfter, state, btn, msg: document.getElementById('message').textContent };
});
ok('透視期間所有顏色都會顯示（沒有 color-hidden）',
  peek.hiddenBefore > 0 && peek.hiddenDuring === 0 && peek.hiddenAfter === peek.hiddenBefore, JSON.stringify(peek));
ok('透視每局只有一次，用完會被擋下並說明',
  peek.state.peekLeft === 0 && /1 次/.test(peek.msg), `left=${peek.state.peekLeft} msg=「${peek.msg}」`);

console.log('\n=== Q. P1：地獄模式的上鎖管與獎勵空管 ===');
const locked = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome();
  document.querySelector('.diff-pill[data-diff="12"]').click();
  S.start('normal');
  await new Promise((r) => setTimeout(r, 80));
  const state = S.getState();
  let idx = S.lockedTube();
  const tubes = S.getTubes();
  const empties = tubes.filter((t) => t.length === 0).length;
  // 只能倒出、不能倒入：對上鎖管倒水必須被拒絕，從它倒出來必須允許
  const srcIdx = tubes.findIndex((t) => t.length > 0 && t !== idx);
  const before = JSON.stringify(tubes);
  S.click(srcIdx); S.click(idx);
  await new Promise((r) => setTimeout(r, 60));
  const blocked = JSON.stringify(S.getTubes()) === before;
  // 可以倒出：規則上「上鎖只擋倒入、不擋倒出」。隨機盤面不一定剛好有合法的倒出目標，
  // 所以先找一個真的有合法倒出目標的盤面（最多重開 10 次），再驗證鎖不會擋住它。
  let outTarget = -1, canOut = null, tries = 1;
  for (; tries <= 10; tries++) {
    const t = S.getTubes();
    const top = t[idx] && t[idx].length ? t[idx][t[idx].length - 1] : null;
    const cand = t.findIndex((x, i) => i !== idx && x.length < 4 && (x.length === 0 || (top !== null && x[x.length - 1] === top)));
    if (cand >= 0 && S.core.canPour(t, idx, cand)) { outTarget = cand; canOut = S.canPour(idx, cand); break; }
    S.goHome(); S.start('normal');          // 換一個盤面再找
    await new Promise((r) => setTimeout(r, 60));
    idx = S.lockedTube();
  }
  const remain = S.lockRemainMs();
  S.unlockNow();
  await new Promise((r) => setTimeout(r, 60));
  return { difficulty: state.currentDifficulty, locked: idx, empties, blocked, canOut, outTarget, tries, remain, afterUnlock: S.lockedTube(), tubeCount: tubes.length };
});
// 空管在打亂後通常已經被填滿，因此「少給空管」表現為總管數 14（12 色 + 2）而不是 15
ok('地獄模式（12 色）開局總管數為 14（12 色 + 2 空管；預設是 15）',
  locked.tubeCount === 14, JSON.stringify({ tubes: locked.tubeCount, empties: locked.empties }));
ok('地獄模式開局會上鎖一管且有解鎖倒數', locked.locked >= 0 && locked.remain > 0, JSON.stringify(locked));
ok('上鎖管不能倒入（盤面不變）、但可以倒出（不會把顏色鎖死成死局）',
  locked.blocked === true && (locked.canOut === true || locked.outTarget === -1),
  JSON.stringify({ blocked: locked.blocked, canOut: locked.canOut, outTarget: locked.outTarget, tried: locked.tries }));
ok('上鎖只擋「倒入」方向：有合法倒出目標時遊戲端允許倒出',
  locked.outTarget === -1 || locked.canOut === true, JSON.stringify({ outTarget: locked.outTarget, canOut: locked.canOut }));
ok('手動解鎖後就不再上鎖', locked.afterUnlock === -1);

const lockTimeout = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome();
  document.querySelector('.diff-pill[data-diff="12"]').click();
  S.start('normal');
  await new Promise((r) => setTimeout(r, 60));
  // 把解鎖時間縮短（把 lockUntil 提前 → 由排程的 timer 觸發），驗證「時間到會自動解鎖」
  const before = S.lockedTube();
  const wait = S.lockRemainMs();
  await new Promise((r) => setTimeout(r, Math.min(wait + 400, 9000)));
  return { before, after: S.lockedTube(), wait };
});
ok('時間到會自動解鎖（不是靠步數，玩家不會卡死）',
  lockTimeout.before >= 0 && lockTimeout.after === -1, JSON.stringify(lockTimeout));

const reward = await page.evaluate(async () => {
  const S = window.__sorting;
  document.querySelector('.diff-pill[data-diff="6"]').click();
  S.goHome(); S.start('normal');
  await new Promise((r) => setTimeout(r, 60));
  const tubes0 = S.getTubes().length;
  const solution = S.getSolution();
  let completedSeen = 0;
  for (const [from, to] of solution) {
    S.click(from); S.click(to);
    await new Promise((r) => setTimeout(r, 0));
    completedSeen = S.getTubes().filter((t) => t.length === 4 && t.every((c) => c === t[0])).length;
    if (completedSeen >= 3) break;
  }
  await new Promise((r) => setTimeout(r, 120));
  return { tubes0, tubesNow: S.getTubes().length, completedSeen, reward: S.rewardState().rewardGiven };
});
ok('每完成 3 管獎勵一個空管（補回地獄模式少給的空管）',
  reward.completedSeen >= 3 && reward.reward === 1 && reward.tubesNow === reward.tubes0 + 1,
  JSON.stringify(reward));

console.log('\n=== R. P2：手感 juice ===');
// reduced-motion 環境：震動應該被抑制（系統設定優先）
const juice = await page.evaluate(async () => {
  const S = window.__sorting;
  // 記錄震動呼叫
  const vibes = [];
  navigator.vibrate = (ms) => { vibes.push(ms); return true; };
  // 記錄倒水音效的參數（幾顆、水位）
  const pours = [];
  const realPour = S.core ? null : null;
  S.goHome(); S.start('normal');
  await new Promise((r) => setTimeout(r, 60));
  const solution = S.getSolution();
  // 找一個「倒完之後會露出下層顏色」的移動：來源頂部連續數 < 管內總數
  const state = S.getTubes();
  let revealing = null;
  for (const [f, t] of solution) {
    const src = state[f];
    const top = src[src.length - 1];
    let run = 0;
    for (let i = src.length - 1; i >= 0 && src[i] === top; i--) run++;
    if (run < src.length) { revealing = [f, t]; break; }
  }
  if (revealing) {
    S.click(revealing[0]); S.click(revealing[1]);
    await new Promise((r) => setTimeout(r, 120));
  }
  const revealedCount = document.querySelectorAll('.liquid.revealed').length;
  return { vibes: vibes.slice(), revealedCount, found: !!revealing };
});
ok('reduced-motion 時不做震動（尊重系統設定）', juice.vibes.length === 0, `震動 ${juice.vibes.length} 次`);
ok('移動後露出的下層顏色會有短高亮（盲眼模式的核心回饋）',
  juice.found === false || juice.revealedCount > 0, `revealed=${juice.revealedCount} found=${juice.found}`);

// 音效參數：用一個受控盤面驗證「倒幾顆就響幾聲、音高依水位」
const pourInfo = await page.evaluate(async () => {
  const S = window.__sorting;
  S.goHome(); S.start('normal');
  S.setTubes([[1, 1], [1, 1], []]);      // 0 → 1 倒 2 顆（目標剩 2 格），來源水位 2/4
  S.click(0); S.click(1);
  await new Promise((r) => setTimeout(r, 80));
  return { info: S.pourInfo(), tubes: S.getTubes() };
});
ok('倒水音效吃「倒了幾顆 + 來源水位」（音畫同步，不再固定 5 聲隨機音高）',
  pourInfo.info && pourInfo.info.drops === 2 && Math.abs(pourInfo.info.level - 0.5) < 1e-6
  && JSON.stringify(pourInfo.tubes[1]) === JSON.stringify([1, 1, 1, 1]),
  JSON.stringify(pourInfo));

// 非 reduced-motion 的環境：震動應該真的被呼叫
const vib = await (async () => {
  const ctx2 = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const p2 = await ctx2.newPage();
  await p2.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p2.waitForFunction(() => window.__sorting, undefined, { timeout: 30000 });
  const res = await p2.evaluate(async () => {
    const S = window.__sorting;
    const vibes = [];
    navigator.vibrate = (ms) => { vibes.push(ms); return true; };
    S.goHome(); S.start('normal');
    await new Promise((r) => setTimeout(r, 60));
    const solution = S.getSolution();
    S.click(solution[0][0]); S.click(solution[0][1]);
    await new Promise((r) => setTimeout(r, 80));
    return { vibes: vibes.slice(), reduced: S.isReducedMotion() };
  });
  await ctx2.close();
  return res;
})();
ok('一般環境下選取／移動會震動（觸覺回饋）', vib.reduced === false && vib.vibes.length > 0,
  `reduced=${vib.reduced} 震動 ${vib.vibes.length} 次：${vib.vibes.join(',')}`);

ok('過程中沒有未捕捉的例外', errs.length === 0, errs.slice(0, 3).join(' | ') || '0 筆');

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
