/**
 * AntiSpamVaccine — Revenge (Mobile Discord) Plugin
 * 
 * 디스코드 크래셔/스팸 메시지를 렌더링 전에 즉시 차단.
 * BetterDiscord v2.3 감지 엔진 이식 — for 루프만 사용, 정규식 없음.
 * 
 * 방어 벡터:
 * - 길이 초과 (2000자+)
 * - 연속 반복 문자 (]]]]]]..., !!!!!!!!!... 100회+)
 * - 마크다운 중첩 크래셔 ([[[[..., ]]]]..., ((((... 30회+)
 * - 스포일러 태그 크래셔 (|| 남용)
 * - 잘고 텍스트 (Combining Characters 도배)
 * - BiDi 오버라이드 크래셔
 * - 줄바꿈 도배
 * - Zero-width 문자 도배
 */

(function() {

// 플러그인 로드 시점에 필요한 모듈 가져오기 (번들러 없이 단일 파일로 동작)
const v = window.vendetta ?? window.revenge;
if (!v) {
    console.error("[ASV] Neither vendetta nor revenge API found.");
    return {
        onLoad() {},
        onUnload() {}
    };
}

const findByProps = v.metro?.findByProps ?? v.modules?.finders?.findByProps;
const before = v.patcher?.before;
const after = v.patcher?.after;
const showToast = v.ui?.toasts?.showToast ?? v.toasts?.showToast ?? v.showToast;
const storage = v.storage;


/* ═══════════════════════════════════════════════════════════
   기본 설정
   ═══════════════════════════════════════════════════════════ */
const DEFAULT_SETTINGS = {
    hardLimit: 2000,           // 즉시 차단 글자 수
    repeatLimit: 100,          // 연속 반복 허용 최대 횟수
    blockMarkdownNest: true,   // 마크다운 중첩 크래셔 (괄호 대량 반복)
    blockSpoilerAbuse: true,   // 스포일러 태그 크래셔
    blockZalgo: true,          // 잘고 텍스트
    blockBidi: true,           // BiDi 오버라이드
    maxNewlines: 30,           // 줄바꿈 도배 임계값
    maxZeroWidth: 15,          // Zero-width 문자 임계값
    toastAlert: true,          // 차단 알림
};

/* ═══════════════════════════════════════════════════════════
   설정 관리
   ═══════════════════════════════════════════════════════════ */
function getSettings() {
    // storage가 없으면 기본값 사용
    if (!storage) return { ...DEFAULT_SETTINGS };

    const s = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (storage[key] !== undefined) {
            s[key] = storage[key];
        }
    }
    return s;
}

function initSettings() {
    if (!storage) return;
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
        if (storage[key] === undefined) {
            storage[key] = val;
        }
    }
    // v2.1 마이그레이션: 낮은 임계값 리셋
    if (storage.repeatLimit < 20) storage.repeatLimit = 100;
    if (storage.hardLimit < 500) storage.hardLimit = 2000;
}

/* ═══════════════════════════════════════════════════════════
   스팸/크래셔 감지 엔진
   ─────────────────────────────────────────────────────────
   BetterDiscord v2.3과 동일한 엔진
   규칙: 정규식 절대 금지, for 루프만 사용
   ═══════════════════════════════════════════════════════════ */
