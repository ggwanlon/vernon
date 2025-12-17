// content.js

// --- 全局状态 ---
let isRunning = false; // 统一变量名
let processedTweetIds = new Set();
let scrollIntervalId = null;
let scanObserver = null;
let replyQueue = [];
let isProcessingReply = false;

const AI_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8z"/><path d="M12 6a1 1 0 0 0-1 1v2H9a1 1 0 0 0 0 2h2v2a1 1 0 0 0 2 0v-2h2a1 1 0 0 0 0-2h-2V7a1 1 0 0 0-1-1z"/></svg>`;

// --- 初始化与消息监听 ---

// 1. 发送握手信号 (修复点：让background知道由于content已就绪)
chrome.runtime.sendMessage({ type: "CONTENT_READY" });

// 2. 初始状态检查 (统一使用 isRunning)
chrome.storage.local.get(['isRunning'], (data) => {
  if (data.isRunning) {
    startAutomation();
  }
});

// 3. 监听来自 Background 的统一消息
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  // 对应 background.js 的 STATE_CHANGE
  if (req.type === "STATE_CHANGE") {
    const { isRunning: shouldRun } = req.payload;
    if (shouldRun) {
      startAutomation();
    } else {
      stopAutomation();
    }
  }
  // 保持 return true 防止报错
  return true;
});

// 常规功能：注入手动按钮
const manualObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.addedNodes.length) {
      injectButtons();
    }
  }
});
manualObserver.observe(document.body, { childList: true, subtree: true });


// --- 自动化核心逻辑 ---

async function startAutomation() {
  if (isRunning) return;
  isRunning = true;
  console.log("AI 助手：开始自动运行...");

  processedTweetIds.clear();

  // 1. 启动滚动
  scrollIntervalId = setInterval(() => {
  window.scrollBy(0, 100);
  }, 5000); // 默认 5秒一滚

  // 2. 启动扫描
  scanObserver = new MutationObserver((mutations) => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === 1) {
          // 兼容两种选择器
          if (node.tagName === 'ARTICLE' && node.getAttribute('data-testid') === 'tweet') {
             enqueueTweet(node);
          }
          const tweets = node.querySelectorAll ? node.querySelectorAll('article[data-testid="tweet"]') : [];
          tweets.forEach(tweet => enqueueTweet(tweet));
        }
      });
    });
  });

  scanObserver.observe(document.body, { childList: true, subtree: true });

  // 3. 启动队列处理
  processReplyQueue();
}

function stopAutomation() {
  isRunning = false;
  console.log("AI 助手：停止运行");

  if (scrollIntervalId) {
    clearInterval(scrollIntervalId);
    scrollIntervalId = null;
  }
  if (scanObserver) {
    scanObserver.disconnect();
    scanObserver = null;
  }
}

// --- 推文过滤与排队 ---

function enqueueTweet(tweetElement) {
  const tweetId = getTweetId(tweetElement);
  if (!tweetId || processedTweetIds.has(tweetId)) {
    return;
  }

  // 避免回复广告 (Promoted)
  if (tweetElement.innerText.includes("Ad") || tweetElement.innerText.includes("Promoted")) {
      return;
  }

  if (isMainTweet(tweetElement)) {
    processedTweetIds.add(tweetId); // 标记但不处理主贴(如果不想回复正在看的详情页主推文)
    return;
  }

  processedTweetIds.add(tweetId);
  replyQueue.push(tweetElement);
  
  // 更新 popup 计数
  updateCount();
}

function getTweetId(tweetElement) {
  const link = tweetElement.querySelector('a[href*="/status/"]');
  if (link) {
    const parts = link.href.split('/status/');
    if (parts.length > 1) {
      return parts[1].split('/')[0];
    }
  }
  return null;
}

function isMainTweet(tweetElement) {
    const pathname = window.location.pathname;
    if (pathname === '/' || pathname === '/home') return false; // 主页流都不是 Main Tweet
    
    const tweetUrl = tweetElement.querySelector('a[href*="/status/"]')?.href;
    if (tweetUrl && pathname.includes('/status/') && tweetUrl.includes(pathname.split('/status/')[1].split('/')[0])) {
        return true;
    }
    return false;
}

// --- 队列处理 ---

async function processReplyQueue() {
  while (isRunning) {
    if (replyQueue.length > 0 && !isProcessingReply) {
      const tweetElement = replyQueue.shift();
      if (document.body.contains(tweetElement)) {
          await triggerAutoReply(tweetElement);
      }
    }
    await randomDelay(2000);
  }
}

// --- AI 请求构建 (修复点：构建符合 background 要求的消息体) ---

async function generateReplyFromAI(tweetText) {
    // 从 storage 获取最新的配置
    const config = await chrome.storage.local.get(['apiKey', 'apiUrl', 'modelName', 'systemPrompt']);
    
    if (!config.apiKey) {
        throw new Error("请先在插件配置中填写 API Key");
    }

    const messages = [
        { role: "system", content: config.systemPrompt || "You are a helpful assistant." },
        { role: "user", content: `Reply to this tweet: "${tweetText}"` }
    ];

    // 发送消息给 background (使用 CALL_AI_API)
    const response = await chrome.runtime.sendMessage({
        type: "CALL_AI_API",
        payload: {
            apiKey: config.apiKey,
            apiUrl: config.apiUrl,
            model: config.modelName,
            messages: messages
        }
    });

    if (!response || !response.success) {
        throw new Error(response?.error || "Unknown AI Error");
    }

    return response.reply;
}

