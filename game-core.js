/*!
 * game-core.js — 水瓶分類（Color Sort · Blind Mode）的純邏輯層
 *
 * 這裡放的是「跟畫面無關、錯了會讓人卡關」的東西：合法移動、倒水、勝負判定、
 * 關卡產生與求解器。抽出成獨立檔有三個好處：
 *   1. Node 可以直接測（test-core.mjs），不用開瀏覽器
 *   2. 求解器可以用來「驗證產生的關卡真的解得開」——這是舊版最大的漏洞
 *   3. 提示功能可以走真正的解，而不是貪心猜一步
 *
 * 以 UMD 形式輸出：瀏覽器用 window.SortingWaterCore，Node 用 import './game-core.js'。
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.SortingWaterCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const TUBE_CAPACITY = 4;

    // ── 可注入的亂數（測試要可重現） ──
    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    const clone = (state) => state.map((t) => [...t]);

    // ── 基本操作 ──

    /** 從 source 倒到 target 時，實際會倒過去幾顆（受頂部同色連續數與剩餘空間限制）。 */
    function pourCount(state, from, to) {
        const src = state[from], tgt = state[to];
        if (!src || !tgt || from === to) return 0;
        if (src.length === 0 || tgt.length >= TUBE_CAPACITY) return 0;
        const top = src[src.length - 1];
        const topTo = tgt.length > 0 ? tgt[tgt.length - 1] : null;
        if (topTo !== null && topTo !== top) return 0;
        const space = TUBE_CAPACITY - tgt.length;
        let run = 0;
        for (let i = src.length - 1; i >= 0 && src[i] === top; i--) run++;
        return Math.min(run, space);
    }

    function canPour(state, from, to) {
        return pourCount(state, from, to) > 0;
    }

    function applyMove(state, from, to) {
        const s = clone(state);
        const n = pourCount(state, from, to);
        for (let i = 0; i < n; i++) s[to].push(s[from].pop());
        return s;
    }

    function isUniform(tube) {
        return tube.length > 0 && tube.every((c) => c === tube[0]);
    }

    function isCompleteTube(tube) {
        return tube.length === TUBE_CAPACITY && isUniform(tube);
    }

    function isSolved(state) {
        return state.every((t) => t.length === 0 || isCompleteTube(t));
    }

    /**
     * 所有合法移動。排除「把整管純色倒進空管」這種沒有進展的移動
     * （舊版會把它算成合法移動，於是提示與死局判定都會被這種空轉步干擾）。
     */
    function getValidMoves(state, options) {
        const opts = options || {};
        const skipPointless = opts.skipPointless !== false;
        const moves = [];
        for (let from = 0; from < state.length; from++) {
            const src = state[from];
            if (src.length === 0 || isCompleteTube(src)) continue;
            for (let to = 0; to < state.length; to++) {
                if (from === to) continue;
                const n = pourCount(state, from, to);
                if (n === 0) continue;
                if (skipPointless) {
                    const tgt = state[to];
                    // 倒進空管、而且來源整管純色 → 只是換位置，對解題沒有幫助
                    if (tgt.length === 0 && isUniform(src)) continue;
                    // 來源會整管清空、且目標是空的 → 同樣只是搬位置
                    if (tgt.length === 0 && n === src.length) continue;
                }
                moves.push([from, to, n]);
            }
        }
        return moves;
    }

    function isDeadEnd(state) {
        return getValidMoves(state).length === 0;
    }

    // ── 求解器 ──
    // 正規化：管子的順序不影響難度，排序後再當 key，可大幅減少重複搜尋。
    function canonical(state) {
        return state.map((t) => t.join(',')).sort().join('|');
    }

    /**
     * 以 DFS + 記憶化 + 移動排序求解，回傳移動序列 [[from,to], ...] 或 null。
     * nodes 上限避免無解盤面把瀏覽器卡死（回傳 null 代表「在預算內找不到解」）。
     */
    function solve(state, options) {
        const opts = options || {};
        const maxNodes = opts.maxNodes || 120000;
        let nodes = 0;
        const seen = new Set();

        // 移動排序：能「完成一管」的最優先，其次倒到同色管，最後才倒進空管
        function orderedMoves(s) {
            const moves = getValidMoves(s);
            const score = ([from, to, n]) => {
                const src = s[from], tgt = s[to];
                let sc = 0;
                if (tgt.length + n === TUBE_CAPACITY && isUniform(tgt) && tgt.every((c) => c === src[src.length - 1])) sc += 100;
                if (tgt.length > 0) sc += 10;              // 同色堆疊
                if (n === src.length) sc += 5;             // 清空來源，多一個空管
                if (tgt.length === 0) sc -= 1;             // 倒進空管資訊量最低
                return sc;
            };
            return moves.sort((a, b) => score(b) - score(a));
        }

        function dfs(s, path) {
            if (isSolved(s)) return path;
            if (nodes++ > maxNodes) return null;
            const key = canonical(s);
            if (seen.has(key)) return null;
            seen.add(key);
            for (const [from, to] of orderedMoves(s).map((m) => [m[0], m[1]])) {
                const next = applyMove(s, from, to);
                const res = dfs(next, path.concat([[from, to]]));
                if (res) return res;
            }
            return null;
        }

        const result = dfs(clone(state), []);
        return { moves: result, nodes, exhausted: nodes > maxNodes ? false : true };
    }

    /** 只問「解不解得開」，回傳布林（測試與產生器用）。 */
    function isSolvable(state, options) {
        return !!solve(state, options).moves;
    }

    /**
     * 最短解（BFS，每步成本 1）。用於「步數星等」的 par。
     * 12 色的狀態空間很大，因此有節點上限：超過就回傳 optimal=false 並附上現有最佳解，
     * 呼叫端可以退回 DFS 解的長度當近似 par（星等有 15% 容差，仍可用）。
     */
    function solveOptimal(state, options) {
        const opts = options || {};
        const maxNodes = opts.maxNodes || 60000;
        if (isSolved(state)) return { moves: [], nodes: 0, optimal: true };
        const startKey = canonical(state);
        let frontier = [{ state: clone(state), path: [] }];
        const seen = new Set([startKey]);
        let nodes = 0;
        while (frontier.length) {
            const next = [];
            for (const node of frontier) {
                for (const [from, to] of getValidMoves(node.state)) {
                    nodes++;
                    const child = applyMove(node.state, from, to);
                    if (isSolved(child)) return { moves: node.path.concat([[from, to]]), nodes, optimal: true };
                    const key = canonical(child);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    next.push({ state: child, path: node.path.concat([[from, to]]) });
                    if (nodes > maxNodes) {
                        const approx = solve(state, { maxNodes: 80000 }).moves;
                        return { moves: approx, nodes, optimal: false };
                    }
                }
            }
            frontier = next;
        }
        return { moves: null, nodes, optimal: true };   // 真的無解
    }

    /**
     * 每一步的「有意義程度」評分，星等用：
     *   3 星 = 步數 ≤ par × 1.15、2 星 ≤ par × 1.5、其餘 1 星。
     */
    function starsFor(moves, par) {
        if (!par || par <= 0) return 1;
        if (moves <= Math.ceil(par * 1.15)) return 3;
        if (moves <= Math.ceil(par * 1.5)) return 2;
        return 1;
    }

    // 色盲友善：每個顏色一個可辨識的符號（放在可見色塊上）
    const COLOR_SYMBOLS = ['●', '▲', '■', '★', '◆', '✚', '▼', '◤', '◢', '✖', '♥', '✦'];

    /** 每日挑戰的種子：同一天、同一難度 → 同一題（用 UTC+8 的日期，台灣玩家的「今天」）。 */
    function dailySeed(dateStr, difficulty) {
        const str = `${dateStr}#${difficulty}`;
        let h = 2166136261 >>> 0;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        return h >>> 0;
    }

    function todayKey(now) {
        const d = now ? new Date(now) : new Date();
        const tpe = new Date(d.getTime() + 8 * 3600 * 1000);   // UTC+8
        return tpe.toISOString().slice(0, 10);
    }

    // ── 關卡產生 ──

    function buildSolvedState(numColors, numEmpty) {
        const state = [];
        for (let i = 0; i < numColors; i++) state.push(new Array(TUBE_CAPACITY).fill(i + 1));
        for (let i = 0; i < numEmpty; i++) state.push([]);
        return state;
    }

    /** 反向倒水打亂：從完成狀態出發，一次搬一顆（等效於把解法倒著做）。 */
    function reverseScramble(state, moves, rng) {
        const s = clone(state);
        let lastFrom = -1, lastTo = -1;
        for (let m = 0; m < moves; m++) {
            const options = [];
            for (let f = 0; f < s.length; f++) {
                if (s[f].length === 0) continue;
                for (let t = 0; t < s.length; t++) {
                    if (f === t || s[t].length >= TUBE_CAPACITY) continue;
                    if (f === lastTo && t === lastFrom) continue;   // 不要原地來回
                    options.push([f, t]);
                }
            }
            if (options.length === 0) break;
            const [f, t] = options[Math.floor(rng() * options.length)];
            s[t].push(s[f].pop());
            lastFrom = f; lastTo = t;
        }
        return s;
    }

    /** 有沒有相鄰同色（盲眼模式下相鄰同色會讓「?」的分佈看起來很怪，僅作為偏好）。 */
    function hasAdjacentSameColor(state) {
        for (const tube of state) {
            for (let i = 1; i < tube.length; i++) if (tube[i] === tube[i - 1]) return true;
        }
        return false;
    }

    function shuffleTubes(state, rng) {
        const s = clone(state);
        for (let i = s.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [s[i], s[j]] = [s[j], s[i]];
        }
        return s;
    }

    /**
     * 產生一個「保證解得開」的關卡。
     *
     * 舊版有兩條路：反向倒水（可解）與「純隨機重分配」的後備路徑 —— 後者不保證可解，
     * 而且是沒有上限的 while(true)，運氣不好會直接卡死瀏覽器。這裡改成：
     *   反向倒水 → 偏好「無相鄰同色」→ 用求解器驗證 → 通過才回傳；
     *   全部嘗試都失敗時退回「驗證過的最後一個」或最簡單的可解盤面（絕不回傳未驗證的盤面）。
     */
    function generateLevel(difficulty, rng, options) {
        const opts = options || {};
        const random = rng || Math.random;
        const numColors = Math.max(2, Math.min(16, difficulty | 0 || 6));
        const numEmpty = numColors <= 10 ? 2 : 3;
        const attempts = opts.attempts || 12;
        const verifyBudget = opts.verifyBudget || 40000;
        const scrambleMoves = opts.scrambleMoves || (220 + numColors * 20);

        const huntMoves = opts.huntMoves || 160;
        let best = null;              // 可解但相鄰同色的備援
        for (let attempt = 0; attempt < attempts; attempt++) {
            let scrambled = reverseScramble(buildSolvedState(numColors, numEmpty), scrambleMoves, random);
            // 舊版會為了「不要相鄰同色」再亂倒幾步（hunt），這裡保留但改成有上限：
            // 每多倒一步就檢查一次，乾淨了就先記下來，最後才用求解器驗證（驗證較貴）。
            let clean = null;
            for (let hunt = 0; hunt < huntMoves; hunt++) {
                if (!hasAdjacentSameColor(scrambled)) { clean = scrambled; break; }
                scrambled = reverseScramble(scrambled, 1, random);
            }
            if (!clean && !hasAdjacentSameColor(scrambled)) clean = scrambled;
            if (isSolved(scrambled)) continue;                       // 沒打亂到，重來
            if (!isSolvable(scrambled, { maxNodes: verifyBudget })) continue;   // 罕見：單顆反向步不可逆
            const chosen = shuffleTubes(scrambled, random);
            best = best || chosen;
            if (clean) return shuffleTubes(clean, random);
            if (!hasAdjacentSameColor(chosen)) return chosen;
        }
        if (best) return best;

        // 最後手段：從完成狀態做 2 次「可逆的整管搬移」，仍然是可解的簡單盤面
        const fallback = buildSolvedState(numColors, numEmpty);
        const a = 0, b = numColors;                                  // 第 0 管倒進第一個空管
        for (let i = 0; i < TUBE_CAPACITY; i++) fallback[b].push(fallback[a].pop());
        return shuffleTubes(fallback, random);
    }

    return {
        TUBE_CAPACITY, mulberry32, clone,
        pourCount, canPour, applyMove,
        isUniform, isCompleteTube, isSolved, isDeadEnd, getValidMoves,
        canonical, solve, isSolvable, solveOptimal, starsFor,
        COLOR_SYMBOLS, dailySeed, todayKey,
        buildSolvedState, reverseScramble, hasAdjacentSameColor, shuffleTubes, generateLevel,
    };
});
