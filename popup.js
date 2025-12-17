// 定义一个简写函数 $，通过 ID 获取 DOM 元素，模仿 jQuery 的语法
const $ = (id) => document.getElementById(id);

// 当弹出窗口的 HTML 结构加载完成后执行
document.addEventListener("DOMContentLoaded", async () => {
  // --- 获取 UI 元素引用 ---
  const apiUrl = $("apiUrl");         // API 地址输入框
  const apiKey = $("apiKey");         // API Key 输入框
  const modelName = $("modelName");   // 模型名称输入框（如 gpt-4）
  const systemPrompt = $("systemPrompt"); // AI 人设提示词输入框
  const btn = $("toggleBtn");         // 启动/停止 按钮
  const badge = $("badge");           // 运行状态标签（显示“运行中”或“已停止”）
  const count = $("count");           // 已回复次数统计显示
  const err = $("error");             // 错误信息显示区域

  // --- 初始化数据加载 ---
  // 从插件本地存储中读取之前保存的设置和状态
  const data = await chrome.storage.local.get([
    "apiUrl",
    "apiKey",
    "modelName",
    "systemPrompt",
    "isRunning",
    "totalReplies"
  ]);

  // 将读取到的数据填充到输入框中，如果没有数据则使用默认值
  apiUrl.value = data.apiUrl || "https://api.openai.com/v1";
  apiKey.value = data.apiKey || "";
  modelName.value = data.modelName || "gpt-3.5-turbo";
  systemPrompt.value =
    data.systemPrompt ||
    "你是一个真实网友，用简短自然的语气发表评论，8-20词，0-2个emoji，不要像机器人。";

  // 更新界面的回复计数和运行状态 UI
  count.textContent = String(data.totalReplies || 0);
  setUI(!!data.isRunning); // !! 用于将值强制转换为布尔型

  // --- 按钮点击事件 ---
  btn.addEventListener("click", async () => {
    // 每次点击先清空并隐藏错误提示
    err.style.display = "none";
    err.textContent = "";

    // 获取当前是否正在运行的状态
    const now = await chrome.storage.local.get(["isRunning"]);
    const next = !now.isRunning; // 切换状态：如果是运行中，则准备停止；反之亦然

    // 收集当前输入框中的最新配置
    const payload = {
      isRunning: next,
      apiUrl: apiUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      modelName: (modelName.value.trim() || "gpt-3.5-turbo").trim(),
      systemPrompt: systemPrompt.value.trim()
    };

    // 如果操作是“启动”（next 为 true），则重置回复计数为 0
    if (next) {
      await chrome.storage.local.set({ totalReplies: 0 });
      count.textContent = "0";
      payload.totalReplies = 0;
    }

    // 将更新后的配置和状态保存到本地存储
    await chrome.storage.local.set(payload);

    // 向 Background（后台脚本）发送消息，通知其开始或停止自动化操作
    // TOGGLE_FOR_ACTIVE_TAB 是自定义的消息类型
    chrome.runtime.sendMessage({ type: "TOGGLE_FOR_ACTIVE_TAB", payload }, (resp) => {
      // 检查发送消息时是否发生扩展系统级别的错误
      if (chrome.runtime.lastError) {
        showErr("发送失败：" + chrome.runtime.lastError.message);
        return;
      }
      // 检查后台脚本返回的处理结果是否成功
      if (!resp?.ok) {
        showErr(resp?.error || "启动失败");
        // 如果后台启动失败，UI 状态回滚到“停止”状态
        setUI(false);
        chrome.storage.local.set({ isRunning: false });
        return;
      }
      // 如果一切顺利，根据新状态更新 UI 样式
      setUI(next);
    });
  });

  // --- 监听来自后台的消息 ---
  chrome.runtime.onMessage.addListener((msg) => {
    // 如果后台脚本发来“更新计数”的消息，实时更新界面数字
    if (msg?.type === "UPDATE_COUNT") {
      count.textContent = String(msg?.payload?.count ?? 0);
    }
  });

  // --- 辅助函数：更新界面样式 ---
  function setUI(isRunning) {
    if (isRunning) {
      badge.textContent = "运行中";
      badge.className = "badge running"; // 改变标签颜色/样式
      btn.textContent = "停止";
      btn.classList.add("stop");        // 改变按钮为红色等停止样式
    } else {
      badge.textContent = "已停止";
      badge.className = "badge stopped";
      btn.textContent = "启动";
      btn.classList.remove("stop");
    }
  }

  // --- 辅助函数：显示错误信息 ---
  function showErr(t) {
    err.textContent = t;
    err.style.display = "block";
  }
});