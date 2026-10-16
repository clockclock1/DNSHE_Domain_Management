const DNSHE_API = 'https://api005.dnshe.com/index.php';
const AUTO_RENEW_KEY = 'auto_renew';
const AUTO_RENEW_LOGS_KEY = 'auto_renew_logs';
const AUTO_RENEW_LOCK_KEY = 'auto_renew_lock';

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
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAutoRenew(env, 'cron'));
  }
};

function defaultAutoRenew() {
  return {
    enabled: false,
    daysBefore: 175,
    accountIds: [],
    skipNeverExpires: true,
    statuses: ['active'],
    ignoreNotYetAvailable: true,
    maxPerRun: 80,
    delayMs: 1100,
    lastRunAt: null,
    lastResult: null
  };
}

async function getAutoRenew(env) {
  return { ...defaultAutoRenew(), ...(JSON.parse(await env.KV.get(AUTO_RENEW_KEY) || '{}')) };
}

async function saveAutoRenew(env, cfg) {
  await env.KV.put(AUTO_RENEW_KEY, JSON.stringify(cfg));
}

async function getAutoRenewLogs(env) {
  return JSON.parse(await env.KV.get(AUTO_RENEW_LOGS_KEY) || '[]');
}

async function pushAutoRenewLog(env, entry) {
  const logs = await getAutoRenewLogs(env);
  logs.unshift(entry);
  await env.KV.put(AUTO_RENEW_LOGS_KEY, JSON.stringify(logs.slice(0, 30)));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function dnsheRequest(acc, endpoint, action, method = 'GET', data = null, params = null) {
  let u = `${DNSHE_API}?m=domain_hub&endpoint=${encodeURIComponent(endpoint)}`;
  if (action) u += `&action=${encodeURIComponent(action)}`;
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== '' && v != null) u += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    });
  }
  const m = String(method || 'GET').toUpperCase();
  const opt = {
    method: m,
    headers: { 'X-API-Key': acc.apiKey, 'X-API-Secret': acc.apiSecret, 'Content-Type': 'application/json' }
  };
  if (m !== 'GET' && m !== 'HEAD' && data) opt.body = JSON.stringify(data);
  const r = await fetch(u, opt);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { success: false, error: 'API返回非JSON', raw: t }; }
}