function detectSpam(content) {
    if (!content || typeof content !== "string") return null;

    const s = getSettings();
    const len = content.length;

    // ━━━ 1. 하드 리밋: 길이 초과 → 분석 없이 즉시 차단 ━━━
    if (len > s.hardLimit) {
        return {
            type: "길이초과",
            detail: `${len.toLocaleString()}자 (제한: ${s.hardLimit}자)`
        };
    }

    // ━━━ 초고속 에이징: 극단적으로 짧은 메시지는 검사 건너뜀 ━━━
    if (len < 10) return null;

    // 단일 루프로 모든 문자 스캔 (루프 퓨전 최적화)
    let maxRepeat = 0;
    let maxRepeatChar = "";
    let repeatCount = 1;

    let bOpen = 0, bClose = 0, pOpen = 0, pClose = 0;
    let maxB = 0, maxBC = 0, maxP = 0, maxPC = 0;

    let spoilerCount = 0;
    let combiningCount = 0;
    let bidiCount = 0;
    let nlCount = 0;
    let zwCount = 0;

    for (let i = 0; i < len; i++) {
        const ch = content[i];
        const code = content.charCodeAt(i);

        // 1. 연속 반복 문자 (이전 문자와 비교)
        if (i > 0) {
            if (ch === content[i - 1]) {
                repeatCount++;
                if (repeatCount > maxRepeat) {
                    maxRepeat = repeatCount;
                    maxRepeatChar = ch;
                }
            } else {
                repeatCount = 1;
            }
        }

        // 2. 마크다운 중첩 괄호 검사
        if (s.blockMarkdownNest) {
            if (ch === "[") { bOpen++; if (bOpen > maxB) maxB = bOpen; } else { bOpen = 0; }
            if (ch === "]") { bClose++; if (bClose > maxBC) maxBC = bClose; } else { bClose = 0; }
            if (ch === "(") { pOpen++; if (pOpen > maxP) maxP = pOpen; } else { pOpen = 0; }
            if (ch === ")") { pClose++; if (pClose > maxPC) maxPC = pClose; } else { pClose = 0; }
        }

        // 3. 스포일러 태그 (||)
        if (s.blockSpoilerAbuse && ch === "|" && i < len - 1 && content[i + 1] === "|") {
            spoilerCount++;
            i++; // 다음 "|" 문자 건너뛰기
            continue;
        }

        // 4. 잘고 텍스트 (Combining Characters)
        if (s.blockZalgo) {
            if ((code >= 0x0300 && code <= 0x036F) ||
                (code >= 0x0489 && code <= 0x0489) ||
                (code >= 0x1AB0 && code <= 0x1AFF) ||
                (code >= 0x1DC0 && code <= 0x1DFF) ||
                (code >= 0x20D0 && code <= 0x20FF) ||
                (code >= 0xFE00 && code <= 0xFE0F) ||
                (code >= 0xFE20 && code <= 0xFE2F)) {
                combiningCount++;
            }
        }

        // 5. BiDi 오버라이드
        if (s.blockBidi) {
            if (code === 0x200E || code === 0x200F ||
                code === 0x202A || code === 0x202B ||
                code === 0x202C || code === 0x202D ||
                code === 0x202E ||
                code === 0x2066 || code === 0x2067 ||
                code === 0x2068 || code === 0x2069) {
                bidiCount++;
            }
        }

        // 6. 줄바꿈
        if (ch === "\n") {
            nlCount++;
        }

        // 7. Zero-width 문자
        if (code === 0x200B || code === 0x200C ||
            code === 0x200D || code === 0x2060 ||
            code === 0xFEFF || code === 0x00AD) {
            zwCount++;
        }
    }

    // ━━━ 최종 결과 판정 ━━━
    if (maxRepeat >= s.repeatLimit) {
        return { type: "반복문자", detail: `'${maxRepeatChar}' × ${maxRepeat}회 연속` };
    }

    if (s.blockMarkdownNest) {
        const worst = [
            { ch: "[", n: maxB }, { ch: "]", n: maxBC },
            { ch: "(", n: maxP }, { ch: ")", n: maxPC }
        ].sort((a, b) => b.n - a.n)[0];

        if (worst.n >= 30) {
            return { type: "마크다운크래셔", detail: `'${worst.ch}' × ${worst.n}회 연속 — 마크다운 파서 과부하` };
        }
    }

    if (s.blockSpoilerAbuse && spoilerCount > 20) {
        return { type: "스포일러크래셔", detail: `스포일러 태그 ${spoilerCount}개` };
    }

    if (s.blockZalgo && combiningCount > 30) {
        return { type: "잘고텍스트", detail: `결합문자 ${combiningCount}개` };
    }

    if (s.blockBidi && bidiCount > 10) {
        return { type: "BiDi크래셔", detail: `방향 오버라이드 문자 ${bidiCount}개` };
    }

    if (nlCount > s.maxNewlines) {
        return { type: "줄바꿈도배", detail: `줄바꿈 ${nlCount}개` };
    }

    if (zwCount > s.maxZeroWidth) {
        return { type: "투명문자", detail: `보이지 않는 문자 ${zwCount}개` };
    }

    return null;
}

/* ═══════════════════════════════════════════════════════════
   메시지 소독 — content를 안전한 텍스트로 교체
   ═══════════════════════════════════════════════════════════ */
let blockedCount = 0;

function sanitizeMessage(msg) {
    if (!msg?.content) return;
    if (msg._asv) return;

    // 반복 검사 방지를 위해 즉시 처리됨(Checked) 마크 표시
    msg._asv = true;

    const result = detectSpam(msg.content);
    if (!result) return;

    const origLen = msg.content.length;
    const safePreview = msg.content.substring(0, 60).replace(/\n/g, "↵");

    // 메시지 내용 교체 — React Native가 이 짧은 텍스트만 렌더링
    msg.content =
        `🛡️ **[스팸 차단]** ${result.type}\n` +
        `> ${result.detail}\n` +
        `> 원본: ${origLen.toLocaleString()}자 | 미리보기: \`${safePreview}…\``;

    blockedCount++;

    const s = getSettings();
    if (s.toastAlert && blockedCount <= 15) {
        try {
            showToast?.(
                `🛡️ ${result.type} 차단 (${origLen.toLocaleString()}자)`,
                "warning"
            );
        } catch (e) {
            // 토스트 실패해도 차단은 성공
        }
    }
}

