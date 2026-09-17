// node test-core.mjs — 純邏輯回歸測試（免安裝、秒級）
//
// 最關鍵的一條：**產生的關卡一定要解得開**。
// 舊版的後備路徑是「純隨機重分配」，只檢查容量與不相鄰同色，不保證可解，
// 而且是沒有上限的 while(true)（運氣不好會凍結瀏覽器）。這裡用求解器逐一驗證。
import assert from 'node:assert';
import './game-core.js';

const Core = globalThis.SortingWaterCore;
assert.ok(Core, 'game-core.js 沒有正確輸出 API');
const { TUBE_CAPACITY, mulberry32, solve, isSolved, generateLevel, getValidMoves, applyMove, isDeadEnd,
    solveOptimal, starsFor, COLOR_SYMBOLS, dailySeed, todayKey } = Core;

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`PASS  ${name}`); };

console.log('=== A. 基本操作 ===');
ok('倒水受「頂部同色連續數」與「剩餘空間」限制', () => {
    const s = [[1, 1, 1, 1], [1], []];
    assert.strictEqual(Core.pourCount(s, 0, 1), 3, '目標只剩 3 格、來源頂部有 4 顆同色 → 倒到滿為止（3 顆）');
    assert.strictEqual(Core.pourCount(s, 1, 2), 1);
    assert.strictEqual(Core.pourCount(s, 2, 1), 0, '空管不能倒');
    assert.strictEqual(Core.pourCount(s, 1, 0), 0, '來源已滿');
    const s2 = [[1, 2, 2], [2], []];
    assert.strictEqual(Core.pourCount(s2, 0, 1), 2, '頂部兩顆同色且目標有空間 → 倒 2');
});
ok('applyMove 不會改到原狀態（純函式）', () => {
    const s = [[1, 2], [2], []];
    const before = JSON.stringify(s);
    const next = applyMove(s, 0, 1);
    assert.strictEqual(JSON.stringify(s), before);
    assert.deepStrictEqual(next[1], [2, 2]);
});
ok('isSolved 只認「空管或整管同色且滿」', () => {
    assert.strictEqual(isSolved([[1, 1, 1, 1], [], [2, 2, 2, 2]]), true);
    assert.strictEqual(isSolved([[1, 1, 1], []]), false, '未滿不算完成');
    assert.strictEqual(isSolved([[1, 1, 2, 2], []]), false, '混色不算完成');
});
ok('getValidMoves 會排除「整管純色倒進空管」的空轉步', () => {
    const onlyComplete = [[1, 1, 1, 1], [], [2, 2, 2, 2], []];
    assert.strictEqual(getValidMoves(onlyComplete).length, 0, '只有完成管與空管 → 沒有移動');
    assert.strictEqual(isDeadEnd(onlyComplete), true);
    const uniform = [[1, 1, 1], [], [2, 2, 2, 2], []];
    assert.strictEqual(getValidMoves(uniform).length, 0, '整管純色倒進空管只是換位置 → 過濾掉');
    assert.ok(getValidMoves(uniform, { skipPointless: false }).length > 0, '關掉過濾仍看得到原始移動');
});

console.log('\n=== B. 求解器 ===');
ok('解已經完成的盤面 → 0 步', () => {
    const res = solve([[1, 1, 1, 1], [2, 2, 2, 2], []]);
    assert.deepStrictEqual(res.moves, []);
});
ok('解一個已知的小盤面，並逐步驗證每一步都合法', () => {
    const start = [[2, 1, 2, 1], [1, 2, 1, 2], []];
    const { moves } = solve(start, { maxNodes: 200000 });
    assert.ok(moves && moves.length > 0, '應該找得到解');
    let s = start.map((t) => [...t]);
    for (const [from, to] of moves) {
        assert.ok(Core.canPour(s, from, to), `第 ${from}→${to} 步不合法`);
        s = applyMove(s, from, to);
    }
    assert.ok(isSolved(s), '照著解走完應該完成');
});
ok('無解盤面在預算內回傳 null（不會無限搜尋）', () => {
    const stuck = [[1, 2, 1, 2], [2, 1, 2, 1]];
    assert.strictEqual(solve(stuck, { maxNodes: 5000 }).moves, null);
    assert.strictEqual(Core.isSolvable(stuck, { maxNodes: 5000 }), false);
});

