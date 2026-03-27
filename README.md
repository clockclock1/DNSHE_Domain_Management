# DNSHE_Domain_Management
DNSHE 域名管理器 - Cloudflare Workers
# DNSHE 域名管理器 - Cloudflare Workers 完整代码

需要在 Workers 中绑定：

- **KV Namespace**: 绑定名称为 `KV`
- **环境变量**: `PASSWORD` (设置你的登录密码)

JavaScript



```
const DNSHE_API = 'https://api005.dnshe.com/index.php';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsH() });
    }
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(HTML(), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }
    if (url.pathname.startsWith('/api/')) return handleAPI(request, env, url);
    return new Response('Not Found', { status: 404 });
  }
};

function corsH() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' };
}
function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...corsH() } });
}
async function genToken(p) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p + '_dnshe_salt_2024'));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function auth(req, env) {
  const a = req.headers.get('Authorization');
  if (!a || !a.startsWith('Bearer ')) return false;
  return a.replace('Bearer ', '') === await genToken(env.PASSWORD || 'admin');
}

async function handleAPI(req, env, url) {
  const p = url.pathname;
  if (p === '/api/login' && req.method === 'POST') {
    try {
      const b = await req.json();
      if (b.password === (env.PASSWORD || 'admin')) return json({ success: true, token: await genToken(env.PASSWORD || 'admin') });
      return json({ success: false, error: '密码错误' }, 401);
    } catch { return json({ error: '请求格式错误' }, 400); }
  }
  if (!await auth(req, env)) return json({ error: '未授权' }, 401);
  if (!env.KV) return json({ error: 'KV未绑定，请绑定KV命名空间' }, 500);

  if (p === '/api/accounts' && req.method === 'GET') {
    return json({ success: true, accounts: JSON.parse(await env.KV.get('accounts') || '[]') });
  }
  if (p === '/api/accounts' && req.method === 'POST') {
    const b = await req.json();
    if (!b.name || !b.apiKey || !b.apiSecret) return json({ error: '请填写所有字段' }, 400);
    const accs = JSON.parse(await env.KV.get('accounts') || '[]');
    const na = { id: crypto.randomUUID(), name: b.name, apiKey: b.apiKey, apiSecret: b.apiSecret, createdAt: new Date().toISOString() };
    accs.push(na);
    await env.KV.put('accounts', JSON.stringify(accs));
    return json({ success: true, account: na });
  }
  const m = p.match(/^\/api\/accounts\/([^/]+)$/);
  if (m) {
    const id = m[1];
    let accs = JSON.parse(await env.KV.get('accounts') || '[]');
    if (req.method === 'PUT') {
      const b = await req.json(), i = accs.findIndex(a => a.id === id);
      if (i === -1) return json({ error: '账号不存在' }, 404);
      if (b.name) accs[i].name = b.name;
      if (b.apiKey) accs[i].apiKey = b.apiKey;
      if (b.apiSecret) accs[i].apiSecret = b.apiSecret;
      await env.KV.put('accounts', JSON.stringify(accs));
      return json({ success: true, account: accs[i] });
    }
    if (req.method === 'DELETE') {
      accs = accs.filter(a => a.id !== id);
      await env.KV.put('accounts', JSON.stringify(accs));
      return json({ success: true });
    }
  }
  if (p === '/api/proxy' && req.method === 'POST') {
    try {
      const b = await req.json();
      const accs = JSON.parse(await env.KV.get('accounts') || '[]');
      const acc = accs.find(a => a.id === b.accountId);
      if (!acc) return json({ error: '账号不存在' }, 404);
      let u = `${DNSHE_API}?m=domain_hub&endpoint=${b.endpoint}&action=${b.action}`;
      if (b.params) Object.entries(b.params).forEach(([k, v]) => u += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      const opt = { method: b.method || 'GET', headers: { 'X-API-Key': acc.apiKey, 'X-API-Secret': acc.apiSecret, 'Content-Type': 'application/json' } };
      if ((b.method === 'POST' || b.method === 'PUT') && b.data) opt.body = JSON.stringify(b.data);
      const r = await fetch(u, opt);
      const t = await r.text();
      try { return json(JSON.parse(t)); } catch { return json({ error: 'API返回非JSON', raw: t }, 502); }
    } catch (e) { return json({ error: '代理失败: ' + e.message }, 500); }
  }
  return json({ error: '未知接口' }, 404);
}

function HTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>DNSHE 域名管理器</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--primary:#6366f1;--primary-h:#4f46e5;--primary-l:#eef2ff;--danger:#ef4444;--danger-h:#dc2626;--success:#22c55e;--warning:#f59e0b;--info:#3b82f6;--sidebar-bg:#0f172a;--sidebar-h:#1e293b;--sidebar-a:#334155;--content-bg:#f1f5f9;--card:#fff;--text:#1e293b;--text2:#64748b;--border:#e2e8f0;--radius:12px;--shadow:0 1px 3px rgba(0,0,0,.1),0 1px 2px rgba(0,0,0,.06)}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:var(--content-bg);color:var(--text);line-height:1.6;overflow:hidden;height:100vh}
/* Login */
.login-page{position:fixed;inset:0;background:linear-gradient(135deg,#0f172a 0%,#1e1b4b 50%,#312e81 100%);display:flex;align-items:center;justify-content:center;z-index:1000}
.login-card{background:rgba(255,255,255,.05);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.1);border-radius:24px;padding:48px 40px;width:420px;max-width:90vw;text-align:center;animation:fadeUp .6s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
.login-card .logo{font-size:48px;margin-bottom:8px}
.login-card h1{color:#fff;font-size:28px;font-weight:700;margin-bottom:4px}
.login-card p{color:rgba(255,255,255,.5);font-size:14px;margin-bottom:32px}
.login-card input{width:100%;padding:14px 18px;border:1px solid rgba(255,255,255,.15);border-radius:12px;background:rgba(255,255,255,.08);color:#fff;font-size:15px;outline:none;transition:.3s;margin-bottom:16px}
.login-card input:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(99,102,241,.3)}
.login-card input::placeholder{color:rgba(255,255,255,.3)}
.login-card button{width:100%;padding:14px;border:none;border-radius:12px;background:linear-gradient(135deg,var(--primary),#8b5cf6);color:#fff;font-size:16px;font-weight:600;cursor:pointer;transition:.3s}
.login-card button:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(99,102,241,.4)}
.login-card .error{color:#fca5a5;font-size:13px;margin-top:8px;min-height:20px}
/* Main Layout */
.main-app{display:flex;height:100vh;overflow:hidden}
.sidebar{width:300px;min-width:300px;background:var(--sidebar-bg);display:flex;flex-direction:column;border-right:1px solid rgba(255,255,255,.05)}
.sidebar-header{padding:24px 20px 16px;border-bottom:1px solid rgba(255,255,255,.06)}
.sidebar-header h2{color:#fff;font-size:22px;font-weight:700;display:flex;align-items:center;gap:10px}
.sidebar-header .sub{color:rgba(255,255,255,.4);font-size:12px;margin-top:2px}
.sidebar-actions{padding:16px 16px 8px}
.btn-add{width:100%;padding:12px;border:2px dashed rgba(255,255,255,.15);border-radius:10px;background:transparent;color:rgba(255,255,255,.6);font-size:14px;cursor:pointer;transition:.3s;display:flex;align-items:center;justify-content:center;gap:8px}
.btn-add:hover{border-color:var(--primary);color:var(--primary);background:rgba(99,102,241,.08)}
.account-list{flex:1;overflow-y:auto;padding:8px 12px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.1) transparent}
.account-list::-webkit-scrollbar{width:4px}
.account-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:4px}
.account-item{padding:12px 14px;border-radius:10px;cursor:pointer;transition:.2s;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;position:relative}
.account-item:hover{background:var(--sidebar-h)}
.account-item.active{background:var(--sidebar-a);border-left:3px solid var(--primary)}
.account-item .name{color:#e2e8f0;font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.account-item .acc-actions{display:none;gap:4px}
.account-item:hover .acc-actions{display:flex}
.account-item .acc-actions button{background:none;border:none;color:rgba(255,255,255,.4);cursor:pointer;padding:4px 6px;border-radius:4px;font-size:12px;transition:.2s}
.account-item .acc-actions button:hover{color:#fff;background:rgba(255,255,255,.1)}
.account-item .acc-actions .del-btn:hover{color:var(--danger)}
.sidebar-footer{padding:12px 16px;border-top:1px solid rgba(255,255,255,.06)}
.btn-logout{width:100%;padding:10px;border:none;border-radius:8px;background:rgba(255,255,255,.05);color:rgba(255,255,255,.5);font-size:13px;cursor:pointer;transition:.2s}
.btn-logout:hover{background:rgba(239,68,68,.15);color:var(--danger)}
/* Content */
.content{flex:1;overflow-y:auto;padding:0;display:flex;flex-direction:column}
.welcome{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:40px;text-align:center}
.welcome .icon{font-size:72px;margin-bottom:20px;animation:float 3s ease-in-out infinite}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.welcome h1{font-size:28px;color:var(--text);margin-bottom:12px}
.welcome p{color:var(--text2);font-size:15px;max-width:480px}
/* Account View */
.account-view{padding:28px 32px;flex:1}
.account-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:16px}
.account-header h2{font-size:24px;font-weight:700;color:var(--text)}
.header-actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:9px 18px;border:none;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;transition:.2s;display:inline-flex;align-items:center;gap:6px}
.btn:hover{transform:translateY(-1px)}
.btn-primary{background:var(--primary);color:#fff}
.btn-primary:hover{background:var(--primary-h);box-shadow:0 4px 12px rgba(99,102,241,.3)}
.btn-success{background:var(--success);color:#fff}
.btn-success:hover{background:#16a34a}
.btn-warning{background:var(--warning);color:#fff}
.btn-warning:hover{background:#d97706}
.btn-danger{background:var(--danger);color:#fff}
.btn-danger:hover{background:var(--danger-h)}
.btn-outline{background:#fff;color:var(--text);border:1px solid var(--border)}
.btn-outline:hover{background:#f8fafc;border-color:#cbd5e1}
.btn-ghost{background:transparent;color:var(--text2)}
.btn-ghost:hover{background:rgba(0,0,0,.05)}
.btn-sm{padding:6px 12px;font-size:12px}
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none!important}
/* Stats */
.stats-bar{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}
.stat-card{background:var(--card);border-radius:var(--radius);padding:16px 20px;box-shadow:var(--shadow);flex:1;min-width:140px;border:1px solid var(--border)}
.stat-card .label{font-size:12px;color:var(--text2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.stat-card .value{font-size:24px;font-weight:700;color:var(--text)}
.stat-card .value.text-primary{color:var(--primary)}
.stat-card .value.text-success{color:var(--success)}
.stat-card .value.text-warning{color:var(--warning)}
/* Domain Cards */
.section-title{font-size:16px;font-weight:600;color:var(--text);margin-bottom:16px;display:flex;align-items:center;gap:8px}
.domain-card{background:var(--card);border-radius:var(--radius);border:1px solid var(--border);margin-bottom:12px;overflow:hidden;transition:.2s;box-shadow:var(--shadow)}
.domain-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.08)}
.domain-header{display:flex;align-items:center;padding:16px 20px;cursor:pointer;transition:.15s;gap:12px}
.domain-header:hover{background:#f8fafc}
.domain-expand{width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text2);transition:.3s;flex-shrink:0}
.domain-expand.open{transform:rotate(90deg)}
.domain-info{flex:1;min-width:0}
.domain-name{font-size:15px;font-weight:600;color:var(--text);word-break:break-all}
.domain-meta{font-size:12px;color:var(--text2);margin-top:2px;display:flex;gap:12px;flex-wrap:wrap}
.badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.3px}
.badge-active{background:#dcfce7;color:#15803d}
.badge-inactive{background:#fee2e2;color:#b91c1c}
.badge-pending{background:#fef3c7;color:#92400e}
.domain-actions{display:flex;gap:6px;flex-shrink:0}
.domain-body{border-top:1px solid var(--border);padding:0;max-height:0;overflow:hidden;transition:max-height .4s ease,padding .3s ease}
.domain-body.open{max-height:2000px;padding:20px}
/* DNS Table */
.dns-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.dns-header h4{font-size:14px;font-weight:600;color:var(--text)}
.dns-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}
.dns-table th{text-align:left;padding:10px 12px;background:#f8fafc;color:var(--text2);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)}
.dns-table th:first-child{border-radius:8px 0 0 0}
.dns-table th:last-child{border-radius:0 8px 0 0}
.dns-table td{padding:10px 12px;border-bottom:1px solid #f1f5f9;color:var(--text);vertical-align:middle}
.dns-table tr:last-child td{border-bottom:none}
.dns-table tr:hover td{background:#fafbfc}
.type-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;letter-spacing:.5px;min-width:52px;text-align:center}
.type-A{background:#dbeafe;color:#1d4ed8}
.type-AAAA{background:#e0e7ff;color:#4338ca}
.type-CNAME{background:#dcfce7;color:#15803d}
.type-MX{background:#fef3c7;color:#92400e}
.type-TXT{background:#f3f4f6;color:#4b5563}
.dns-empty{text-align:center;padding:24px;color:var(--text2);font-size:14px}
/* Modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:999;animation:fadeIn .2s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.modal{background:#fff;border-radius:16px;width:500px;max-width:92vw;max-height:90vh;overflow-y:auto;box-shadow:0 25px 60px rgba(0,0,0,.2);animation:slideUp .3s ease}
@keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.modal-header{padding:24px 24px 0;display:flex;align-items:center;justify-content:space-between}
.modal-header h3{font-size:18px;font-weight:700;color:var(--text)}
.modal-close{width:32px;height:32px;border:none;background:#f1f5f9;border-radius:8px;cursor:pointer;font-size:18px;color:var(--text2);display:flex;align-items:center;justify-content:center;transition:.2s}
.modal-close:hover{background:#e2e8f0;color:var(--text)}
.modal-body{padding:20px 24px}
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:13px;font-weight:500;color:var(--text);margin-bottom:6px}
.form-group input,.form-group select,.form-group textarea{width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:14px;color:var(--text);outline:none;transition:.2s;background:#fff}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(99,102,241,.12)}
.form-group .hint{font-size:12px;color:var(--text2);margin-top:4px}
.form-group textarea{resize:vertical;min-height:60px}
.modal-footer{padding:16px 24px 24px;display:flex;justify-content:flex-end;gap:10px}
/* Toast */
.toast-container{position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px}
.toast{padding:14px 20px;border-radius:10px;color:#fff;font-size:14px;font-weight:500;animation:slideIn .3s ease;box-shadow:0 8px 24px rgba(0,0,0,.15);display:flex;align-items:center;gap:10px;min-width:280px;max-width:420px}
@keyframes slideIn{from{opacity:0;transform:translateX(50px)}to{opacity:1;transform:translateX(0)}}
.toast-success{background:linear-gradient(135deg,#22c55e,#16a34a)}
.toast-error{background:linear-gradient(135deg,#ef4444,#dc2626)}
.toast-warning{background:linear-gradient(135deg,#f59e0b,#d97706)}
.toast-info{background:linear-gradient(135deg,#3b82f6,#2563eb)}
/* Loading */
.spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-block{display:flex;align-items:center;justify-content:center;padding:48px;color:var(--text2);gap:12px;font-size:14px}
.loading-block .sp2{border:3px solid var(--border);border-top-color:var(--primary);width:28px;height:28px;border-radius:50%;animation:spin .7s linear infinite}
/* Empty State */
.empty-state{text-align:center;padding:48px 24px;color:var(--text2)}
.empty-state .icon{font-size:48px;margin-bottom:12px;opacity:.5}
.empty-state p{font-size:14px}
/* Confirm */
.confirm-text{font-size:15px;color:var(--text);line-height:1.7;padding:8px 0}
.confirm-text strong{color:var(--danger)}
/* Result */
.result-box{background:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:16px;margin-top:12px;font-size:13px;word-break:break-all}
.result-box .row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #f1f5f9}
.result-box .row:last-child{border:none}
.result-box .rk{color:var(--text2)}
.result-box .rv{color:var(--text);font-weight:500}
/* Mobile */
.mobile-header{display:none;background:var(--sidebar-bg);padding:12px 16px;align-items:center;justify-content:space-between}
.mobile-header h2{color:#fff;font-size:18px;font-weight:600}
.hamburger{background:none;border:none;color:#fff;font-size:24px;cursor:pointer;padding:4px 8px}
@media(max-width:768px){
  .sidebar{position:fixed;left:-320px;top:0;bottom:0;z-index:100;transition:.3s;width:300px}
  .sidebar.open{left:0}
  .sidebar-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99;display:none}
  .sidebar-backdrop.show{display:block}
  .mobile-header{display:flex!important}
  .content{padding-top:0}
  .account-view{padding:20px 16px}
  .stats-bar{flex-direction:column}
  .domain-header{flex-wrap:wrap}
  .domain-actions{width:100%;justify-content:flex-end;margin-top:8px}
  .header-actions{width:100%}
  .account-header{flex-direction:column;align-items:flex-start}
}
</style>
</head>
<body>
<!-- Login -->
<div id="loginPage" class="login-page">
  <div class="login-card">
    <div class="logo">🌐</div>
    <h1>DNSHE 管理器</h1>
    <p>多账号免费域名管理平台</p>
    <input type="password" id="pwdInput" placeholder="请输入管理密码..." onkeydown="if(event.key==='Enter')doLogin()">
    <button onclick="doLogin()">🔓 登录</button>
    <div class="error" id="loginError"></div>
  </div>
</div>

<!-- Main App -->
<div id="mainApp" class="main-app" style="display:none">
  <div class="sidebar-backdrop" id="sidebarBackdrop" onclick="toggleSidebar()"></div>
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <h2>🌐 DNSHE</h2>
      <div class="sub">多账号域名管理器</div>
    </div>
    <div class="sidebar-actions">
      <button class="btn-add" onclick="showModal('addAccount')">＋ 添加账号</button>
    </div>
    <div class="account-list" id="accountList"></div>
    <div class="sidebar-footer">
      <button class="btn-logout" onclick="doLogout()">🚪 退出登录</button>
    </div>
  </aside>
  <div style="flex:1;display:flex;flex-direction:column;overflow:hidden">
    <div class="mobile-header" id="mobileHeader">
      <h2>🌐 DNSHE</h2>
      <button class="hamburger" onclick="toggleSidebar()">☰</button>
    </div>
    <main class="content" id="contentArea">
      <div class="welcome" id="welcomeView">
        <div class="icon">🌍</div>
        <h1>欢迎使用 DNSHE 管理器</h1>
        <p>从左侧选择一个账号开始管理域名，或点击「添加账号」来添加新的 DNSHE API 账号。支持多账号管理、域名续期、DNS 记录管理等功能。</p>
      </div>
      <div class="account-view" id="accountView" style="display:none"></div>
    </main>
  </div>
</div>

<!-- Modal -->
<div id="modalOverlay" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modalBox"></div>
</div>

<!-- Toast -->
<div id="toastBox" class="toast-container"></div>

<script>
let token='',accounts=[],currentAcc=null,domainData={},expandedDomains=new Set();

// === Auth ===
async function doLogin(){
  const p=document.getElementById('pwdInput').value;
  if(!p){document.getElementById('loginError').textContent='请输入密码';return}
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
    const d=await r.json();
    if(d.success){
      token=d.token;localStorage.setItem('dnshe_token',token);
      document.getElementById('loginPage').style.display='none';
      document.getElementById('mainApp').style.display='flex';
      loadAccounts();toast('登录成功','success');
    }else{document.getElementById('loginError').textContent=d.error||'密码错误'}
  }catch(e){document.getElementById('loginError').textContent='网络错误'}
}
function doLogout(){token='';localStorage.removeItem('dnshe_token');location.reload()}
function checkAuth(){
  token=localStorage.getItem('dnshe_token')||'';
  if(token){
    document.getElementById('loginPage').style.display='none';
    document.getElementById('mainApp').style.display='flex';
    loadAccounts();
  }
}

// === API ===
async function api(path,opt={}){
  opt.headers={...opt.headers,'Authorization':'Bearer '+token,'Content-Type':'application/json'};
  const r=await fetch(path,opt);
  if(r.status===401){doLogout();throw new Error('认证失效')}
  return r.json();
}
async function proxy(accId,endpoint,action,method='GET',data=null,params=null){
  return api('/api/proxy',{method:'POST',body:JSON.stringify({accountId:accId,endpoint,action,method,data,params})});
}

// === Accounts ===
async function loadAccounts(){
  try{
    const d=await api('/api/accounts');
    accounts=d.accounts||[];renderAccountList();
    if(currentAcc&&!accounts.find(a=>a.id===currentAcc.id)){currentAcc=null;showWelcome()}
  }catch(e){toast('加载账号失败','error')}
}
function renderAccountList(){
  const el=document.getElementById('accountList');
  if(!accounts.length){el.innerHTML='<div style="padding:20px;text-align:center;color:rgba(255,255,255,.3);font-size:13px">暂无账号<br>点击上方添加</div>';return}
  el.innerHTML=accounts.map(a=>\`
    <div class="account-item \${currentAcc&&currentAcc.id===a.id?'active':''}" onclick="selectAccount('\${a.id}')">
      <span class="name">📁 \${esc(a.name)}</span>
      <div class="acc-actions">
        <button onclick="event.stopPropagation();showModal('editAccount','\${a.id}')" title="编辑">✏️</button>
        <button class="del-btn" onclick="event.stopPropagation();showModal('confirmDeleteAccount','\${a.id}')" title="删除">🗑</button>
      </div>
    </div>
  \`).join('');
}
async function selectAccount(id){
  const acc=accounts.find(a=>a.id===id);
  if(!acc)return;
  currentAcc=acc;expandedDomains.clear();renderAccountList();
  document.getElementById('welcomeView').style.display='none';
  const av=document.getElementById('accountView');av.style.display='block';
  av.innerHTML='<div class="loading-block"><div class="sp2"></div> 加载中...</div>';
  closeSidebar();
  try{
    const [domRes,quotaRes]=await Promise.all([
      proxy(id,'subdomains','list'),
      proxy(id,'quota','get').catch(()=>null)
    ]);
    domainData[id]={domains:domRes.subdomains||[],quota:quotaRes?.quota||null};
    renderAccountView();
  }catch(e){av.innerHTML='<div class="empty-state"><div class="icon">❌</div><p>加载失败: '+esc(e.message)+'</p></div>';toast('加载失败','error')}
}
function renderAccountView(){
  if(!currentAcc)return;
  const data=domainData[currentAcc.id]||{domains:[],quota:null};
  const q=data.quota;
  const av=document.getElementById('accountView');
  av.innerHTML=\`
    <div class="account-header">
      <h2>📁 \${esc(currentAcc.name)}</h2>
      <div class="header-actions">
        <button class="btn btn-outline" onclick="refreshCurrent()">🔄 刷新</button>
        <button class="btn btn-success" onclick="renewAll()">📋 全部续期</button>
        <button class="btn btn-primary" onclick="showModal('addDomain')">➕ 注册域名</button>
      </div>
    </div>
    <div class="stats-bar">
      <div class="stat-card"><div class="label">域名数量</div><div class="value text-primary">\${data.domains.length}</div></div>
      \${q?\`
      <div class="stat-card"><div class="label">已用配额</div><div class="value text-warning">\${q.used}/\${q.total}</div></div>
      <div class="stat-card"><div class="label">剩余配额</div><div class="value text-success">\${q.available}</div></div>
      \`:'<div class="stat-card"><div class="label">配额</div><div class="value text-warning">-</div></div>'}
    </div>
    <div class="section-title">🌐 域名列表</div>
    <div id="domainListInner">
      \${data.domains.length?data.domains.map(d=>renderDomainCard(d)).join(''):'<div class="empty-state"><div class="icon">📭</div><p>暂无域名，点击「注册域名」来添加</p></div>'}
    </div>
  \`;
}
function renderDomainCard(d){
  const isOpen=expandedDomains.has(d.id);
  const statusCls=d.status==='active'?'badge-active':d.status==='pending'?'badge-pending':'badge-inactive';
  return \`
    <div class="domain-card" id="domain-\${d.id}">
      <div class="domain-header" onclick="toggleDomain(\${d.id})">
        <div class="domain-expand \${isOpen?'open':''}">▶</div>
        <div class="domain-info">
          <div class="domain-name">\${esc(d.full_domain||d.subdomain+'.'+d.rootdomain)}</div>
          <div class="domain-meta">
            <span class="badge \${statusCls}">\${d.status||'active'}</span>
            <span>创建: \${d.created_at||'-'}</span>
            \${d.expires_at?'<span>到期: '+d.expires_at+'</span>':''}
          </div>
        </div>
        <div class="domain-actions">
          <button class="btn btn-sm btn-success" onclick="event.stopPropagation();renewDomain(\${d.id})" title="续期">🔄 续期</button>
          <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();showModal('confirmDeleteDomain',\${d.id})" title="删除">🗑</button>
        </div>
      </div>
      <div class="domain-body \${isOpen?'open':''}" id="domain-body-\${d.id}">
        <div id="dns-content-\${d.id}">\${isOpen?'<div class="loading-block"><div class="sp2"></div> 加载DNS记录...</div>':''}</div>
      </div>
    </div>
  \`;
}
async function toggleDomain(id){
  if(expandedDomains.has(id)){
    expandedDomains.delete(id);
    const b=document.getElementById('domain-body-'+id);if(b)b.classList.remove('open');
    const e=document.querySelector('#domain-'+id+' .domain-expand');if(e)e.classList.remove('open');
  }else{
    expandedDomains.add(id);
    const b=document.getElementById('domain-body-'+id);if(b)b.classList.add('open');
    const e=document.querySelector('#domain-'+id+' .domain-expand');if(e)e.classList.add('open');
    loadDnsRecords(id);
  }
}
async function loadDnsRecords(domId){
  const el=document.getElementById('dns-content-'+domId);
  if(!el)return;
  el.innerHTML='<div class="loading-block"><div class="sp2"></div> 加载DNS记录...</div>';
  try{
    const r=await proxy(currentAcc.id,'dns_records','list','GET',null,{subdomain_id:domId});
    const recs=r.records||[];
    el.innerHTML=\`
      <div class="dns-header">
        <h4>DNS 记录 (\${recs.length})</h4>
        <button class="btn btn-sm btn-primary" onclick="showModal('addDns',\${domId})">➕ 添加记录</button>
      </div>
      \${recs.length?\`
      <table class="dns-table">
        <thead><tr><th>类型</th><th>名称</th><th>内容</th><th>TTL</th><th>操作</th></tr></thead>
        <tbody>\${recs.map(r=>\`
          <tr>
            <td><span class="type-badge type-\${r.type}">\${r.type}</span></td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">\${esc(r.name||'-')}</td>
            <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis" title="\${esc(r.content)}">\${esc(r.content)}</td>
            <td>\${r.ttl||'-'}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-sm btn-outline" onclick="showModal('editDns',{domId:\${domId},rec:\${JSON.stringify(r).replace(/"/g,'&quot;')}})">✏️</button>
              <button class="btn btn-sm btn-danger" onclick="showModal('confirmDeleteDns',{domId:\${domId},recId:\${r.id}})">🗑</button>
            </td>
          </tr>
        \`).join('')}</tbody>
      </table>\`:'<div class="dns-empty">暂无DNS记录</div>'}
    \`;
  }catch(e){el.innerHTML='<div class="dns-empty">加载失败: '+esc(e.message)+'</div>'}
}

// === Actions ===
async function refreshCurrent(){if(currentAcc)await selectAccount(currentAcc.id);toast('刷新完成','success')}
async function renewDomain(domId){
  try{
    toast('正在续期...','info');
    const r=await proxy(currentAcc.id,'subdomains','renew','POST',{subdomain_id:domId});
    if(r.success){
      toast('续期成功！新到期: '+(r.new_expires_at||'未知'),'success');
      showModal('renewResult',r);
    }else toast(r.message||r.error||'续期失败','error');
  }catch(e){toast('续期失败: '+e.message,'error')}
}
async function renewAll(){
  if(!currentAcc)return;
  const data=domainData[currentAcc.id];
  if(!data||!data.domains.length){toast('没有可续期的域名','warning');return}
  toast('开始批量续期...','info');
  let ok=0,fail=0;
  for(const d of data.domains){
    try{
      const r=await proxy(currentAcc.id,'subdomains','renew','POST',{subdomain_id:d.id});
      if(r.success)ok++;else fail++;
    }catch{fail++}
  }
  toast(\`批量续期完成: 成功 \${ok}, 失败 \${fail}\`,ok>0?'success':'error');
  refreshCurrent();
}
async function deleteDomain(domId){
  try{
    const r=await proxy(currentAcc.id,'subdomains','delete','POST',{subdomain_id:domId});
    if(r.success){toast('域名已删除','success');refreshCurrent()}
    else toast(r.message||r.error||'删除失败','error');
  }catch(e){toast('删除失败','error')}
  closeModal();
}
async function addDomain(){
  const sub=document.getElementById('m_subdomain').value.trim();
  const root=document.getElementById('m_rootdomain').value.trim();
  if(!sub||!root){toast('请填写完整','warning');return}
  try{
    const r=await proxy(currentAcc.id,'subdomains','register','POST',{subdomain:sub,rootdomain:root});
    if(r.success){toast('域名注册成功: '+(r.full_domain||''),'success');closeModal();refreshCurrent()}
    else toast(r.message||r.error||'注册失败','error');
  }catch(e){toast('注册失败','error')}
}
async function addDnsRecord(domId){
  const type=document.getElementById('m_dns_type').value;
  const name=document.getElementById('m_dns_name').value.trim();
  const content=document.getElementById('m_dns_content').value.trim();
  const ttl=parseInt(document.getElementById('m_dns_ttl').value)||600;
  const priority=document.getElementById('m_dns_priority')?parseInt(document.getElementById('m_dns_priority').value)||null:null;
  if(!content){toast('请填写记录值','warning');return}
  try{
    const data={subdomain_id:domId,type,content,ttl};
    if(name)data.name=name;
    if(priority)data.priority=priority;
    const r=await proxy(currentAcc.id,'dns_records','create','POST',data);
    if(r.success){toast('DNS记录添加成功','success');closeModal();loadDnsRecords(domId)}
    else toast(r.message||r.error||'添加失败','error');
  }catch(e){toast('添加失败','error')}
}
async function updateDnsRecord(domId,recId){
  const content=document.getElementById('m_dns_content').value.trim();
  const ttl=parseInt(document.getElementById('m_dns_ttl').value)||600;
  const priority=document.getElementById('m_dns_priority')?parseInt(document.getElementById('m_dns_priority').value)||null:null;
  if(!content){toast('请填写记录值','warning');return}
  try{
    const data={record_id:recId,content,ttl};
    if(priority)data.priority=priority;
    const r=await proxy(currentAcc.id,'dns_records','update','POST',data);
    if(r.success){toast('DNS记录更新成功','success');closeModal();loadDnsRecords(domId)}
    else toast(r.message||r.error||'更新失败','error');
  }catch(e){toast('更新失败','error')}
}
async function deleteDnsRecord(domId,recId){
  try{
    const r=await proxy(currentAcc.id,'dns_records','delete','POST',{record_id:recId});
    if(r.success){toast('DNS记录已删除','success');loadDnsRecords(domId)}
    else toast(r.message||r.error||'删除失败','error');
  }catch(e){toast('删除失败','error')}
  closeModal();
}
async function saveAccount(isEdit,id){
  const name=document.getElementById('m_acc_name').value.trim();
  const key=document.getElementById('m_acc_key').value.trim();
  const secret=document.getElementById('m_acc_secret').value.trim();
  if(!name||!key||!secret){toast('请填写所有字段','warning');return}
  try{
    if(isEdit){
      await api('/api/accounts/'+id,{method:'PUT',body:JSON.stringify({name,apiKey:key,apiSecret:secret})});
      toast('账号已更新','success');
    }else{
      await api('/api/accounts',{method:'POST',body:JSON.stringify({name,apiKey:key,apiSecret:secret})});
      toast('账号已添加','success');
    }
    closeModal();loadAccounts();
    if(isEdit&&currentAcc&&currentAcc.id===id)selectAccount(id);
  }catch(e){toast('保存失败','error')}
}
async function deleteAccount(id){
  try{
    await api('/api/accounts/'+id,{method:'DELETE'});
    toast('账号已删除','success');closeModal();
    if(currentAcc&&currentAcc.id===id){currentAcc=null;showWelcome()}
    loadAccounts();
  }catch(e){toast('删除失败','error')}
}
function showWelcome(){
  document.getElementById('welcomeView').style.display='flex';
  document.getElementById('accountView').style.display='none';
}

// === Modal ===
function showModal(type,data){
  const box=document.getElementById('modalBox');
  let html='';
  if(type==='addAccount'){
    html=\`<div class="modal-header"><h3>添加账号</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label>账号名称</label><input id="m_acc_name" placeholder="例如：我的DNSHE账号"></div>
      <div class="form-group"><label>API Key</label><input id="m_acc_key" placeholder="cfsd_xxxxxxxxxx"></div>
      <div class="form-group"><label>API Secret</label><input id="m_acc_secret" type="password" placeholder="yyyyyyyyyyyy"><div class="hint">在DNSHE控制台的 API管理 中获取</div></div>
    </div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="saveAccount(false)">添加</button></div>\`;
  }else if(type==='editAccount'){
    const acc=accounts.find(a=>a.id===data);if(!acc)return;
    html=\`<div class="modal-header"><h3>编辑账号</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label>账号名称</label><input id="m_acc_name" value="\${esc(acc.name)}"></div>
      <div class="form-group"><label>API Key</label><input id="m_acc_key" value="\${esc(acc.apiKey)}"></div>
      <div class="form-group"><label>API Secret</label><input id="m_acc_secret" type="password" value="\${esc(acc.apiSecret)}"></div>
    </div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="saveAccount(true,'\${acc.id}')">保存</button></div>\`;
  }else if(type==='confirmDeleteAccount'){
    const acc=accounts.find(a=>a.id===data);if(!acc)return;
    html=\`<div class="modal-header"><h3>确认删除</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body"><div class="confirm-text">确定要删除账号 <strong>\${esc(acc.name)}</strong> 吗？<br>此操作不会影响DNSHE上的域名，仅删除本地保存的账号信息。</div></div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-danger" onclick="deleteAccount('\${acc.id}')">确认删除</button></div>\`;
  }else if(type==='addDomain'){
    html=\`<div class="modal-header"><h3>注册新域名</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label>子域名前缀</label><input id="m_subdomain" placeholder="例如：mysite"><div class="hint">只需输入前缀部分</div></div>
      <div class="form-group"><label>根域名</label><input id="m_rootdomain" placeholder="例如：de5.net"><div class="hint">输入DNSHE提供的可用根域名</div></div>
    </div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="addDomain()">注册</button></div>\`;
  }else if(type==='confirmDeleteDomain'){
    html=\`<div class="modal-header"><h3>确认删除域名</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body"><div class="confirm-text">确定要删除此域名吗？<br><strong>此操作不可恢复！</strong></div></div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-danger" onclick="deleteDomain(\${data})">确认删除</button></div>\`;
  }else if(type==='addDns'){
    html=\`<div class="modal-header"><h3>添加DNS记录</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label>记录类型</label><select id="m_dns_type"><option value="A">A</option><option value="AAAA">AAAA</option><option value="CNAME">CNAME</option><option value="MX">MX</option><option value="TXT">TXT</option></select></div>
      <div class="form-group"><label>名称 (可选)</label><input id="m_dns_name" placeholder="留空则使用域名本身"><div class="hint">子域名前缀，如 www</div></div>
      <div class="form-group"><label>记录值</label><input id="m_dns_content" placeholder="例如：1.2.3.4"></div>
      <div class="form-group"><label>TTL</label><input id="m_dns_ttl" type="number" value="600"></div>
      <div class="form-group"><label>优先级 (MX)</label><input id="m_dns_priority" type="number" placeholder="仅MX记录需要"></div>
    </div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="addDnsRecord(\${data})">添加</button></div>\`;
  }else if(type==='editDns'){
    const {domId,rec}=typeof data==='string'?JSON.parse(data):data;
    html=\`<div class="modal-header"><h3>编辑DNS记录</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label>记录类型</label><input value="\${rec.type}" disabled style="background:#f1f5f9"></div>
      <div class="form-group"><label>记录值</label><input id="m_dns_content" value="\${esc(rec.content)}"></div>
      <div class="form-group"><label>TTL</label><input id="m_dns_ttl" type="number" value="\${rec.ttl||600}"></div>
      <div class="form-group"><label>优先级</label><input id="m_dns_priority" type="number" value="\${rec.priority||''}"></div>
    </div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="updateDnsRecord(\${domId},\${rec.id})">保存</button></div>\`;
  }else if(type==='confirmDeleteDns'){
    const {domId,recId}=typeof data==='string'?JSON.parse(data):data;
    html=\`<div class="modal-header"><h3>确认删除DNS记录</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body"><div class="confirm-text">确定要删除此DNS记录吗？</div></div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-danger" onclick="deleteDnsRecord(\${domId},\${recId})">确认删除</button></div>\`;
  }else if(type==='renewResult'){
    const r=data;
    html=\`<div class="modal-header"><h3>✅ 续期成功</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="result-box">
        \${r.subdomain?'<div class="row"><span class="rk">域名</span><span class="rv">'+esc(r.subdomain)+'</span></div>':''}
        \${r.previous_expires_at?'<div class="row"><span class="rk">原到期时间</span><span class="rv">'+r.previous_expires_at+'</span></div>':''}
        \${r.new_expires_at?'<div class="row"><span class="rk">新到期时间</span><span class="rv" style="color:var(--success)">'+r.new_expires_at+'</span></div>':''}
        \${r.remaining_days!=null?'<div class="row"><span class="rk">剩余天数</span><span class="rv">'+r.remaining_days+' 天</span></div>':''}
        \${r.charged_amount!=null?'<div class="row"><span class="rk">费用</span><span class="rv">'+r.charged_amount+' (免费)</span></div>':''}
      </div>
    </div>
    <div class="modal-footer"><button class="btn btn-primary" onclick="closeModal()">确定</button></div>\`;
  }
  box.innerHTML=html;
  document.getElementById('modalOverlay').style.display='flex';
}
function closeModal(){document.getElementById('modalOverlay').style.display='none'}

// === Toast ===
function toast(msg,type='info'){
  const c=document.getElementById('toastBox');
  const t=document.createElement('div');
  t.className='toast toast-'+type;
  const icons={success:'✅',error:'❌',warning:'⚠️',info:'ℹ️'};
  t.innerHTML=(icons[type]||'')+' '+esc(msg);
  c.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';t.style.transform='translateX(50px)';t.style.transition='.3s';setTimeout(()=>t.remove(),300)},3500);
}

// === Mobile ===
function toggleSidebar(){
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarBackdrop').classList.toggle('show');
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('show');
}

// === Utils ===
function esc(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

// === Init ===
checkAuth();
</script>
</body>
</html>`;
}
```

## 部署步骤

### 1. 创建 Worker

在 Cloudflare Dashboard → Workers & Pages → 创建 Worker

### 2. 绑定 KV

- 创建一个 KV Namespace（例如命名为 `DNSHE_DATA`）
- 在 Worker 的 Settings → Bindings 中绑定 KV：
  - Variable name: `KV`
  - KV Namespace: 选择你创建的 namespace

### 3. 设置密码

在 Worker 的 Settings → Environment Variables 中：

- Variable name: `PASSWORD`
- Value: 你的登录密码（例如 `MySecretPassword123`）

### 4. 部署

将上面的完整代码粘贴到 Worker 编辑器中，保存并部署。

## 功能特性

| 功能         | 说明                                 |
| ------------ | ------------------------------------ |
| 🔐 密码登录   | 进入页面需要验证密码，支持会话保持   |
| 👥 多账号管理 | 左侧栏账号列表，支持添加/编辑/删除   |
| 🌐 域名管理   | 查看所有子域名，注册新域名，删除域名 |
| 🔄 域名续期   | 单个续期 + 一键全部续期              |
| 📋 DNS 管理   | 展开域名查看/添加/编辑/删除 DNS 记录 |
| 📊 配额查询   | 显示已用/可用配额                    |
| 💾 KV 持久化  | 所有账号数据保存在 Cloudflare KV 中  |
| 📱 响应式设计 | 支持手机端使用（侧边栏可收起）       |