/* ═══════════════════════════════════════════════════════════
   플러그인 라이프사이클
   ═══════════════════════════════════════════════════════════ */
const patches = [];

return {
    onLoad() {
        blockedCount = 0;
        initSettings();

        // ── FluxDispatcher 찾기 ──
        // Revenge의 모듈 파인더로 Discord 내부 Dispatcher 탐색
        let Dispatcher = null;

        try {
            Dispatcher =
                findByProps("dispatch", "subscribe", "wait") ??
                findByProps("dispatch", "subscribe", "_dispatch") ??
                findByProps("dispatch", "subscribe");
        } catch (e) {
            console.error("[ASV] Dispatcher 탐색 실패:", e);
        }

        if (!Dispatcher) {
            console.warn("[ASV] FluxDispatcher를 찾을 수 없음 — 플러그인 비활성");
            try {
                showToast?.("🛡️ ASV: Dispatcher 못 찾음 — 업데이트 필요", "error");
            } catch (e) {}
            return;
        }

        // ── Dispatcher.dispatch 패치 ──
        // MESSAGE_CREATE / MESSAGE_UPDATE / LOAD_MESSAGES 가로채기
        const unpatch = before("dispatch", Dispatcher, ([event]) => {
            if (!event) return;

            try {
                switch (event.type) {
                    case "MESSAGE_CREATE":
                        if (event.message) sanitizeMessage(event.message);
                        break;

                    case "MESSAGE_UPDATE":
                        if (event.message) sanitizeMessage(event.message);
                        break;

                    case "LOAD_MESSAGES_SUCCESS":
                        if (event.messages) {
                            for (let i = 0; i < event.messages.length; i++) {
                                sanitizeMessage(event.messages[i]);
                            }
                        }
                        break;

                    case "LOAD_MESSAGES_AROUND_SUCCESS":
                        if (event.messages) {
                            for (let i = 0; i < event.messages.length; i++) {
                                sanitizeMessage(event.messages[i]);
                            }
                        }
                        break;
                }
            } catch (err) {
                // 절대 Discord를 죽이면 안 됨
                console.error("[ASV] dispatch 패치 오류:", err);
            }
        });

        patches.push(unpatch);

        // ── MessageStore 패치 (로컬 캐시/이미 로드된 메시지 처리) ──
        try {
            const MessageStore = findByProps("getMessages", "getMessage");
            if (MessageStore && after) {
                // getMessages 패치
                const unpatchGetMessages = after("getMessages", MessageStore, (args, res) => {
                    if (res) {
                        if (res._array && Array.isArray(res._array)) {
                            for (let i = 0; i < res._array.length; i++) {
                                sanitizeMessage(res._array[i]);
                            }
                        } else if (Array.isArray(res)) {
                            for (let i = 0; i < res.length; i++) {
                                sanitizeMessage(res[i]);
                            }
                        } else if (typeof res === "object") {
                            const msgs = res.toArray?.() || res.values?.() || Object.values(res);
                            if (Array.isArray(msgs)) {
                                for (let i = 0; i < msgs.length; i++) {
                                    sanitizeMessage(msgs[i]);
                                }
                            }
                        }
                    }
                    return res;
                });
                patches.push(unpatchGetMessages);

                // getMessage 패치
                const unpatchGetMessage = after("getMessage", MessageStore, (args, res) => {
                    if (res) {
                        sanitizeMessage(res);
                    }
                    return res;
                });
                patches.push(unpatchGetMessage);

                console.log("[ASV] MessageStore 패치 성공");
            }
        } catch (e) {
            console.error("[ASV] MessageStore 패치 실패:", e);
        }

        console.log("[ASV] AntiSpamVaccine 로드 완료 — Dispatcher & MessageStore 패치 성공");
        try {
            showToast?.("🛡️ AntiSpamVaccine 활성화", "success");
        } catch (e) {}
    },

    onUnload() {
        // 모든 패치 해제
        for (const unpatch of patches) {
            try {
                unpatch?.();
            } catch (e) {}
        }
        patches.length = 0;

        console.log(`[ASV] 언로드 완료 (차단: ${blockedCount}건)`);
        try {
            showToast?.(`🛡️ ASV 비활성화 (차단: ${blockedCount}건)`, "info");
        } catch (e) {}
    }
};

})();