console.log('\n=== C. 關卡產生：必須解得開（舊版漏洞） ===');
ok('每個難度 × 多個種子：產生的關卡都解得開、容量守恆、顆數正確', () => {
    const difficulties = [4, 6, 8, 10, 12];
    let checked = 0, adjacent = 0;
    for (const diff of difficulties) {
        for (let seed = 1; seed <= 8; seed++) {
            const rng = mulberry32(seed * 7919 + diff);
            const level = generateLevel(diff, rng, { attempts: 8, verifyBudget: 30000 });
            // 容量與顆數
            for (const tube of level) assert.ok(tube.length <= TUBE_CAPACITY, '超過管容量');
            const counts = new Map();
            for (const tube of level) for (const c of tube) counts.set(c, (counts.get(c) || 0) + 1);
            assert.strictEqual(counts.size, diff, `顏色數應為 ${diff}`);
            for (const [c, n] of counts) assert.strictEqual(n, TUBE_CAPACITY, `顏色 ${c} 顆數應為 4`);
            // 一定要有解，而且照著解走完真的會完成
            const { moves } = solve(level, { maxNodes: 200000 });
            assert.ok(moves, `難度 ${diff}／種子 ${seed} 產生出無解盤面`);
            let s = level.map((t) => [...t]);
            for (const [from, to] of moves) s = applyMove(s, from, to);
            assert.ok(isSolved(s), '照解走完未完成');
            if (Core.hasAdjacentSameColor(level)) adjacent++;
            checked++;
        }
    }
    console.log(`      檢查 ${checked} 個關卡，其中 ${adjacent} 個仍有相鄰同色（僅影響盲眼模式的問號分佈）`);
    assert.strictEqual(checked, 40);
});
ok('產生器不會卡住（各難度 20 次的總耗時 < 3 秒）', () => {
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) {
        const diff = [6, 8, 10, 12][i % 4];
        generateLevel(diff, mulberry32(i + 1), { attempts: 6, verifyBudget: 20000 });
    }
    const ms = Date.now() - t0;
    console.log(`      20 次產生耗時 ${ms}ms`);
    assert.ok(ms < 3000, `產生太慢：${ms}ms`);
});
ok('極端難度（2 色、16 色）也不會壞掉', () => {
    for (const diff of [2, 16]) {
        const level = generateLevel(diff, mulberry32(diff), { attempts: 6, verifyBudget: 20000 });
        const counts = new Set(level.flat());
        assert.strictEqual(counts.size, diff);
        assert.ok(solve(level, { maxNodes: 200000 }).moves, `難度 ${diff} 產生出無解盤面`);
    }
});

console.log('\n=== D. 最短解（步數星等的 par） ===');
ok('最短解比 DFS 解短或相等，而且照著走也會完成', () => {
    let shorter = 0;
    for (let seed = 1; seed <= 6; seed++) {
        const level = generateLevel(6, mulberry32(seed));
        const dfs = solve(level, { maxNodes: 200000 }).moves;
        const opt = solveOptimal(level, { maxNodes: 200000 });
        assert.ok(opt.moves, '應該找得到最短解');
        assert.ok(opt.moves.length <= dfs.length, `最短解 ${opt.moves.length} 不該長於 DFS ${dfs.length}`);
        if (opt.moves.length < dfs.length) shorter++;
        let s = level.map((t) => [...t]);
        for (const [from, to] of opt.moves) {
            assert.ok(Core.canPour(s, from, to), '最短解含有不合法步');
            s = applyMove(s, from, to);
        }
        assert.ok(isSolved(s), '照最短解走完應該完成');
    }
    console.log(`      6 個關卡中有 ${shorter} 個 DFS 解比最短解長`);
});
ok('節點預算用完時回傳 optimal=false，而不是假裝是最短', () => {
    const level = generateLevel(12, mulberry32(5));
    const res = solveOptimal(level, { maxNodes: 3000 });
    assert.strictEqual(res.optimal, false);
    assert.ok(res.moves === null || res.moves.length > 0);
});
ok('星等門檻：≤par×1.15 三星、≤par×1.5 兩星、其餘一星', () => {
    assert.strictEqual(starsFor(19, 19), 3);
    assert.strictEqual(starsFor(21, 19), 3);
    assert.strictEqual(starsFor(22, 19), 3, '19×1.15 = 21.85，取上界 22 → 仍在三星內');
    assert.strictEqual(starsFor(23, 19), 2);
    assert.strictEqual(starsFor(29, 19), 2, '19×1.5 = 28.5，取上界 29 → 兩星');
    assert.strictEqual(starsFor(30, 19), 1);
    assert.strictEqual(starsFor(10, 0), 1, '沒有 par 時不該給三星');
});

console.log('\n=== E. 每日挑戰種子與色盲符號 ===');
ok('同一天同難度 → 同一組種子；不同天或不同難度 → 不同種子', () => {
    assert.strictEqual(dailySeed('2026-09-17', 6), dailySeed('2026-09-17', 6));
    assert.notStrictEqual(dailySeed('2026-09-17', 6), dailySeed('2026-09-18', 6));
    assert.notStrictEqual(dailySeed('2026-09-17', 6), dailySeed('2026-09-17', 8));
});
ok('每日挑戰用同一種子產生的關卡完全一致（可分享同一題）', () => {
    const a = generateLevel(6, mulberry32(dailySeed('2026-09-17', 6)));
    const b = generateLevel(6, mulberry32(dailySeed('2026-09-17', 6)));
    assert.deepStrictEqual(a, b);
});
ok('todayKey 是 UTC+8 的日期字串', () => {
    assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/);
    // 台灣時間比 UTC 快 8 小時：UTC 16:00 是台北的隔天 00:00
    assert.strictEqual(todayKey(Date.UTC(2026, 8, 17, 15, 30)), '2026-09-17', '台北 23:30 仍是 17 號');
    assert.strictEqual(todayKey(Date.UTC(2026, 8, 17, 16, 30)), '2026-09-18', '台北 00:30 已是 18 號');
});
ok('色盲符號覆蓋所有可能顏色且彼此不同', () => {
    // 最高難度是 12 色，符號數至少要有 12 個才不會重複
    assert.ok(COLOR_SYMBOLS.length >= 12, `只有 ${COLOR_SYMBOLS.length} 個符號`);
    assert.strictEqual(new Set(COLOR_SYMBOLS).size, COLOR_SYMBOLS.length, '符號不可重複');
});

console.log(`\n${passed} passed`);
