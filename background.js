// background.js（MV3 Service Worker）
// 目标：
// - 接收 popup 的 start/stop 并转发给 content（基于 READY 握手，避免 receiving end does not exist）
// - 提供 CALL_AI_API 接口（OpenAI 兼容 chat/completions）
// - 所有消息都 return true，避免 port closed

const READY_TABS = new Set();

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  // content -> background: ready handshake
  if (req?.type === "CONTENT_READY") {
    if (sender?.tab?.id != null) READY_TABS.add(sender.tab.id);
    sendResponse({ ok: true });
    return true;
  }

  // popup -> background: toggle state for active tab
  if (req?.type === "TOGGLE_FOR_ACTIVE_TAB") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url) {
          sendResponse({ ok: false, error: "未找到当前标签页" });
          return;
        }
        if (!isXTab(tab.url)) {
          sendResponse({ ok: false, error: "请在 x.com / twitter.com 页面打开插件" });
          return;
        }

        // 保存配置（给 content 读取）
        await chrome.storage.local.set(req.payload || {});

        // 尝试发送给 content
        const ok = await safeSendToTab(tab.id, {
          type: "STATE_CHANGE",
          payload: req.payload || {}
        });

        if (!ok) {
          sendResponse({
            ok: false,
            error:
              "content 未连接（可能页面未刷新/刚重载扩展）。请刷新该 X 页面(F5)后再点启动。"
          });
          return;
        }

        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  // content -> background: call AI
  if (req?.type === "CALL_AI_API") {
    (async () => {
      try {
        const resp = await handleOpenAI(req.payload || {});
        sendResponse(resp);
      } catch (e) {
        sendResponse({ success: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  sendResponse({ ok: true });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => READY_TABS.delete(tabId));

function isXTab(url) {
  return url.startsWith("https://x.com/") || url.startsWith("https://twitter.com/");
}

async function safeSendToTab(tabId, msg) {
  // 若未 READY，直接返回 false（避免 receiving end 不存在）
  if (!READY_TABS.has(tabId)) return false;

  try {
    await chrome.tabs.sendMessage(tabId, msg);
    return true;
  } catch {
    // content 可能被销毁（SPA 路由/刷新），移除 READY
    READY_TABS.delete(tabId);
    return false;
  }
}

function normalizeEndpoint(apiUrl) {
  let base = String(apiUrl || "").trim();
  if (!base) base = "https://api.openai.com/v1";
  base = base.replace(/\/+$/, "");

  // 允许用户填： https://xx.com  / https://xx.com/v1 / https://xx.com/v1/chat/completions
  if (!base.includes("/v1")) base += "/v1";
  if (!base.endsWith("/chat/completions")) base += "/chat/completions";
  return base;
}

async function handleOpenAI({ apiUrl, apiKey, model, messages }) {
  if (!apiKey) return { success: false, error: "API Key 为空" };

  const endpoint = normalizeEndpoint(apiUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const r = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || "gpt-3.5-turbo",
        messages: messages || [],
        temperature: 0.8,
        max_tokens: 120
      })
    });

    const raw = await r.text().catch(() => "");
    if (!r.ok) {
      return { success: false, error: `API ${r.status}: ${raw.slice(0, 200)}` };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { success: false, error: "AI 返回非 JSON（网关不兼容 chat/completions）" };
    }

    const text = data?.choices?.[0]?.message?.content?.trim() || "";
    if (!text) return { success: false, error: "AI 返回为空" };

    const cleaned = text
      .replace(/^["“”]+|["“”]+$/g, "")
      .replace(/\s*\n+\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 220);

    return { success: true, reply: cleaned };
  } finally {
    clearTimeout(timer);
  }
}