// --- 自动化操作核心 ---

async function triggerAutoReply(tweetElement) {
  isProcessingReply = true;
  tweetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

  try {
    const textNode = tweetElement.querySelector('div[data-testid="tweetText"]');
    const tweetText = textNode ? textNode.innerText : "";
    if (!tweetText) return;

    console.log(`Processing: ${tweetText.slice(0, 20)}...`);

    // 1. 调用 AI
    const replyText = await generateReplyFromAI(tweetText);
    console.log(`AI Reply: ${replyText}`);

    // 2. 点击回复按钮
    const replyButton = tweetElement.querySelector('button[data-testid="reply"]');
    if (!replyButton) throw new Error("Reply button not found");
    
    replyButton.click();
    
    // 3. 等待输入框
    const inputBox = await waitForElement('div[role="dialog"] div[role="textbox"]', 5000);
    if (!inputBox) throw new Error("Input box not open");

    // 4. 模拟输入
    await simulateReactInput(inputBox, replyText);

    // 5. 点击发送
    const sent = await clickSendButton();
    if (sent) {
        console.log("✅ Sent!");
        updateCount(1); // 增加计数
        await randomDelay(3000, 5000); 
        window.scrollBy(0, 400);
    } else {
        // 如果发送失败，尝试关闭弹窗
        const closeBtn = document.querySelector('div[role="dialog"] button[aria-label="Close"]');
        if(closeBtn) closeBtn.click();
    }

  } catch (err) {
    console.error("Skipped:", err.message);
  } finally {
    isProcessingReply = false;
  }
}

// --- React 输入模拟 (保留原有逻辑，无需更改) ---
async function simulateReactInput(element, text) {
  element.focus();
  await randomDelay(100);
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, text);
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function clickSendButton() {
    let attempts = 0;
    while (attempts < 10) {
        const sendButton = document.querySelector('div[role="dialog"] button[data-testid="tweetButton"]');
        if (sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
            sendButton.click();
            return true;
        }
        await randomDelay(500);
        attempts++;
    }
    return false;
}

function waitForElement(selector, timeout) {
    return new Promise(resolve => {
        if (document.querySelector(selector)) return resolve(document.querySelector(selector));
        const observer = new MutationObserver(() => {
            if (document.querySelector(selector)) {
                observer.disconnect();
                resolve(document.querySelector(selector));
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
    });
}

function updateCount(add = 0) {
    chrome.storage.local.get(['totalReplies'], (data) => {
        const newCount = (data.totalReplies || 0) + add;
        if(add > 0) chrome.storage.local.set({ totalReplies: newCount });
        // 可选：通知 popup 更新 UI
        chrome.runtime.sendMessage({ type: "UPDATE_COUNT", payload: { count: newCount } }).catch(()=>{});
    });
}

// --- 手动按钮注入逻辑 ---
function injectButtons() {
  const tweets = document.querySelectorAll('article[data-testid="tweet"]');
  tweets.forEach((tweet) => {
    if (tweet.querySelector(".ai-reply-btn") || isRunning) return; // 运行时不显示手动按钮避免冲突
    
    const actionBar = tweet.querySelector('div[role="group"]');
    if (actionBar) {
      const btnContainer = createAIButton(tweet);
      // 插入到回复按钮后面
      const replyDiv = actionBar.querySelector('div[data-testid="reply"]');
      if (replyDiv && replyDiv.parentNode) {
          // 找到 replyDiv 的父级通常是一个 wrapper，我们需要插入到 replyDiv 这个 wrapper 的后面或者内部
          // Twitter 结构复杂，追加到 actionBar 最后最稳妥
          actionBar.appendChild(btnContainer);
      }
    }
  });
}

function createAIButton(tweetElement) {
  const container = document.createElement("div");
  container.className = "ai-reply-btn"; // 标记类名
  container.style.cssText = "display: flex; align-items: center; margin-left: 12px; cursor: pointer; color: #1d9bf0;";
  container.innerHTML = AI_ICON;
  container.title = "AI 生成";

  container.addEventListener("click", async (e) => {
    e.stopPropagation();
    e.preventDefault();
    
    if (isProcessingReply) return;
    container.style.color = "orange";
    
    try {
        const textNode = tweetElement.querySelector('div[data-testid="tweetText"]');
        const text = textNode ? textNode.innerText : "";
        
        const reply = await generateReplyFromAI(text);
        
        // 手动模式下，只负责填入，不负责发送，让用户确认
        const replyButton = tweetElement.querySelector('button[data-testid="reply"]');
        replyButton.click();
        
        const inputBox = await waitForElement('div[role="dialog"] div[role="textbox"]', 3000);
        if (inputBox) {
            await simulateReactInput(inputBox, reply);
        } else {
            alert("已复制回复:\n" + reply);
            navigator.clipboard.writeText(reply);
        }
    } catch(err) {
        alert("错误: " + err.message);
    } finally {
        container.style.color = "#1d9bf0";
    }
  });
  
  return container;
}

function randomDelay(min, max) {
    if (!max) max = min;
    return new Promise(resolve => setTimeout(resolve, Math.random() * (max - min) + min));
}