// ============================================
// Cloudflare Worker: 表单 + WebSocket + R2
// ============================================

const FORM_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>表单</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #fff; border-radius: 16px; padding: 32px 28px; width: 90%; max-width: 420px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .card h2 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    .card .desc { font-size: 13px; color: #888; margin-bottom: 24px; }
    .field { margin-bottom: 20px; }
    .field label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 8px; color: #333; }
    .field select { width: 100%; padding: 10px 14px; font-size: 15px; border: 1.5px solid #ddd; border-radius: 10px; outline: none; transition: border-color 0.2s; background: #fafafa; appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23999' stroke-width='1.5' fill='none'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 14px center; cursor: pointer; }
    .field select:focus { border-color: #f6821f; background: #fff; }
    .btn-save { width: 100%; padding: 12px; font-size: 16px; font-weight: 600; color: #fff; background: #f6821f; border: none; border-radius: 10px; cursor: pointer; transition: background 0.2s; }
    .btn-save:hover { background: #e0700e; }
    .btn-save:active { background: #c9600a; }
    .toast { display: none; position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 10px 24px; border-radius: 8px; font-size: 14px; z-index: 999; }
    .toast.show { display: block; animation: fadeIn 0.3s; }
    @keyframes fadeIn { from { opacity: 0; top: 10px; } to { opacity: 1; top: 20px; } }
    .status { margin-top: 16px; padding: 12px; background: #f0f0f0; border-radius: 8px; font-size: 13px; color: #666; }
    .status .online { color: #4caf50; font-weight: 600; }
    .status .offline { color: #f44336; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h2>欢迎使用</h2>
    <p class="desc">点击请选择...勾选功能并点击确定,当您的页面弹出已进行请求 ✓,数据会实时推送到设备,无需多次点击确定</p>
    <div class="field">
      <label for="dropdown">请选择功能</label>
      <select id="dropdown">
        <option value="" disabled selected>请选择...</option>
        <option value="LZE获取打卡数据">LZE获取打卡数据</option>
        <option value="LHJ获取打卡数据">LHJ获取打卡数据</option>
        <option value="WZM获取打卡数据">WZM获取打卡数据</option>
        <option value="WSB获取打卡数据">WSB获取打卡数据</option>
        <option value="全部获取打卡数据">全部获取打卡数据</option>
      </select>
    </div>
    <button class="btn-save" onclick="saveForm()">确定</button>
    <div class="status">设备连接: <span id="connStatus">检测中...</span></div>
  </div>
  <div class="toast" id="toast">已进行请求</div>
  <script>
    async function checkStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        const el = document.getElementById('connStatus');
        if (data.online) { el.innerHTML = '<span class="online">在线 (' + data.connections + '台)</span>'; }
        else { el.innerHTML = '<span class="offline">离线</span>'; }
      } catch (e) { document.getElementById('connStatus').innerHTML = '<span class="offline">检测失败</span>'; }
    }
    checkStatus();
    async function saveForm() {
      const dropdown = document.getElementById('dropdown').value;
      if (!dropdown) { showToast('请填写完整'); return; }
      try {
        const res = await fetch('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dropdown }) });
        const result = await res.json();
        showToast(result.success ? '已进行请求 ✓' : (result.error || '请求失败'));
      } catch (e) { showToast('网络错误'); }
    }
    function showToast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2000); }
  </script>
</body>
</html>`;

// 全局连接管理
const connections = new Map();

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const [, conn] of connections) {
    try { conn.ws.send(data); } catch (e) {}
  }
}

async function updateOnlineList(bucket, deviceId, isOnline) {
  if (!bucket || !deviceId) return;
  try {
    let list = [];
    const obj = await bucket.get("ws_online");
    if (obj) {
      list = await obj.json();
      if (!Array.isArray(list)) list = [];
    }
    if (isOnline) {
      list = list.filter(c => c.deviceId !== deviceId);
      list.push({ deviceId, connectedAt: Date.now() });
    } else {
      list = list.filter(c => c.deviceId !== deviceId);
    }
    if (list.length === 0) {
      await bucket.delete("ws_online");
    } else {
      await bucket.put("ws_online", JSON.stringify(list));
    }
  } catch (e) {}
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const bucket = env.WSS_BUCKET;

    // WebSocket
    if (request.headers.get("Upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      const clientId = crypto.randomUUID();
      server.accept();
      server.send(JSON.stringify({ type: "welcome", clientId }));

      let currentDeviceId = null;
      let cachedFormKey = null;

      // 检查 R2 是否有新表单，有则推送
      async function checkNewForm() {
        try {
          const obj = await bucket.get("form_index");
          if (!obj) return;
          const index = await obj.json();
          if (!index.latestKey || index.latestKey === cachedFormKey) return;
          const formObj = await bucket.get(index.latestKey);
          if (!formObj) return;
          const formData = await formObj.json();
          server.send(JSON.stringify({
            type: "form_submit",
            data: formData,
            formKey: index.latestKey
          }));
          cachedFormKey = index.latestKey;
        } catch (e) {}
      }

      // 服务端定时检查 R2（5秒一次），无需设备心跳
      const pollTimer = setInterval(async () => {
        await checkNewForm();
      }, 5000);

      // WebSocket 关闭时清除定时器
      server.addEventListener("close", () => {
        clearInterval(pollTimer);
      });

      server.addEventListener("error", () => {
        clearInterval(pollTimer);
      });

      server.addEventListener("message", async (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch (e) { return; }

        if (data.type === "register") {
          if (data.info && data.info.deviceId) {
            currentDeviceId = data.info.deviceId;
            connections.set(clientId, { ws: server, deviceId: currentDeviceId });
            await updateOnlineList(bucket, currentDeviceId, true);
          }
          server.send(JSON.stringify({ type: "registered" }));
          return;
        }

        if (data.type === "ping") {
          server.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (data.type === "heartbeat") {
          return;
        }
        if (data.type === "command_result") { console.log("[result]", clientId, JSON.stringify(data)); return; }
        if (data.type === "form_ack") return;

        server.send(JSON.stringify({ type: "echo", data }));
      });

      server.addEventListener("close", async () => {
        connections.delete(clientId);
        if (currentDeviceId) await updateOnlineList(bucket, currentDeviceId, false);
      });

      server.addEventListener("error", async () => {
        connections.delete(clientId);
        if (currentDeviceId) await updateOnlineList(bucket, currentDeviceId, false);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // 表单页面
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(FORM_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // 提交表单
    if (url.pathname === "/api/submit" && request.method === "POST") {
      try {
        const body = await request.json();
        const { dropdown } = body;
        if (!dropdown) {
          return new Response(JSON.stringify({ error: "缺少下拉字段" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }

        const ts = Date.now();
        const uniqueKey = `form:${ts}:${Math.random().toString(36).slice(2, 8)}`;
        const record = { dropdown, timestamp: new Date().toISOString(), ts };

        if (bucket) {
          await bucket.put(uniqueKey, JSON.stringify(record));

          let index = { keys: [], latestKey: uniqueKey };
          try {
            const obj = await bucket.get("form_index");
            if (obj) index = await obj.json();
          } catch (e) {}

          index.keys.unshift(uniqueKey);
          index.latestKey = uniqueKey;

          if (index.keys.length > 5) {
            const oldKeys = index.keys.slice(5);
            for (const k of oldKeys) { try { await bucket.delete(k); } catch (e) {} }
            index.keys = index.keys.slice(0, 5);
          }

          await bucket.put("form_index", JSON.stringify(index));
        }

        broadcast({ type: "form_submit", data: record, formKey: uniqueKey });

        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // 读取最新表单
    if (url.pathname === "/api/getcmd" && request.method === "GET") {
      try {
        if (!bucket) return new Response(JSON.stringify({ data: null }), { headers: { "Content-Type": "application/json" } });
        const obj = await bucket.get("form_index");
        if (obj) {
          const index = await obj.json();
          if (index.latestKey) {
            const formObj = await bucket.get(index.latestKey);
            if (formObj) {
              return new Response(JSON.stringify({ data: await formObj.json(), formKey: index.latestKey }), { headers: { "Content-Type": "application/json" } });
            }
          }
        }
        return new Response(JSON.stringify({ data: null }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // 清除
    if (url.pathname === "/api/clear" && request.method === "POST") {
      try {
        if (bucket) {
          const obj = await bucket.get("form_index");
          if (obj) {
            const index = await obj.json();
            if (index.keys) { for (const k of index.keys) { try { await bucket.delete(k); } catch (e) {} } }
          }
          await bucket.delete("form_data");
          await bucket.delete("form_index");
        }
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // 在线状态
    if (url.pathname === "/api/status" && request.method === "GET") {
      try {
        if (!bucket) return new Response(JSON.stringify({ online: false, connections: 0 }), { headers: { "Content-Type": "application/json" } });
        const obj = await bucket.get("ws_online");
        let list = [];
        if (obj) {
          list = await obj.json();
          if (!Array.isArray(list)) list = [];
        }
        const uniqueDevices = new Set(list.map(c => c.deviceId).filter(Boolean));
        return new Response(JSON.stringify({ online: uniqueDevices.size > 0, connections: uniqueDevices.size }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ online: false, connections: 0 }), { headers: { "Content-Type": "application/json" } });
      }
    }

    return new Response("Not Found", { status: 404 });
  },

  // Cron Trigger
  async scheduled(event, env, ctx) {
    const bucket = env.WSS_BUCKET;
    if (bucket) {
      try {
        const obj = await bucket.get("form_index");
        if (obj) {
          const index = await obj.json();
          if (index.keys) { for (const k of index.keys) { try { await bucket.delete(k); } catch (e) {} } }
        }
        await bucket.delete("form_data");
        await bucket.delete("form_index");
        console.log("[Cron] 每日表单数据已清除");
      } catch (e) {
        console.error("[Cron] 清理失败", e.message);
      }
    }
  }
};