function parseExpiresAt(s) {
  if (!s) return null;
  const raw = String(s).trim();
  let d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) d = new Date(raw.replace(/-/g, '/'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysUntil(date) {
  return (date.getTime() - Date.now()) / 86400000;
}

async function listAllSubdomains(acc) {
  const out = [];
  let page = 1;
  for (let i = 0; i < 100; i++) {
    const r = await dnsheRequest(acc, 'subdomains', 'list', 'GET', null, {
      page,
      per_page: 200,
      include_total: 0,
      sort_by: 'expires_at',
      sort_dir: 'asc',
      fields: 'id,subdomain,rootdomain,full_domain,status,expires_at,never_expires'
    });
    if (!r || r.success === false) throw new Error(r?.message || r?.error || '列出域名失败');
    const list = r.subdomains || [];
    out.push(...list);
    if (!(r.pagination && r.pagination.has_more) || !list.length) break;
    page++;
    await sleep(400);
  }
  return out;
}

function shouldRenewDomain(d, cfg) {
  if (!d || d.id == null) return { ok: false, reason: '无效域名' };
  if (cfg.skipNeverExpires && (d.never_expires === 1 || d.never_expires === true || d.never_expires === '1')) {
    return { ok: false, reason: '永不过期' };
  }
  if (Array.isArray(cfg.statuses) && cfg.statuses.length && d.status && !cfg.statuses.includes(d.status)) {
    return { ok: false, reason: '状态不匹配: ' + d.status };
  }
  if (!d.expires_at) return { ok: false, reason: '无到期时间' };
  const exp = parseExpiresAt(d.expires_at);
  if (!exp) return { ok: false, reason: '到期时间无法解析' };
  const left = daysUntil(exp);
  if (left > Number(cfg.daysBefore)) return { ok: false, reason: `距到期还有 ${Math.ceil(left)} 天` };
  return { ok: true, left };
}

async function acquireRenewLock(env) {
  const now = Date.now();
  const lock = JSON.parse(await env.KV.get(AUTO_RENEW_LOCK_KEY) || 'null');
  if (lock && lock.until > now) return false;
  await env.KV.put(AUTO_RENEW_LOCK_KEY, JSON.stringify({ until: now + 15 * 60 * 1000, at: new Date().toISOString() }));
  return true;
}

async function releaseRenewLock(env) {
  await env.KV.delete(AUTO_RENEW_LOCK_KEY);
}

async function runAutoRenew(env, trigger = 'manual') {
  if (!env.KV) return { success: false, error: 'KV未绑定' };
  const cfg = await getAutoRenew(env);
  if (trigger === 'cron' && !cfg.enabled) {
    return { success: true, skipped: true, message: '自动续期未开启' };
  }
  if (!(await acquireRenewLock(env))) {
    return { success: false, error: '已有续期任务在运行' };
  }

  const startedAt = new Date().toISOString();
  const summary = { accounts: 0, checked: 0, candidates: 0, renewed: 0, skipped: 0, failed: 0 };
  const items = [];
  const accounts = JSON.parse(await env.KV.get('accounts') || '[]');
  const selected = Array.isArray(cfg.accountIds) && cfg.accountIds.length
    ? accounts.filter(a => cfg.accountIds.includes(a.id))
    : accounts;

  let stopped = false;
  try {
    outer: for (const acc of selected) {
      summary.accounts++;
      let domains = [];
      try {
        domains = await listAllSubdomains(acc);
      } catch (e) {
        summary.failed++;
        items.push({ accountId: acc.id, accountName: acc.name, action: 'failed', message: '列出域名失败: ' + e.message });
        continue;
      }

      for (const d of domains) {
        summary.checked++;
        const full = d.full_domain || `${d.subdomain || ''}.${d.rootdomain || ''}`;
        const check = shouldRenewDomain(d, cfg);
        if (!check.ok) {
          summary.skipped++;
          continue;
        }
        if (summary.renewed + summary.failed >= Number(cfg.maxPerRun || 80)) {
          items.push({ accountId: acc.id, accountName: acc.name, domain: full, subdomainId: d.id, action: 'skipped', message: '已达本次上限，留给下次' });
          summary.skipped++;
          stopped = true;
          break outer;
        }
        summary.candidates++;
        try {
          const r = await dnsheRequest(acc, 'subdomains', 'renew', 'POST', { subdomain_id: d.id });
          if (r && r.success) {
            summary.renewed++;
            items.push({
              accountId: acc.id,
              accountName: acc.name,
              domain: full,
              subdomainId: d.id,
              action: 'renewed',
              message: r.message || '续期成功',
              previous_expires_at: r.previous_expires_at,
              new_expires_at: r.new_expires_at,
              charged_amount: r.charged_amount
            });
          } else {
            const code = r?.error_code || '';
            const msg = r?.message || r?.error || '续期失败';
            if (cfg.ignoreNotYetAvailable && code === 'renewal_not_yet_available') {
              summary.skipped++;
              items.push({ accountId: acc.id, accountName: acc.name, domain: full, subdomainId: d.id, action: 'skipped', message: msg, error_code: code });
            } else {
              summary.failed++;
              items.push({ accountId: acc.id, accountName: acc.name, domain: full, subdomainId: d.id, action: 'failed', message: msg, error_code: code });
              if (code === 'rate_limit_exceeded') {
                items.push({ action: 'stopped', message: '触发频率限制，提前结束' });
                stopped = true;
                break outer;
              }
            }
          }
        } catch (e) {
          summary.failed++;
          items.push({ accountId: acc.id, accountName: acc.name, domain: full, subdomainId: d.id, action: 'failed', message: e.message });
        }
        await sleep(Number(cfg.delayMs) || 1100);
      }
    }
  } catch (e) {
    items.push({ action: 'failed', message: e.message });
    summary.failed++;
  }

  const finishedAt = new Date().toISOString();
  const result = { success: true, trigger, startedAt, finishedAt, stopped, summary, items: items.slice(0, 300) };
  cfg.lastRunAt = finishedAt;
  cfg.lastResult = { trigger, startedAt, finishedAt, stopped, summary };
  await saveAutoRenew(env, cfg);
  await pushAutoRenewLog(env, { id: crypto.randomUUID(), ...result });
  await releaseRenewLock(env);
  return result;
}

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
  if (p === '/api/auto-renew' && req.method === 'GET') {
    const cfg = await getAutoRenew(env);
    const lock = JSON.parse(await env.KV.get(AUTO_RENEW_LOCK_KEY) || 'null');
    return json({ success: true, config: cfg, running: !!(lock && lock.until > Date.now()) });
  }
  if (p === '/api/auto-renew' && req.method === 'PUT') {
    const b = await req.json();
    const cfg = await getAutoRenew(env);
    if (typeof b.enabled === 'boolean') cfg.enabled = b.enabled;
    if (b.daysBefore != null) cfg.daysBefore = Math.max(1, Math.min(365, parseInt(b.daysBefore, 10) || 175));
    if (Array.isArray(b.accountIds)) cfg.accountIds = b.accountIds.filter(Boolean);
    if (typeof b.skipNeverExpires === 'boolean') cfg.skipNeverExpires = b.skipNeverExpires;
    if (Array.isArray(b.statuses)) cfg.statuses = b.statuses.filter(Boolean);
    if (typeof b.ignoreNotYetAvailable === 'boolean') cfg.ignoreNotYetAvailable = b.ignoreNotYetAvailable;
    if (b.maxPerRun != null) cfg.maxPerRun = Math.max(1, Math.min(300, parseInt(b.maxPerRun, 10) || 80));
    if (b.delayMs != null) cfg.delayMs = Math.max(300, Math.min(5000, parseInt(b.delayMs, 10) || 1100));
    await saveAutoRenew(env, cfg);
    return json({ success: true, config: cfg });
  }
  if (p === '/api/auto-renew/logs' && req.method === 'GET') {
    return json({ success: true, logs: await getAutoRenewLogs(env) });
  }
  if (p === '/api/auto-renew/run' && req.method === 'POST') {
    const result = await runAutoRenew(env, 'manual');
    if (result.error) return json(result, result.error.includes('运行') ? 409 : 500);
    return json(result);
  }
  if (p === '/api/proxy' && req.method === 'POST') {
    try {
      const b = await req.json();
      const accs = JSON.parse(await env.KV.get('accounts') || '[]');
      const acc = accs.find(a => a.id === b.accountId);
      if (!acc) return json({ error: '账号不存在' }, 404);
      const data = await dnsheRequest(acc, b.endpoint, b.action, b.method || 'GET', b.data, b.params);
      return json(data);
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
.account-item{padding:12px 14px;border-radius:10px;cursor:pointer;transition:.2s;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between}
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
.content{flex:1;overflow-y:auto;padding:0;display:flex;flex-direction:column}
.welcome{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:40px;text-align:center}
.welcome .icon{font-size:72px;margin-bottom:20px;animation:float 3s ease-in-out infinite}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
.welcome h1{font-size:28px;color:var(--text);margin-bottom:12px}
.welcome p{color:var(--text2);font-size:15px;max-width:520px}
.account-view{padding:28px 32px;flex:1}
.account-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:16px}
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
.stats-bar{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.stat-card{background:var(--card);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow);flex:1;min-width:120px;border:1px solid var(--border)}
.stat-card .label{font-size:12px;color:var(--text2);letter-spacing:.3px;margin-bottom:4px}
.stat-card .value{font-size:22px;font-weight:700;color:var(--text)}
.stat-card .value.text-primary{color:var(--primary)}
.stat-card .value.text-success{color:var(--success)}
.stat-card .value.text-warning{color:var(--warning)}
.tabs{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap}
.tab{padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:#fff;cursor:pointer;font-size:13px;color:var(--text2)}
.tab.active{background:var(--primary);color:#fff;border-color:var(--primary)}
.filters{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px;background:#fff;padding:14px;border-radius:var(--radius);border:1px solid var(--border)}
.filters label{display:block;font-size:11px;color:var(--text2);margin-bottom:4px}
.filters input,.filters select{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;outline:none;background:#fff;color:var(--text)}
.filters input:focus,.filters select:focus{border-color:var(--primary)}
.filter-actions{display:flex;align-items:flex-end;gap:8px}
.checkline{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);height:36px}
.section-title{font-size:16px;font-weight:600;color:var(--text);margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.domain-card{background:var(--card);border-radius:var(--radius);border:1px solid var(--border);margin-bottom:12px;overflow:hidden;transition:.2s;box-shadow:var(--shadow)}
.domain-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.08)}
.domain-header{display:flex;align-items:center;padding:16px 20px;cursor:pointer;transition:.15s;gap:12px}
.domain-header:hover{background:#f8fafc}
.domain-expand{width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text2);transition:.3s;flex-shrink:0}
.domain-expand.open{transform:rotate(90deg)}
.domain-info{flex:1;min-width:0}
.domain-name{font-size:15px;font-weight:600;color:var(--text);word-break:break-all}
.domain-meta{font-size:12px;color:var(--text2);margin-top:2px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.3px}
.badge-active{background:#dcfce7;color:#15803d}
.badge-inactive{background:#fee2e2;color:#b91c1c}
.badge-pending{background:#fef3c7;color:#92400e}
.badge-info{background:#dbeafe;color:#1d4ed8}
.domain-actions{display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
.domain-body{border-top:1px solid var(--border);padding:0;max-height:0;overflow:hidden;transition:max-height .4s ease,padding .3s ease}
.domain-body.open{max-height:4000px;padding:20px}
.dns-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:8px}
.dns-header h4{font-size:14px;font-weight:600;color:var(--text)}
.table-wrap{overflow-x:auto}
.dns-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px;min-width:720px}
.dns-table th{text-align:left;padding:10px 12px;background:#f8fafc;color:var(--text2);font-weight:500;font-size:12px;letter-spacing:.4px;border-bottom:1px solid var(--border);white-space:nowrap}
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
.type-NS{background:#fae8ff;color:#a21caf}
.type-SRV{background:#ffedd5;color:#c2410c}
.type-CAA{background:#ccfbf1;color:#0f766e}
.dns-empty{text-align:center;padding:24px;color:var(--text2);font-size:14px}
.pager{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 16px;flex-wrap:wrap;font-size:13px;color:var(--text2)}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:999;animation:fadeIn .2s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.modal{background:#fff;border-radius:16px;width:560px;max-width:92vw;max-height:90vh;overflow-y:auto;box-shadow:0 25px 60px rgba(0,0,0,.2);animation:slideUp .3s ease}
.modal.lg{width:720px}
@keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.modal-header{padding:24px 24px 0;display:flex;align-items:center;justify-content:space-between}
.modal-header h3{font-size:18px;font-weight:700;color:var(--text)}
.modal-close{width:32px;height:32px;border:none;background:#f1f5f9;border-radius:8px;cursor:pointer;font-size:18px;color:var(--text2);display:flex;align-items:center;justify-content:center;transition:.2s}
.modal-close:hover{background:#e2e8f0;color:var(--text)}
.modal-body{padding:20px 24px}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:13px;font-weight:500;color:var(--text);margin-bottom:6px}
.form-group input,.form-group select,.form-group textarea{width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:14px;color:var(--text);outline:none;transition:.2s;background:#fff}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(99,102,241,.12)}
.form-group .hint{font-size:12px;color:var(--text2);margin-top:4px}
.form-group textarea{resize:vertical;min-height:70px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.modal-footer{padding:16px 24px 24px;display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.toast-container{position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px}
.toast{padding:14px 20px;border-radius:10px;color:#fff;font-size:14px;font-weight:500;animation:slideIn .3s ease;box-shadow:0 8px 24px rgba(0,0,0,.15);display:flex;align-items:center;gap:10px;min-width:280px;max-width:460px}
@keyframes slideIn{from{opacity:0;transform:translateX(50px)}to{opacity:1;transform:translateX(0)}}
.toast-success{background:linear-gradient(135deg,#22c55e,#16a34a)}
.toast-error{background:linear-gradient(135deg,#ef4444,#dc2626)}
.toast-warning{background:linear-gradient(135deg,#f59e0b,#d97706)}
.toast-info{background:linear-gradient(135deg,#3b82f6,#2563eb)}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-block{display:flex;align-items:center;justify-content:center;padding:48px;color:var(--text2);gap:12px;font-size:14px}
.loading-block .sp2{border:3px solid var(--border);border-top-color:var(--primary);width:28px;height:28px;border-radius:50%;animation:spin .7s linear infinite}
.empty-state{text-align:center;padding:48px 24px;color:var(--text2)}
.empty-state .icon{font-size:48px;margin-bottom:12px;opacity:.5}
.empty-state p{font-size:14px}
.confirm-text{font-size:15px;color:var(--text);line-height:1.7;padding:8px 0}
.confirm-text strong{color:var(--danger)}
.result-box{background:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:16px;margin-top:12px;font-size:13px;word-break:break-all}
.result-box .row{display:flex;justify-content:space-between;gap:12px;padding:4px 0;border-bottom:1px solid #f1f5f9}
.result-box .row:last-child{border:none}
.result-box .rk{color:var(--text2);flex-shrink:0}
.result-box .rv{color:var(--text);font-weight:500;text-align:right}
.secret-box{background:#fff7ed;border:1px solid #fdba74;border-radius:10px;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all;font-size:13px;margin-top:8px}
.panel{background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:12px;box-shadow:var(--shadow)}
.switch{position:relative;display:inline-block;width:46px;height:26px}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;inset:0;background:#cbd5e1;border-radius:26px;transition:.2s}
.slider:before{position:absolute;content:"";height:20px;width:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}
.switch input:checked+.slider{background:var(--success)}
.switch input:checked+.slider:before{transform:translateX(20px)}
.acc-check{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px}
.acc-check:last-child{border:none}
.log-item{border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px;background:#fff}
.log-item .meta{font-size:12px;color:var(--text2);margin-bottom:6px;display:flex;gap:10px;flex-wrap:wrap}
.log-chip{display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
.log-chip.ok{background:#dcfce7;color:#15803d}
.log-chip.fail{background:#fee2e2;color:#b91c1c}
.log-chip.skip{background:#f1f5f9;color:#64748b}
.mobile-header{display:none;background:var(--sidebar-bg);padding:12px 16px;align-items:center;justify-content:space-between}
.mobile-header h2{color:#fff;font-size:18px;font-weight:600}
.hamburger{background:none;border:none;color:#fff;font-size:24px;cursor:pointer;padding:4px 8px}
@media(max-width:768px){
  .sidebar{position:fixed;left:-320px;top:0;bottom:0;z-index:100;transition:.3s;width:300px}
  .sidebar.open{left:0}
  .sidebar-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99;display:none}
  .sidebar-backdrop.show{display:block}
  .mobile-header{display:flex!important}
  .account-view{padding:20px 16px}
  .stats-bar{flex-direction:column}
  .domain-header{flex-wrap:wrap}
  .domain-actions{width:100%;justify-content:flex-start}
  .header-actions{width:100%}
  .account-header{flex-direction:column;align-items:flex-start}
  .form-row{grid-template-columns:1fr}
}
</style>
</head>
<body>
<div id="loginPage" class="login-page">
  <div class="login-card">
    <div class="logo">🌐</div>
    <h1>DNSHE 管理器</h1>
    <p>多账号免费域名管理平台 · API V2</p>
    <input type="password" id="pwdInput" placeholder="请输入管理密码..." onkeydown="if(event.key==='Enter')doLogin()">
    <button onclick="doLogin()">登录</button>
    <div class="error" id="loginError"></div>
  </div>
</div>

<div id="mainApp" class="main-app" style="display:none">
  <div class="sidebar-backdrop" id="sidebarBackdrop" onclick="toggleSidebar()"></div>
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <h2>🌐 DNSHE</h2>
      <div class="sub">多账号域名管理器 · V2</div>
    </div>
    <div class="sidebar-actions">
      <button class="btn-add" onclick="showModal('addAccount')">＋ 添加账号</button>
      <button class="btn-add" style="margin-top:8px" onclick="showAutoRenew()">⏱ 自动续期</button>
    </div>
    <div class="account-list" id="accountList"></div>
    <div class="sidebar-footer">
      <button class="btn-logout" onclick="doLogout()">退出登录</button>
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
        <p>从左侧选择账号。支持域名管理、DNS、API 密钥、WHOIS、永久升级，以及基于 Cloudflare Cron 的自动续期。</p>
      </div>
      <div class="account-view" id="accountView" style="display:none"></div>
      <div class="account-view" id="autoRenewView" style="display:none"></div>
    </main>
  </div>
</div>

<div id="modalOverlay" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modalBox"></div>
</div>
<div id="toastBox" class="toast-container"></div>

<script>
let token='',accounts=[],currentAcc=null,domainData={},expandedDomains=new Set();
let uiTab='domains',domainQuery={page:1,per_page:50,search:'',rootdomain:'',status:'',created_from:'',created_to:'',sort_by:'id',sort_dir:'desc',include_total:true};
let domainPage=null,dnsCache={},upgradePage=1,lastSecret=null,autoRenewCfg=null,autoRenewLogs=[],autoRenewRunning=false;

const STATUS_ZH={active:'正常',suspended:'已暂停',expired:'已过期',pending:'待处理',unregistered:'未注册'};
const DNS_TYPES=['A','AAAA','CNAME','MX','TXT','NS','SRV','CAA'];

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
    }else document.getElementById('loginError').textContent=d.error||'密码错误';
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
async function api(path,opt={}){
  opt.headers={...opt.headers,'Authorization':'Bearer '+token,'Content-Type':'application/json'};
  const r=await fetch(path,opt);
  if(r.status===401){doLogout();throw new Error('认证失效')}
  return r.json();
}
async function proxy(accId,endpoint,action,method='GET',data=null,params=null){
  const body={accountId:accId,endpoint,method};
  if(action) body.action=action;
  if(data) body.data=data;
  if(params) body.params=params;
  return api('/api/proxy',{method:'POST',body:JSON.stringify(body)});
}
function apiErr(r){
  if(!r) return '无响应';
  const parts=[];
  if(r.message) parts.push(r.message);
  else if(r.error) parts.push(r.error);
  if(r.error_code) parts.push(r.error_code);
  if(r.details&&typeof r.details==='object'){
    const extra=Object.entries(r.details).filter(([,v])=>v!=null&&typeof v!=='object').map(([k,v])=>k+'='+v);
    if(extra.length) parts.push(extra.join(', '));
  }
  return parts.join(' · ')||'操作失败';
}
function failed(r){
  if(!r||r.success===false) return true;
  if(r.success!==true&&r.error) return true;
  return false;
}
function statusBadge(s){
  const cls=s==='active'?'badge-active':s==='pending'?'badge-pending':s==='suspended'||s==='expired'?'badge-inactive':'badge-info';
  return '<span class="badge '+cls+'">'+(STATUS_ZH[s]||s||'未知')+'</span>';
}
function domainName(d){return d.full_domain||((d.subdomain||'')+'.'+(d.rootdomain||''))}
function recordLocator(rec){
  if(rec&&rec.id!=null&&rec.id!=='') return {id:rec.id};
  return {record_id:rec.record_id};
}

async function loadAccounts(){
  try{
    const d=await api('/api/accounts');
    accounts=d.accounts||[];renderAccountList();
    if(currentAcc&&!accounts.find(a=>a.id===currentAcc.id)){currentAcc=null;showWelcome()}
    else if(currentAcc) currentAcc=accounts.find(a=>a.id===currentAcc.id)||currentAcc;
  }catch(e){toast('加载账号失败','error')}
}
function renderAccountList(){
  const el=document.getElementById('accountList');
  if(!accounts.length){el.innerHTML='<div style="padding:20px;text-align:center;color:rgba(255,255,255,.3);font-size:13px">暂无账号<br>点击上方添加</div>';return}
  el.innerHTML=accounts.map(a=>\`
    <div class="account-item \${currentAcc&&currentAcc.id===a.id?'active':''}" onclick="selectAccount('\${a.id}')">
      <span class="name">\${esc(a.name)}</span>
      <div class="acc-actions">
        <button onclick="event.stopPropagation();showModal('editAccount','\${a.id}')" title="编辑">编辑</button>
        <button class="del-btn" onclick="event.stopPropagation();showModal('confirmDeleteAccount','\${a.id}')" title="删除">删除</button>
      </div>
    </div>\`).join('');
}
async function selectAccount(id){
  const acc=accounts.find(a=>a.id===id);
  if(!acc) return;
  currentAcc=acc;expandedDomains.clear();dnsCache={};uiTab='domains';domainQuery.page=1;
  renderAccountList();
  document.getElementById('welcomeView').style.display='none';
  document.getElementById('autoRenewView').style.display='none';
  document.getElementById('accountView').style.display='block';
  closeSidebar();
  renderAccountShell();
  await Promise.all([loadQuota(),loadDomains()]);
}
function showWelcome(){
  document.getElementById('welcomeView').style.display='flex';
  document.getElementById('accountView').style.display='none';
  document.getElementById('autoRenewView').style.display='none';
}
async function showAutoRenew(){
  currentAcc=null;renderAccountList();closeSidebar();
  document.getElementById('welcomeView').style.display='none';
  document.getElementById('accountView').style.display='none';
  const view=document.getElementById('autoRenewView');
  view.style.display='block';
  view.innerHTML='<div class="loading-block"><div class="sp2"></div> 加载自动续期...</div>';
  await loadAutoRenew();
}
async function loadAutoRenew(){
  try{
    const [cfgRes,logRes]=await Promise.all([
      api('/api/auto-renew'),
      api('/api/auto-renew/logs')
    ]);
    autoRenewCfg=cfgRes.config||{};
    autoRenewRunning=!!cfgRes.running;
    autoRenewLogs=logRes.logs||[];
    renderAutoRenew();
  }catch(e){
    document.getElementById('autoRenewView').innerHTML='<div class="empty-state"><p>加载失败: '+esc(e.message)+'</p></div>';
  }
}
function renderAutoRenew(){
  const view=document.getElementById('autoRenewView');
  if(!view||!autoRenewCfg) return;
  const c=autoRenewCfg;
  const last=c.lastResult;
  const selected=new Set(c.accountIds||[]);
  view.innerHTML=\`
    <div class="account-header">
      <h2>自动续期</h2>
      <div class="header-actions">
        <button class="btn btn-outline" onclick="loadAutoRenew()">刷新</button>
        <button class="btn btn-success" onclick="runAutoRenewNow()" \${autoRenewRunning?'disabled':''}>\${autoRenewRunning?'运行中...':'立即执行'}</button>
        <button class="btn btn-primary" onclick="saveAutoRenew()">保存设置</button>
      </div>
    </div>
    <div class="stats-bar">
      <div class="stat-card"><div class="label">开关</div><div class="value \${c.enabled?'text-success':'text-warning'}">\${c.enabled?'已开启':'已关闭'}</div></div>
      <div class="stat-card"><div class="label">提前天数</div><div class="value text-primary">\${c.daysBefore??175}</div></div>
      <div class="stat-card"><div class="label">上次运行</div><div class="value" style="font-size:14px">\${esc(c.lastRunAt||'-')}</div></div>
      <div class="stat-card"><div class="label">上次结果</div><div class="value" style="font-size:14px">\${last&&last.summary?('成功 '+(last.summary.renewed||0)+' / 失败 '+(last.summary.failed||0)):'-'}</div></div>
    </div>
    <div class="panel">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">
        <div><strong>启用定时自动续期</strong><div class="hint" style="font-size:12px;color:var(--text2);margin-top:4px">还需在 Cloudflare Worker 的 Triggers 里添加 Cron，例如每天 <code>0 8 * * *</code>（UTC）。</div></div>
        <label class="switch"><input type="checkbox" id="ar_enabled" \${c.enabled?'checked':''}><span class="slider"></span></label>
      </div>
      <div class="form-row">
        <div class="form-group"><label>到期前多少天开始续期</label><input id="ar_days" type="number" min="1" max="365" value="\${c.daysBefore??175}"><div class="hint">官方免费窗口约到期前 180 天，建议 170–175。</div></div>
        <div class="form-group"><label>单次最多续期条数</label><input id="ar_max" type="number" min="1" max="300" value="\${c.maxPerRun??80}"><div class="hint">避免一次跑太久；剩余域名下次 Cron 继续。</div></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>请求间隔（毫秒）</label><input id="ar_delay" type="number" min="300" max="5000" value="\${c.delayMs??1100}"><div class="hint">默认 1100，贴近 60 次/分钟限流。</div></div>
        <div class="form-group"><label>仅这些状态</label><input id="ar_status" value="\${esc((c.statuses||[]).join(','))}" placeholder="active，留空表示全部"><div class="hint">逗号分隔，例如 active 或 active,suspended</div></div>
      </div>
      <div class="form-row">
        <label class="checkline"><input type="checkbox" id="ar_skip_never" \${c.skipNeverExpires!==false?'checked':''}> 跳过永不过期域名</label>
        <label class="checkline"><input type="checkbox" id="ar_ignore_early" \${c.ignoreNotYetAvailable!==false?'checked':''}> 未到续期窗口时记为跳过（不算失败）</label>
      </div>
    </div>
    <div class="panel">
      <div class="section-title" style="margin-bottom:8px"><span>生效账号</span><span style="font-size:12px;color:var(--text2);font-weight:400">不勾选任何账号 = 全部账号</span></div>
      <div id="ar_accounts">
        \${accounts.length?accounts.map(a=>\`<label class="acc-check"><input type="checkbox" class="ar_acc" value="\${a.id}" \${selected.has(a.id)?'checked':''}> \${esc(a.name)}</label>\`).join(''):'<div class="dns-empty">请先添加账号</div>'}
      </div>
    </div>
    <div class="section-title">运行日志</div>
    <div id="ar_logs">\${renderAutoRenewLogs()}</div>\`;
}
function renderAutoRenewLogs(){
  if(!autoRenewLogs.length) return '<div class="empty-state"><p>还没有运行记录</p></div>';
  return autoRenewLogs.map(log=>{
    const s=log.summary||{};
    const detail=(log.items||[]).filter(i=>i.action==='renewed'||i.action==='failed'||i.action==='stopped').slice(0,40);
    return \`<div class="log-item">
      <div class="meta">
        <span>\${esc(log.startedAt||'-')} → \${esc(log.finishedAt||'-')}</span>
        <span>\${esc(log.trigger||'-')}</span>
        <span class="log-chip ok">成功 \${s.renewed||0}</span>
        <span class="log-chip fail">失败 \${s.failed||0}</span>
        <span class="log-chip skip">跳过 \${s.skipped||0}</span>
        <span>检查 \${s.checked||0} · 候选 \${s.candidates||0}</span>
      </div>
      \${detail.length?'<div class="result-box">'+detail.map(i=>'<div class="row"><span class="rk">'+esc((i.accountName?i.accountName+' · ':'')+(i.domain||i.action||''))+'</span><span class="rv">'+esc((i.action||'')+' · '+(i.message||'')+(i.new_expires_at?' → '+i.new_expires_at:''))+'</span></div>').join('')+'</div>':''}
    </div>\`;
  }).join('');
}
async function saveAutoRenew(){
  const accountIds=[...document.querySelectorAll('.ar_acc:checked')].map(el=>el.value);
  const statuses=(document.getElementById('ar_status').value||'').split(/[,，\\s]+/).map(s=>s.trim()).filter(Boolean);
  const body={
    enabled:document.getElementById('ar_enabled').checked,
    daysBefore:parseInt(document.getElementById('ar_days').value,10),
    maxPerRun:parseInt(document.getElementById('ar_max').value,10),
    delayMs:parseInt(document.getElementById('ar_delay').value,10),
    statuses,
    accountIds,
    skipNeverExpires:document.getElementById('ar_skip_never').checked,
    ignoreNotYetAvailable:document.getElementById('ar_ignore_early').checked
  };
  const r=await api('/api/auto-renew',{method:'PUT',body:JSON.stringify(body)});
  if(r.success===false){toast(r.error||'保存失败','error');return}
  autoRenewCfg=r.config;toast('自动续期设置已保存','success');renderAutoRenew();
}
async function runAutoRenewNow(){
  if(!confirm('立即按当前已保存的规则执行一次自动续期？未保存的改动请先点保存。')) return;
  toast('自动续期执行中，域名多时可能需要几分钟...','info');
  autoRenewRunning=true;renderAutoRenew();
  try{
    const r=await api('/api/auto-renew/run',{method:'POST',body:'{}'});
    if(r.error){toast(r.error,'error')}
    else{
      const s=r.summary||{};
      toast('完成：成功 '+(s.renewed||0)+'，失败 '+(s.failed||0)+'，跳过 '+(s.skipped||0),'success');
    }
  }catch(e){toast('执行失败: '+e.message,'error')}
  await loadAutoRenew();
}
function renderAccountShell(){
  const av=document.getElementById('accountView');
  av.innerHTML=\`
    <div class="account-header">
      <h2>\${esc(currentAcc.name)}</h2>
      <div class="header-actions" id="headerActions"></div>
    </div>
    <div class="stats-bar">
      <div class="stat-card"><div class="label">域名数量</div><div class="value text-primary" id="statCount">-</div></div>
      <div class="stat-card"><div class="label">已用 / 总额</div><div class="value text-warning" id="statUsed">-</div></div>
      <div class="stat-card"><div class="label">剩余配额</div><div class="value text-success" id="statAvail">-</div></div>
      <div class="stat-card"><div class="label">基础 + 邀请</div><div class="value" id="statBonus">-</div></div>
    </div>
    <div class="tabs">
      <button class="tab \${uiTab==='domains'?'active':''}" onclick="switchTab('domains')">域名</button>
      <button class="tab \${uiTab==='keys'?'active':''}" onclick="switchTab('keys')">API 密钥</button>
      <button class="tab \${uiTab==='whois'?'active':''}" onclick="switchTab('whois')">WHOIS</button>
      <button class="tab \${uiTab==='upgrade'?'active':''}" onclick="switchTab('upgrade')">永久升级</button>
    </div>
    <div id="tabBody"></div>\`;
  renderTab();
}
function switchTab(tab){
  uiTab=tab;
  document.querySelectorAll('.tab').forEach((el,i)=>{
    el.classList.toggle('active',['domains','keys','whois','upgrade'][i]===tab);
  });
  renderTab();
  if(tab==='domains') loadDomains();
  if(tab==='keys') loadKeys();
  if(tab==='upgrade') loadUpgrade();
}
function renderTab(){
  const body=document.getElementById('tabBody');
  const actions=document.getElementById('headerActions');
  if(!body||!actions) return;
  if(uiTab==='domains'){
    actions.innerHTML='<button class="btn btn-outline" onclick="refreshCurrent()">刷新</button><button class="btn btn-success" onclick="showModal(\\'confirmRenewAll\\')">全部续期</button><button class="btn btn-primary" onclick="showModal(\\'addDomain\\')">注册域名</button>';
    const q=domainQuery;
    body.innerHTML=\`
      <div class="filters">
        <div><label>搜索</label><input id="f_search" value="\${esc(q.search)}" placeholder="子域名或根域名" onkeydown="if(event.key==='Enter')applyFilters()"></div>
        <div><label>根域名</label><input id="f_root" value="\${esc(q.rootdomain)}" placeholder="example.com"></div>
        <div><label>状态</label><select id="f_status">
          <option value="">全部</option>
          <option value="active" \${q.status==='active'?'selected':''}>正常</option>
          <option value="suspended" \${q.status==='suspended'?'selected':''}>已暂停</option>
          <option value="expired" \${q.status==='expired'?'selected':''}>已过期</option>
        </select></div>
        <div><label>创建起</label><input id="f_from" type="date" value="\${esc(q.created_from)}"></div>
        <div><label>创建止</label><input id="f_to" type="date" value="\${esc(q.created_to)}"></div>
        <div><label>排序</label><select id="f_sort">
          \${['id','created_at','updated_at','expires_at','subdomain'].map(s=>'<option value="'+s+'" '+(q.sort_by===s?'selected':'')+'>'+s+'</option>').join('')}
        </select></div>
        <div><label>方向</label><select id="f_dir">
          <option value="desc" \${q.sort_dir==='desc'?'selected':''}>降序</option>
          <option value="asc" \${q.sort_dir==='asc'?'selected':''}>升序</option>
        </select></div>
        <div><label>每页</label><select id="f_per">
          \${[20,50,100,200,500].map(n=>'<option value="'+n+'" '+(Number(q.per_page)===n?'selected':'')+'>'+n+'</option>').join('')}
        </select></div>
        <div class="filter-actions">
          <label class="checkline"><input type="checkbox" id="f_total" \${q.include_total?'checked':''}> 返回总数</label>
          <button class="btn btn-primary btn-sm" onclick="applyFilters()">查询</button>
        </div>
      </div>
      <div id="domainPager" class="pager"></div>
      <div id="domainListInner"><div class="loading-block"><div class="sp2"></div> 加载域名...</div></div>\`;
  }else if(uiTab==='keys'){
    actions.innerHTML='<button class="btn btn-outline" onclick="loadKeys()">刷新</button><button class="btn btn-primary" onclick="showModal(\\'addKey\\')">创建密钥</button>';
    body.innerHTML='<div id="keysBody"><div class="loading-block"><div class="sp2"></div> 加载密钥...</div></div>';
  }else if(uiTab==='whois'){
    actions.innerHTML='';
    body.innerHTML=\`
      <div class="panel">
        <div class="form-group"><label>完整域名</label><input id="whoisDomain" placeholder="foo.example.com" onkeydown="if(event.key==='Enter')queryWhois()"></div>
        <div class="hint" style="font-size:12px;color:var(--text2);margin-bottom:12px">可查本站子域名或外部域名。后台强制校验时会带上当前账号的 API Key。</div>
        <button class="btn btn-primary" onclick="queryWhois()">查询 WHOIS</button>
      </div>
      <div id="whoisResult"></div>\`;
  }else if(uiTab==='upgrade'){
    actions.innerHTML='<button class="btn btn-outline" onclick="loadUpgrade()">刷新</button>';
    body.innerHTML=\`
      <div class="panel">
        <div class="form-row">
          <div class="form-group"><label>助力邀请码</label><input id="assistCode" placeholder="ABCD1234"></div>
          <div class="form-group" style="display:flex;align-items:flex-end"><button class="btn btn-primary" onclick="assistUpgrade()">为好友助力</button></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>页码</label><input id="upPage" type="number" min="1" value="\${upgradePage}"></div>
          <div class="form-group"><label>每页（最多 50）</label><input id="upPer" type="number" min="1" max="50" value="10"></div>
        </div>
        <button class="btn btn-outline btn-sm" onclick="loadUpgrade()">按分页刷新</button>
      </div>
      <div id="upgradeBody"><div class="loading-block"><div class="sp2"></div> 加载升级状态...</div></div>\`;
  }
}
function applyFilters(){
  domainQuery.search=document.getElementById('f_search').value.trim();
  domainQuery.rootdomain=document.getElementById('f_root').value.trim();
  domainQuery.status=document.getElementById('f_status').value;
  domainQuery.created_from=document.getElementById('f_from').value;
  domainQuery.created_to=document.getElementById('f_to').value;
  domainQuery.sort_by=document.getElementById('f_sort').value;
  domainQuery.sort_dir=document.getElementById('f_dir').value;
  domainQuery.per_page=parseInt(document.getElementById('f_per').value,10)||50;
  domainQuery.include_total=document.getElementById('f_total').checked;
  domainQuery.page=1;
  loadDomains();
}
function listParams(){
  const q=domainQuery;
  const p={page:q.page,per_page:q.per_page,sort_by:q.sort_by,sort_dir:q.sort_dir,include_total:q.include_total?1:0};
  if(q.search) p.search=q.search;
  if(q.rootdomain) p.rootdomain=q.rootdomain;
  if(q.status) p.status=q.status;
  if(q.created_from) p.created_from=q.created_from;
  if(q.created_to) p.created_to=q.created_to;
  return p;
}
async function loadQuota(){
  if(!currentAcc) return;
  const r=await proxy(currentAcc.id,'quota','','GET');
  const q=r&&r.quota;
  const used=document.getElementById('statUsed');
  const avail=document.getElementById('statAvail');
  const bonus=document.getElementById('statBonus');
  if(!q){
    if(used) used.textContent='-';
    if(avail) avail.textContent='-';
    if(bonus) bonus.textContent='-';
    if(failed(r)) toast('配额：'+apiErr(r),'warning');
    return;
  }
  if(used) used.textContent=(q.used??'-')+' / '+(q.total??'-');
  if(avail) avail.textContent=q.available??'-';
  if(bonus) bonus.textContent=(q.base??'-')+' + '+(q.invite_bonus??'-');
}
async function loadDomains(){
  if(!currentAcc||uiTab!=='domains') return;
  const box=document.getElementById('domainListInner');
  if(box) box.innerHTML='<div class="loading-block"><div class="sp2"></div> 加载域名...</div>';
  const r=await proxy(currentAcc.id,'subdomains','list','GET',null,listParams());
  if(failed(r)){
    if(box) box.innerHTML='<div class="empty-state"><div class="icon">!</div><p>'+esc(apiErr(r))+'</p></div>';
    return;
  }
  const domains=r.subdomains||[];
  domainData[currentAcc.id]={domains};
  domainPage=r.pagination||null;
  const countEl=document.getElementById('statCount');
  if(countEl) countEl.textContent=domainPage&&domainPage.total!=null?domainPage.total:domains.length;
  renderDomainList(domains);
}
function renderDomainList(domains){
  const box=document.getElementById('domainListInner');
  const pager=document.getElementById('domainPager');
  if(!box) return;
  const page=domainPage&&domainPage.page?domainPage.page:domainQuery.page;
  const hasMore=domainPage?!!domainPage.has_more:false;
  const total=domainPage&&domainPage.total!=null?(' / 共 '+domainPage.total):'';
  if(pager){
    pager.innerHTML=\`
      <span>第 \${page} 页 · 本页 \${domains.length} 条\${total}</span>
      <span>
        <button class="btn btn-outline btn-sm" \${page<=1?'disabled':''} onclick="changePage(\${page-1})">上一页</button>
        <button class="btn btn-outline btn-sm" \${!hasMore&&!(domainPage&&domainPage.total>page*domainQuery.per_page)?'disabled':''} onclick="changePage(\${page+1})">下一页</button>
      </span>\`;
  }
  if(!domains.length){
    box.innerHTML='<div class="empty-state"><div class="icon">空</div><p>没有匹配的域名</p></div>';
    return;
  }
  box.innerHTML=domains.map(d=>renderDomainCard(d)).join('');
  domains.forEach(d=>{ if(expandedDomains.has(d.id)) loadDnsRecords(d.id); });
}
function changePage(p){
  if(p<1) return;
  domainQuery.page=p;
  expandedDomains.clear();
  loadDomains();
}
function renderDomainCard(d){
  const isOpen=expandedDomains.has(Number(d.id))||expandedDomains.has(d.id);
  const exp=d.never_expires? '永不过期' : (d.expires_at?('到期 '+d.expires_at):'');
  return \`
    <div class="domain-card" id="domain-\${d.id}">
      <div class="domain-header" onclick="toggleDomain(\${d.id})">
        <div class="domain-expand \${isOpen?'open':''}">▶</div>
        <div class="domain-info">
          <div class="domain-name">\${esc(domainName(d))}</div>
          <div class="domain-meta">
            \${statusBadge(d.status)}
            <span>ID \${d.id}</span>
            <span>\${esc(d.subdomain||'')} · \${esc(d.rootdomain||'')}</span>
            \${d.created_at?'<span>创建 '+esc(d.created_at)+'</span>':''}
            \${exp?'<span>'+esc(exp)+'</span>':''}
          </div>
        </div>
        <div class="domain-actions">
          <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();showDomainDetail(\${d.id})">详情</button>
          <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();whoisFor(\${d.id})">WHOIS</button>
          <button class="btn btn-sm btn-warning" onclick="event.stopPropagation();createUpgrade(\${d.id})">永久升级</button>
          <button class="btn btn-sm btn-success" onclick="event.stopPropagation();renewDomain(\${d.id})">续期</button>
          <button class="btn btn-sm btn-danger" onclick="event.stopPropagation();showModal('confirmDeleteDomain',\${d.id})">删除</button>
        </div>
      </div>
      <div class="domain-body \${isOpen?'open':''}" id="domain-body-\${d.id}">
        <div id="dns-content-\${d.id}">\${isOpen?'<div class="loading-block"><div class="sp2"></div> 加载 DNS 记录...</div>':''}</div>
      </div>
    </div>\`;
}
async function toggleDomain(id){
  if(expandedDomains.has(id)){
    expandedDomains.delete(id);
    const b=document.getElementById('domain-body-'+id);if(b) b.classList.remove('open');
    const e=document.querySelector('#domain-'+id+' .domain-expand');if(e) e.classList.remove('open');
  }else{
    expandedDomains.add(id);
    const b=document.getElementById('domain-body-'+id);if(b) b.classList.add('open');
    const e=document.querySelector('#domain-'+id+' .domain-expand');if(e) e.classList.add('open');
    loadDnsRecords(id);
  }
}
async function loadDnsRecords(domId){
  const el=document.getElementById('dns-content-'+domId);
  if(!el) return;
  el.innerHTML='<div class="loading-block"><div class="sp2"></div> 加载 DNS 记录...</div>';
  const r=await proxy(currentAcc.id,'dns_records','list','GET',null,{subdomain_id:domId});
  if(failed(r)){el.innerHTML='<div class="dns-empty">'+esc(apiErr(r))+'</div>';return}
  const recs=r.records||[];
  dnsCache[domId]=recs;
  el.innerHTML=\`
    <div class="dns-header">
      <h4>DNS 记录（\${recs.length}）</h4>
      <button class="btn btn-sm btn-primary" onclick="showModal('addDns',\${domId})">添加记录</button>
    </div>
    \${recs.length?\`<div class="table-wrap"><table class="dns-table"><thead><tr>
      <th>类型</th><th>名称</th><th>内容</th><th>TTL</th><th>优先级</th><th>线路</th><th>代理</th><th>状态</th><th>操作</th>
    </tr></thead><tbody>\${recs.map(rec=>\`
      <tr>
        <td><span class="type-badge type-\${esc(rec.type)}">\${esc(rec.type)}</span></td>
        <td>\${esc(rec.name||'@')}</td>
        <td title="\${esc(rec.content)}">\${esc(rec.content||'-')}</td>
        <td>\${rec.ttl??'-'}</td>
        <td>\${rec.priority??'-'}</td>
        <td>\${esc(rec.line||'-')}</td>
        <td>\${rec.proxied?'是':'否'}</td>
        <td>\${esc(rec.status||'-')}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-outline" onclick="openEditDns(\${domId},\${rec.id!=null?rec.id:'null'},'\${escAttr(rec.record_id||'')}')">编辑</button>
          <button class="btn btn-sm btn-danger" onclick="openDeleteDns(\${domId},\${rec.id!=null?rec.id:'null'},'\${escAttr(rec.record_id||'')}')">删除</button>
        </td>
      </tr>\`).join('')}</tbody></table></div>\`:'<div class="dns-empty">暂无 DNS 记录</div>'}\`;
}
function findRecord(domId,id,recordId){
  const list=dnsCache[domId]||[];
  return list.find(r=>(id!=null&&String(r.id)===String(id))||(recordId&&r.record_id===recordId))||null;
}
function openEditDns(domId,id,recordId){
  const rec=findRecord(domId,id,recordId);
  if(!rec){toast('记录不在当前列表','warning');return}
  showDnsModal('edit',domId,rec);
}
function openDeleteDns(domId,id,recordId){
  const rec=findRecord(domId,id,recordId)||{id,record_id:recordId};
  showModal('confirmDeleteDns',{domId,rec});
}
function dnsFieldsHtml(type,rec){
  rec=rec||{};
  const content=\`<div class="form-group"><label>记录值</label><input id="m_dns_content" value="\${esc(rec.content||'')}" placeholder="IP、域名或文本"></div>\`;
  const line=\`<div class="form-group"><label>解析线路</label><input id="m_dns_line" value="\${esc(rec.line||'')}" placeholder="us.ci / cn.mt，其他服务商会忽略"></div>\`;
  const pri=\`<div class="form-group"><label>优先级</label><input id="m_dns_priority" type="number" value="\${rec.priority??''}" placeholder="\${type==='MX'?'MX 默认 10':'SRV 默认 0'}"></div>\`;
  if(type==='SRV'){
    return \`\${content}
      <div class="form-row">\${pri}<div class="form-group"><label>权重 weight</label><input id="m_dns_weight" type="number" value="\${rec.record_weight??rec.weight??''}"></div></div>
      <div class="form-row">
        <div class="form-group"><label>端口 port</label><input id="m_dns_port" type="number" min="1" max="65535" value="\${rec.record_port??rec.port??''}"></div>
        <div class="form-group"><label>目标主机 target</label><input id="m_dns_target" value="\${esc(rec.record_target||rec.target||'')}"></div>
      </div>\${line}
      <div class="hint" style="font-size:12px;color:var(--text2)">填写端口和目标后，可以不手写 content，接口会自动组装。</div>\`;
  }
  if(type==='CAA'){
    return \`\${content}
      <div class="form-row">
        <div class="form-group"><label>CAA Flag</label><input id="m_caa_flag" type="number" value="\${rec.caa_flag??0}"></div>
        <div class="form-group"><label>CAA Tag</label><input id="m_caa_tag" value="\${esc(rec.caa_tag||'issue')}" placeholder="issue"></div>
      </div>
      <div class="form-group"><label>CAA Value</label><input id="m_caa_value" value="\${esc(rec.caa_value||'')}" placeholder="letsencrypt.org"></div>
      \${line}\`;
  }
  if(type==='MX') return content+pri+line;
  if(type==='NS') return content+line+'<div class="hint" style="font-size:12px;color:var(--text2)">后台关闭 NS 管理时，写入会被拒绝。</div>';
  return content+line;
}
function showDnsModal(mode,domId,rec){
  const type=(rec&&rec.type)||'A';
  const box=document.getElementById('modalBox');
  box.className='modal lg';
  box.innerHTML=\`
    <div class="modal-header"><h3>\${mode==='edit'?'编辑 DNS 记录':'添加 DNS 记录'}</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="form-row">
        <div class="form-group"><label>类型</label><select id="m_dns_type" onchange="refreshDnsExtra()">\${DNS_TYPES.map(t=>'<option value="'+t+'" '+(t===type?'selected':'')+'>'+t+'</option>').join('')}</select></div>
        <div class="form-group"><label>TTL</label><input id="m_dns_ttl" type="number" value="\${rec&&rec.ttl?rec.ttl:600}"></div>
      </div>
      <div class="form-group"><label>名称</label><input id="m_dns_name" value="\${esc(rec&&rec.name||'')}" placeholder="@ 或留空表示当前子域名本身，也支持完整域名"><div class="hint">例如 www，或留空</div></div>
      <div id="dnsExtra">\${dnsFieldsHtml(type,rec)}</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" onclick="\${mode==='edit'?('saveDns('+domId+','+(rec.id!=null?rec.id:'null')+',\\''+escAttr(rec.record_id||'')+'\\')'):('saveDns('+domId+')')}">\${mode==='edit'?'保存':'添加'}</button>
    </div>\`;
  document.getElementById('modalOverlay').style.display='flex';
}
function refreshDnsExtra(){
  const type=document.getElementById('m_dns_type').value;
  const prev=readDnsForm();
  document.getElementById('dnsExtra').innerHTML=dnsFieldsHtml(type,prev);
}
function readDnsForm(){
  const g=id=>document.getElementById(id);
  const data={};
  if(g('m_dns_type')) data.type=g('m_dns_type').value;
  if(g('m_dns_name')) data.name=g('m_dns_name').value.trim();
  if(g('m_dns_content')) data.content=g('m_dns_content').value.trim();
  if(g('m_dns_ttl')&&g('m_dns_ttl').value!=='') data.ttl=parseInt(g('m_dns_ttl').value,10);
  if(g('m_dns_priority')&&g('m_dns_priority').value!=='') data.priority=parseInt(g('m_dns_priority').value,10);
  if(g('m_dns_line')&&g('m_dns_line').value.trim()) data.line=g('m_dns_line').value.trim();
  if(g('m_dns_weight')&&g('m_dns_weight').value!=='') data.record_weight=parseInt(g('m_dns_weight').value,10);
  if(g('m_dns_port')&&g('m_dns_port').value!=='') data.record_port=parseInt(g('m_dns_port').value,10);
  if(g('m_dns_target')&&g('m_dns_target').value.trim()) data.record_target=g('m_dns_target').value.trim();
  if(g('m_caa_flag')&&g('m_caa_flag').value!=='') data.caa_flag=parseInt(g('m_caa_flag').value,10);
  if(g('m_caa_tag')&&g('m_caa_tag').value.trim()) data.caa_tag=g('m_caa_tag').value.trim();
  if(g('m_caa_value')&&g('m_caa_value').value.trim()) data.caa_value=g('m_caa_value').value.trim();
  return data;
}
function validateDns(data){
  const t=data.type;
  if(t==='SRV'){
    if(!data.content&&!(data.record_port&&data.record_target)) return 'SRV 需要记录值，或同时填写端口和目标主机';
    return '';
  }
  if(t==='CAA'){
    if(!data.content&&!data.caa_value) return 'CAA 需要记录值或 CAA Value';
    return '';
  }
  if(!data.content) return '请填写记录值';
  return '';
}
async function saveDns(domId,id,recordId){
  const data=readDnsForm();
  const err=validateDns(data);
  if(err){toast(err,'warning');return}
  const editing=arguments.length>1;
  if(!editing) data.subdomain_id=domId;
  else Object.assign(data, id!=null?{id}:{record_id:recordId});
  const r=await proxy(currentAcc.id,'dns_records',editing?'update':'create','POST',data);
  if(!failed(r)){toast(r.message||(editing?'DNS 记录已更新':'DNS 记录已添加'),'success');closeModal();loadDnsRecords(domId)}
  else toast(apiErr(r),'error');
}
async function deleteDnsRecord(domId,id,recordId){
  const payload=id!=null&&id!=='null'?{id:Number(id)}:{record_id:recordId};
  const r=await proxy(currentAcc.id,'dns_records','delete','POST',payload);
  if(!failed(r)){toast(r.message||'DNS 记录已删除','success');loadDnsRecords(domId)}
  else toast(apiErr(r),'error');
  closeModal();
}
async function showDomainDetail(id){
  toast('正在获取详情...','info');
  const r=await proxy(currentAcc.id,'subdomains','get','GET',null,{subdomain_id:id});
  if(failed(r)||!r.subdomain){toast(apiErr(r),'error');return}
  const s=r.subdomain;
  const recs=r.dns_records||[];
  const rows=[
    ['ID',s.id],['子域名',s.subdomain],['根域名',s.rootdomain],['完整域名',s.full_domain],
    ['状态',STATUS_ZH[s.status]||s.status],['创建',s.created_at],['更新',s.updated_at],
    ['到期',s.never_expires?'永不过期':s.expires_at],['Zone',s.cloudflare_zone_id],['服务商账号',s.provider_account_id],
    ['DNS 条数',r.dns_count!=null?r.dns_count:recs.length]
  ].filter(([,v])=>v!=null&&v!=='');
  openModal(\`
    <div class="modal-header"><h3>域名详情</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="result-box">\${rows.map(([k,v])=>'<div class="row"><span class="rk">'+esc(k)+'</span><span class="rv">'+esc(v)+'</span></div>').join('')}</div>
      <div class="section-title" style="margin-top:16px">解析记录</div>
      \${recs.length?recs.map(rec=>'<div class="result-box"><div class="row"><span class="rk">'+esc(rec.type)+'</span><span class="rv">'+esc(rec.name||'')+' → '+esc(rec.content||'')+'</span></div></div>').join(''):'<div class="dns-empty">暂无记录</div>'}
    </div>
    <div class="modal-footer"><button class="btn btn-primary" onclick="closeModal()">关闭</button></div>\`);
}
async function renewDomain(domId){
  toast('正在续期...','info');
  const r=await proxy(currentAcc.id,'subdomains','renew','POST',{subdomain_id:domId});
  if(!failed(r)){toast(r.message||'续期成功','success');showRenewResult(r);loadDomains()}
  else toast(apiErr(r),'error');
}
function showRenewResult(r){
  const charge=r.charged_amount;
  const chargeText=charge==null?'':(Number(charge)===0?'0（未扣费）':String(charge));
  openModal(\`
    <div class="modal-header"><h3>续期结果</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body"><div class="result-box">
      \${r.message?'<div class="row"><span class="rk">结果</span><span class="rv">'+esc(r.message)+'</span></div>':''}
      \${r.subdomain?'<div class="row"><span class="rk">域名</span><span class="rv">'+esc(r.subdomain)+'</span></div>':''}
      \${r.previous_expires_at?'<div class="row"><span class="rk">原到期</span><span class="rv">'+esc(r.previous_expires_at)+'</span></div>':''}
      \${r.new_expires_at?'<div class="row"><span class="rk">新到期</span><span class="rv">'+esc(r.new_expires_at)+'</span></div>':''}
      \${r.renewed_at?'<div class="row"><span class="rk">续期时间</span><span class="rv">'+esc(r.renewed_at)+'</span></div>':''}
      \${r.remaining_days!=null?'<div class="row"><span class="rk">剩余天数</span><span class="rv">'+esc(r.remaining_days)+'</span></div>':''}
      \${r.status?'<div class="row"><span class="rk">状态</span><span class="rv">'+esc(STATUS_ZH[r.status]||r.status)+'</span></div>':''}
      \${chargeText?'<div class="row"><span class="rk">扣费</span><span class="rv">'+esc(chargeText)+'</span></div>':''}
    </div></div>
    <div class="modal-footer"><button class="btn btn-primary" onclick="closeModal()">确定</button></div>\`);
}
async function renewAll(){
  closeModal();
  toast('正在按当前筛选条件拉取全部域名...','info');
  const q=Object.assign({},domainQuery,{page:1,per_page:200});
  const domains=[];
  for(let i=0;i<100;i++){
    const p={page:q.page,per_page:q.per_page,sort_by:q.sort_by,sort_dir:q.sort_dir,include_total:0};
    if(q.search) p.search=q.search;
    if(q.rootdomain) p.rootdomain=q.rootdomain;
    if(q.status) p.status=q.status;
    if(q.created_from) p.created_from=q.created_from;
    if(q.created_to) p.created_to=q.created_to;
    const r=await proxy(currentAcc.id,'subdomains','list','GET',null,p);
    if(failed(r)){toast(apiErr(r),'error');return}
    const list=r.subdomains||[];
    domains.push(...list);
    if(!(r.pagination&&r.pagination.has_more)||!list.length) break;
    q.page++;
    await new Promise(res=>setTimeout(res,400));
  }
  if(!domains.length){toast('没有可续期的域名','warning');return}
  toast('开始续期 '+domains.length+' 个域名，约 1 秒一条','info');
  let okN=0,failN=0,lastErr='',stopped=false;
  for(const d of domains){
    const r=await proxy(currentAcc.id,'subdomains','renew','POST',{subdomain_id:d.id});
    if(!failed(r)) okN++;
    else {
      failN++; lastErr=apiErr(r);
      if(r&&r.error_code==='rate_limit_exceeded'){stopped=true;break}
    }
    await new Promise(res=>setTimeout(res,1100));
  }
  toast((stopped?'已触发频率限制并停止。':'续期完成：')+'成功 '+okN+'，失败 '+failN+(lastErr?'，最后错误：'+lastErr:''),(failN||stopped)?'warning':'success');
  loadDomains();loadQuota();
}
async function deleteDomain(domId){
  const r=await proxy(currentAcc.id,'subdomains','delete','POST',{subdomain_id:domId});
  if(!failed(r)){
    toast((r.message||'域名已删除')+(r.dns_records_deleted!=null?('，DNS '+r.dns_records_deleted+' 条'):''),'success');
    loadDomains();loadQuota();
  }else toast(apiErr(r),'error');
  closeModal();
}
async function addDomain(){
  const sub=document.getElementById('m_subdomain').value.trim();
  const root=document.getElementById('m_rootdomain').value.trim();
  if(!sub||!root){toast('请填写子域名和根域名','warning');return}
  const r=await proxy(currentAcc.id,'subdomains','register','POST',{subdomain:sub,rootdomain:root});
  if(!failed(r)){toast((r.message||'注册成功')+(r.full_domain?'：'+r.full_domain:''),'success');closeModal();loadDomains();loadQuota()}
  else toast(apiErr(r),'error');
}

async function loadKeys(){
  const box=document.getElementById('keysBody');
  if(!box) return;
  box.innerHTML='<div class="loading-block"><div class="sp2"></div> 加载密钥...</div>';
  const r=await proxy(currentAcc.id,'keys','list','GET');
  if(failed(r)){box.innerHTML='<div class="empty-state"><p>'+esc(apiErr(r))+'</p></div>';return}
  const keys=r.keys||[];
  if(!keys.length){box.innerHTML='<div class="empty-state"><p>还没有 API 密钥</p></div>';return}
  box.innerHTML='<div class="table-wrap"><table class="dns-table"><thead><tr><th>名称</th><th>Key</th><th>状态</th><th>请求数</th><th>最后使用</th><th>白名单</th><th>操作</th></tr></thead><tbody>'+
    keys.map(k=>'<tr><td>'+esc(k.key_name||'-')+'</td><td>'+esc(k.api_key||'-')+'</td><td>'+statusBadge(k.status)+'</td><td>'+(k.request_count??'-')+'</td><td>'+esc(k.last_used_at||'-')+'</td><td>'+esc(k.ip_whitelist||'-')+'</td><td style="white-space:nowrap"><button class="btn btn-sm btn-warning" onclick="regenKey('+k.id+')">重置密钥</button> <button class="btn btn-sm btn-danger" onclick="showModal(\\'confirmDeleteKey\\','+k.id+')">删除</button></td></tr>').join('')+
    '</tbody></table></div>';
}
async function addKey(){
  const name=document.getElementById('m_key_name').value.trim();
  const ip=document.getElementById('m_key_ip').value.trim();
  if(!name){toast('请填写密钥名称','warning');return}
  const data={key_name:name};
  if(ip) data.ip_whitelist=ip;
  const r=await proxy(currentAcc.id,'keys','create','POST',data);
  if(failed(r)){toast(apiErr(r),'error');return}
  closeModal();
  showSecretModal(r,'新 API 密钥');
  loadKeys();
}
async function deleteKey(id){
  const r=await proxy(currentAcc.id,'keys','delete','POST',{key_id:id});
  if(!failed(r)){toast(r.message||'密钥已删除','success');loadKeys()}
  else toast(apiErr(r),'error');
  closeModal();
}
async function regenKey(id){
  if(!confirm('重置后旧 Secret 立即失效。确定继续？')) return;
  const r=await proxy(currentAcc.id,'keys','regenerate','POST',{key_id:id});
  if(failed(r)){toast(apiErr(r),'error');return}
  showSecretModal(r,'密钥已重置');
  loadKeys();
}
function showSecretModal(r,title){
  lastSecret={api_key:r.api_key||'',api_secret:r.api_secret||'',key_name:r.key_name||title};
  const same=currentAcc&&r.api_key&&r.api_key===currentAcc.apiKey;
  openModal(\`
    <div class="modal-header"><h3>\${esc(title)}</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="confirm-text">\${esc(r.warning||'api_secret 只显示一次，请立即保存。')}</div>
      <div class="form-group"><label>API Key</label><div class="secret-box" id="secKey">\${esc(r.api_key||'')}</div></div>
      <div class="form-group"><label>API Secret</label><div class="secret-box" id="secSecret">\${esc(r.api_secret||'')}</div></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="copyText(document.getElementById('secKey').textContent+'\\n'+document.getElementById('secSecret').textContent)">复制</button>
      \${same?'<button class="btn btn-warning" onclick="updateCurrentSecret()">写回当前账号</button>':''}
      <button class="btn btn-primary" onclick="saveSecretAsAccount()">保存为本地账号</button>
    </div>\`);
}
async function updateCurrentSecret(){
  if(!lastSecret||!currentAcc) return;
  await api('/api/accounts/'+currentAcc.id,{method:'PUT',body:JSON.stringify({apiSecret:lastSecret.api_secret})});
  toast('当前账号 Secret 已更新','success');
  await loadAccounts();
  closeModal();
}
async function saveSecretAsAccount(){
  if(!lastSecret) return;
  const name=prompt('本地账号名称', lastSecret.key_name||'新密钥');
  if(!name) return;
  await api('/api/accounts',{method:'POST',body:JSON.stringify({name,apiKey:lastSecret.api_key,apiSecret:lastSecret.api_secret})});
  toast('已保存为本地账号','success');
  loadAccounts();
  closeModal();
}

async function queryWhois(){
  const domain=(document.getElementById('whoisDomain').value||'').trim();
  if(!domain){toast('请输入完整域名','warning');return}
  const box=document.getElementById('whoisResult');
  box.innerHTML='<div class="loading-block"><div class="sp2"></div> 查询中...</div>';
  const r=await proxy(currentAcc.id,'whois','','GET',null,{domain});
  if(!r||r.success===false){box.innerHTML='<div class="empty-state"><p>'+esc(apiErr(r))+'</p></div>';return}
  const ns=r.nameservers||r.name_servers||[];
  const rl=r.rate_limit||{};
  const rows=[
    ['域名',r.domain],['是否注册',r.registered===false?'否':(r.status==='unregistered'?'否':'是')],
    ['状态',STATUS_ZH[r.status]||r.status],['说明',r.message],
    ['注册时间',r.registered_at],['到期时间',r.expires_at],['注册邮箱',r.registrant_email],
    ['NS',Array.isArray(ns)?ns.join(', '):ns],
    ['频率限制',rl.limit!=null?(rl.remaining+' / '+rl.limit+'，重置 '+ (rl.reset_at||'-')):'']
  ].filter(([,v])=>v!=null&&v!=='');
  box.innerHTML='<div class="result-box">'+rows.map(([k,v])=>'<div class="row"><span class="rk">'+esc(k)+'</span><span class="rv">'+esc(v)+'</span></div>').join('')+'</div>';
}
function whoisFor(id){
  const d=(domainData[currentAcc.id].domains||[]).find(x=>String(x.id)===String(id));
  switchTab('whois');
  setTimeout(()=>{
    const input=document.getElementById('whoisDomain');
    if(input&&d) input.value=domainName(d);
    queryWhois();
  },0);
}

async function loadUpgrade(){
  const box=document.getElementById('upgradeBody');
  if(!box) return;
  const pageEl=document.getElementById('upPage');
  const perEl=document.getElementById('upPer');
  const page=pageEl?Math.max(1,parseInt(pageEl.value,10)||1):upgradePage;
  const per=perEl?Math.min(50,Math.max(1,parseInt(perEl.value,10)||10)):10;
  upgradePage=page;
  box.innerHTML='<div class="loading-block"><div class="sp2"></div> 加载升级状态...</div>';
  const r=await proxy(currentAcc.id,'permanent_upgrade','list','GET',null,{page,per_page:per});
  if(failed(r)){box.innerHTML='<div class="empty-state"><p>'+esc(apiErr(r))+'</p></div>';return}
  const state=r.state||{};
  const requests=state.requests||[];
  const logs=state.assist_logs||[];
  const eligible=state.eligible_subdomains||[];
  box.innerHTML=\`
    <div class="section-title">可升级域名（\${eligible.length}）</div>
    \${eligible.length?eligible.map(item=>upgradeItem(item,'eligible')).join(''):'<div class="panel">当前没有可申请永久升级的域名</div>'}
    <div class="section-title">升级任务（\${requests.length}）</div>
    \${requests.length?requests.map(item=>upgradeItem(item,'request')).join(''):'<div class="panel">暂无升级任务</div>'}
    <div class="section-title">助力记录（\${logs.length}）</div>
    \${logs.length?logs.map(item=>upgradeItem(item,'log')).join(''):'<div class="panel">暂无助力记录</div>'}\`;
}
function upgradeItem(item,kind){
  if(item==null) return '';
  if(typeof item!=='object') return '<div class="panel">'+esc(item)+'</div>';
  const id=item.subdomain_id||item.id;
  const reqId=item.request_id||item.id;
  const title=item.full_domain||item.domain||((item.subdomain&&item.rootdomain)?(item.subdomain+'.'+item.rootdomain):'')||item.subdomain||item.assist_code||item.key_name||('#'+(reqId||id||''));
  const rows=Object.entries(item).filter(([,v])=>v!=null&&typeof v!=='object').map(([k,v])=>'<div class="row"><span class="rk">'+esc(k)+'</span><span class="rv">'+esc(v)+'</span></div>').join('');
  let actions='';
  if(kind==='eligible'&&id!=null) actions='<button class="btn btn-sm btn-warning" onclick="createUpgrade('+id+')">申请永久升级</button>';
  if(kind==='request'&&reqId!=null) actions='<button class="btn btn-sm btn-danger" onclick="cancelUpgrade('+reqId+')">取消任务</button>';
  return '<div class="panel"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px"><strong>'+esc(title)+'</strong>'+actions+'</div><div class="result-box">'+rows+'</div></div>';
}
async function createUpgrade(subdomainId){
  const r=await proxy(currentAcc.id,'permanent_upgrade','create','POST',{subdomain_id:subdomainId});
  if(!failed(r)){toast(r.message||'已创建永久升级任务','success'); if(uiTab==='upgrade') loadUpgrade()}
  else toast(apiErr(r),'error');
}
async function assistUpgrade(){
  const code=(document.getElementById('assistCode').value||'').trim();
  if(!code){toast('请输入邀请码','warning');return}
  const r=await proxy(currentAcc.id,'permanent_upgrade','assist','POST',{assist_code:code});
  if(!failed(r)){toast(r.message||'助力成功','success');loadUpgrade()}
  else toast(apiErr(r),'error');
}
async function cancelUpgrade(requestId){
  if(!confirm('确定取消这个永久升级任务？')) return;
  const r=await proxy(currentAcc.id,'permanent_upgrade','cancel','POST',{request_id:requestId});
  if(!failed(r)){toast(r.message||'任务已取消','success');loadUpgrade()}
  else toast(apiErr(r),'error');
}

async function refreshCurrent(){
  if(!currentAcc) return;
  await loadQuota();
  if(uiTab==='domains') await loadDomains();
  else if(uiTab==='keys') await loadKeys();
  else if(uiTab==='upgrade') await loadUpgrade();
  toast('已刷新','success');
}
async function saveAccount(isEdit,id){
  const name=document.getElementById('m_acc_name').value.trim();
  const key=document.getElementById('m_acc_key').value.trim();
  const secret=document.getElementById('m_acc_secret').value.trim();
  if(!name||!key||!secret){toast('请填写所有字段','warning');return}
  if(isEdit){
    await api('/api/accounts/'+id,{method:'PUT',body:JSON.stringify({name,apiKey:key,apiSecret:secret})});
    toast('账号已更新','success');
  }else{
    await api('/api/accounts',{method:'POST',body:JSON.stringify({name,apiKey:key,apiSecret:secret})});
    toast('账号已添加','success');
  }
  closeModal();
  await loadAccounts();
  if(isEdit&&currentAcc&&currentAcc.id===id) selectAccount(id);
}
async function deleteAccount(id){
  await api('/api/accounts/'+id,{method:'DELETE'});
  toast('账号已删除','success');
  closeModal();
  if(currentAcc&&currentAcc.id===id){currentAcc=null;showWelcome()}
  loadAccounts();
}

function openModal(html,large){
  const box=document.getElementById('modalBox');
  box.className=large?'modal lg':'modal';
  box.innerHTML=html;
  document.getElementById('modalOverlay').style.display='flex';
}
function showModal(type,data){
  if(type==='addDns'){showDnsModal('add',data,null);return}
  let html='';
  if(type==='addAccount'){
    html=\`<div class="modal-header"><h3>添加账号</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label>账号名称</label><input id="m_acc_name" placeholder="例如：我的 DNSHE"></div>
      <div class="form-group"><label>API Key</label><input id="m_acc_key" placeholder="cfsd_xxxxxxxxxx"></div>
      <div class="form-group"><label>API Secret</label><input id="m_acc_secret" type="password" placeholder="只在创建或重置时出现一次"><div class="hint">在免费域名管理页的 API 管理里创建。请求只走 X-API-Key / X-API-Secret 头。</div></div>
    </div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="saveAccount(false)">添加</button></div>\`;
  }else if(type==='editAccount'){
    const acc=accounts.find(a=>a.id===data);if(!acc) return;
    html=\`<div class="modal-header"><h3>编辑账号</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label>账号名称</label><input id="m_acc_name" value="\${esc(acc.name)}"></div>
      <div class="form-group"><label>API Key</label><input id="m_acc_key" value="\${esc(acc.apiKey)}"></div>
      <div class="form-group"><label>API Secret</label><input id="m_acc_secret" type="password" value="\${esc(acc.apiSecret)}"></div>
    </div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="saveAccount(true,'\${acc.id}')">保存</button></div>\`;
  }else if(type==='confirmDeleteAccount'){
    const acc=accounts.find(a=>a.id===data);if(!acc) return;
    html=\`<div class="modal-header"><h3>删除本地账号</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body"><div class="confirm-text">删除 <strong>\${esc(acc.name)}</strong> 只清除本管理器保存的密钥，不会删除 DNSHE 上的域名。</div></div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-danger" onclick="deleteAccount('\${acc.id}')">确认删除</button></div>\`;
  }else if(type==='addDomain'){
    html=\`<div class="modal-header"><h3>注册子域名</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label>子域名前缀</label><input id="m_subdomain" placeholder="myapp"></div>
      <div class="form-group"><label>根域名</label><input id="m_rootdomain" placeholder="example.com"></div>
    </div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="addDomain()">注册</button></div>\`;
  }else if(type==='confirmDeleteDomain'){
    html=\`<div class="modal-header"><h3>删除域名</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body"><div class="confirm-text">将删除该子域名及其全部 DNS 记录，且不可恢复。</div></div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-danger" onclick="deleteDomain(\${data})">确认删除</button></div>\`;
  }else if(type==='confirmDeleteDns'){
    const rec=data.rec||{};
    html=\`<div class="modal-header"><h3>删除 DNS 记录</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body"><div class="confirm-text">删除 \${esc(rec.type||'')} \${esc(rec.name||'')} \${esc(rec.content||'')}？</div></div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-danger" onclick="deleteDnsRecord(\${data.domId},\${rec.id!=null?rec.id:'null'},'\${escAttr(rec.record_id||'')}')">确认删除</button></div>\`;
  }else if(type==='confirmRenewAll'){
    html=\`<div class="modal-header"><h3>续期筛选结果</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body"><div class="confirm-text">将按当前搜索和筛选条件，逐页取出并续期全部匹配域名。赎回期续期可能扣账户余额，未到免费续期窗口会失败。域名较多时大约每秒处理一条。</div></div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-success" onclick="renewAll()">开始续期</button></div>\`;
  }else if(type==='addKey'){
    html=\`<div class="modal-header"><h3>创建 API 密钥</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div class="form-group"><label>名称</label><input id="m_key_name" placeholder="生产环境"></div>
      <div class="form-group"><label>IP 白名单</label><textarea id="m_key_ip" placeholder="192.168.1.1,10.0.0.0/24"></textarea><div class="hint">逗号、换行或分号分隔，支持单 IP 和 CIDR。后台需开启「API IP 白名单」才会生效。</div></div>
    </div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-primary" onclick="addKey()">创建</button></div>\`;
  }else if(type==='confirmDeleteKey'){
    html=\`<div class="modal-header"><h3>删除 API 密钥</h3><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body"><div class="confirm-text">删除后该 Key 不能再调用接口。如果删的是当前正在用的 Key，这个账号会立刻无法请求。</div></div>
    <div class="modal-footer"><button class="btn btn-outline" onclick="closeModal()">取消</button><button class="btn btn-danger" onclick="deleteKey(\${data})">确认删除</button></div>\`;
  }
  if(html) openModal(html);
}
function closeModal(){document.getElementById('modalOverlay').style.display='none'}
function toast(msg,type='info'){
  const c=document.getElementById('toastBox');
  const t=document.createElement('div');
  t.className='toast toast-'+type;
  t.textContent=msg;
  c.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';t.style.transition='.3s';setTimeout(()=>t.remove(),300)},4200);
}
function copyText(text){
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(()=>toast('已复制','success')).catch(()=>fallbackCopy(text));
  }else fallbackCopy(text);
}
function fallbackCopy(text){
  const ta=document.createElement('textarea');
  ta.value=text;document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');toast('已复制','success')}catch(e){toast('复制失败','error')}
  ta.remove();
}
function toggleSidebar(){
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarBackdrop').classList.toggle('show');
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('show');
}
function esc(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function escAttr(s){return esc(s).replace(/\\\\/g,'\\\\\\\\')}
checkAuth();
</script>
</body>
</html>`;
}
