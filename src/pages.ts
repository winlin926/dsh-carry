import type { PublicNodeKind } from './public-node.js'

/**
 * The pages the gateway serves itself before the Host app is reachable. They
 * borrow the Host's own design tokens (DSH 0.2.2): the same surface, ink,
 * muted ink, hairline, radii and type scale a phone meets one step later, so a
 * pairing prompt never looks like a different product. Only the primary action
 * uses the one accent colour this plugin ships with.
 */
const tokens = (dark: boolean): string => dark
  ? '--rc-bg:#151517;--rc-ink:#F9FAFB;--rc-muted:#ADB2B8;--rc-faint:#ADB2B8;--rc-line:rgba(255,255,255,.16);--rc-fill:#353638'
  : '--rc-bg:#FFFFFF;--rc-ink:#0F1115;--rc-muted:#61666B;--rc-faint:#818588;--rc-line:rgba(0,0,0,.12);--rc-fill:#F5F6F7'
const css = `:root{color-scheme:light dark;--rc-accent:#D97757;--rc-accent-hover:#C86748;--rc-accent-ink:#FFFFFF;${tokens(false)};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif;background:var(--rc-bg);color:var(--rc-ink);-webkit-text-size-adjust:100%}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;padding-bottom:max(24px,env(safe-area-inset-bottom));padding-left:max(24px,env(safe-area-inset-left));padding-right:max(24px,env(safe-area-inset-right))}.card{background:var(--rc-bg);border:1px solid var(--rc-line);border-radius:12px;padding:24px;max-width:440px;width:100%}.eyebrow{color:var(--rc-faint);font-size:13px}h1{font-size:26px;font-weight:500;line-height:1.25;margin:12px 0 8px}p{font-size:14px;line-height:1.7;color:var(--rc-muted);margin:0 0 16px}a{color:var(--rc-accent);font-size:14px}button{background:var(--rc-accent);border:0;color:var(--rc-accent-ink);border-radius:12px;padding:0 20px;min-height:44px;font:inherit;font-size:15px;font-weight:500;width:100%;cursor:pointer}button:hover{background:var(--rc-accent-hover)}button:disabled{background:var(--rc-fill);color:var(--rc-faint);cursor:default}label{display:block;font-size:13px;color:var(--rc-muted);margin-bottom:8px}input{width:100%;height:48px;margin:0 0 16px;border:1px solid var(--rc-line);border-radius:8px;background:var(--rc-fill);color:var(--rc-ink);text-align:center;font:500 24px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.24em}input:focus-visible,button:focus-visible{outline:2px solid var(--rc-accent);outline-offset:2px}.status{display:flex;align-items:center;gap:8px;margin:20px 0 0;color:var(--rc-ink);font-size:14px;line-height:1.6}.dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--rc-accent)}small{display:block;margin-top:12px;color:var(--rc-faint);font-size:13px;line-height:1.7;word-break:break-word}code{font-size:12px;word-break:break-all}[hidden]{display:none!important}@media(prefers-color-scheme:dark){:root{${tokens(true)}}}`
/** The phone paints its own chrome from these, so it matches the page on both themes. */
const themeColor = '<meta name="theme-color" content="#FFFFFF" media="(prefers-color-scheme:light)"><meta name="theme-color" content="#151517" media="(prefers-color-scheme:dark)">'
export type PageLanguage = 'zh' | 'en'

const head = (title: string, language: PageLanguage) => `<!doctype html><html lang="${language === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${themeColor}<meta name="referrer" content="no-referrer"><title>${title}</title><style>${css}.language{width:auto;background:transparent;color:var(--rc-ink);padding-inline:10px}.language:hover{background:var(--rc-fill)}</style></head>`

/** What a public pairing page shows before anything is sent: the node the browser is talking to. */
export interface PairingNode {
  name: string
  kind: PublicNodeKind
  fingerprint: string
  fingerprintGroups: string
  /** Protocol 2 public key: the page derives the target fingerprint locally instead of trusting the label. */
  publicKey?: string | null
  protocol: number
}

const zh = {
  title: '连接 DeepSeek Harness', eyebrow: 'DSH · 远程', heading: '连接你的电脑',
  lan: '在电脑上确认这次配对后，你就可以在这里继续使用 DeepSeek Harness。',
  public: '先核对下方指纹是否与电脑远程控制面板上的一致，再到电脑上确认本次配对。',
  authority: '授权后，这台设备与本机拥有相同的操作权限。你可以随时在远程控制面板撤销设备。',
  name: '节点名称', kind: '类型', gateway: '隧道网关', service: '自托管服务', fingerprint: '目标主机指纹', protocol: '协议版本', confirm: '确认是本机',
  checking: '正在检查连接…', sending: '正在发送配对请求…', pending: '等待电脑确认，请查看本机远程控制面板。',
  approved: '已连接，正在打开远程界面…', retry: '重新检查连接', network: '暂时无法连接，请检查网络后重试。', busy: '配对请求过多，请稍后再试。',
  qrInvalid: '二维码已失效。请在电脑上打开远程控制面板，扫描新的二维码。',
  expired: '配对请求已过期或失效，请在电脑上打开远程控制面板并重新扫码。',
  rejected: '电脑已拒绝本次配对。如需继续，请与电脑上的操作者确认后重新扫码。',
  unknown: '暂时无法确认配对请求是否送达，请在电脑上检查待确认请求，再扫描新的二维码。',
  mismatch: '二维码中的主机指纹与这台电脑不一致，请重新扫码。',
  verifyUnavailable: '当前浏览器无法校验主机指纹，请使用最新版浏览器重新扫码。',
}
const pairingCopy: Record<PageLanguage, typeof zh> = {
  zh,
  en: {
    title: 'Connect to DeepSeek Harness', eyebrow: 'DSH · Remote', heading: 'Connect to your computer',
    lan: 'Approve this pairing on your computer to use DeepSeek Harness here.',
    public: 'Match the fingerprint below to the one in Remote Control, then approve the pairing on your computer.',
    authority: 'A paired device has the same permissions as your computer. You can revoke access in Remote Control at any time.',
    name: 'Node name', kind: 'Type', gateway: 'Tunnel gateway', service: 'Self-hosted service', fingerprint: 'Host fingerprint', protocol: 'Protocol version', confirm: 'This is my computer',
    checking: 'Checking connection…', sending: 'Sending pairing request…', pending: 'Waiting for approval. Open Remote Control on your computer.',
    approved: 'Connected. Opening DeepSeek Harness…', retry: 'Check connection again', network: 'Could not connect. Check your network and try again.', busy: 'Too many pairing requests. Try again in a moment.',
    qrInvalid: 'This QR code is no longer valid. Open Remote Control on your computer and scan a new QR code.',
    expired: 'This pairing request is no longer valid. Open Remote Control on your computer and scan a new QR code.',
    rejected: 'The computer declined this pairing. Ask the person at the computer before you scan again.',
    unknown: 'Could not confirm delivery. Check pending requests on your computer before scanning a new QR code.',
    mismatch: 'The QR code fingerprint does not match this computer. Scan a new QR code.',
    verifyUnavailable: 'This browser could not verify the host fingerprint. Update your browser and scan the QR code again.',
  },
}
const nodeRow = (key: keyof typeof zh, label: string, value: string, mono = false): string => `<dt data-copy="${key}" style="color:var(--rc-faint);font-size:12px;margin:0 0 2px">${label}</dt><dd style="margin:0 0 12px;color:var(--rc-ink);font-size:14px;line-height:1.6;word-break:break-word${mono ? ';font-family:ui-monospace,SFMono-Regular,Menlo,monospace' : ''}">${value}</dd>`
const scriptValue = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

export function pairingPage(node?: PairingNode, language: PageLanguage = 'zh'): string {
  const copy = pairingCopy[language]
  const identity = node ? `<p data-copy="public">${copy.public}</p><dl style="margin:0 0 16px;padding:14px 16px;border:1px solid var(--rc-line);border-radius:10px;background:var(--rc-fill)">
    ${nodeRow('name', copy.name, escapeHTML(node.name))}
    ${nodeRow('kind', copy.kind, `<span data-copy="${node.kind}">${copy[node.kind]}</span>`)}
    ${nodeRow('fingerprint', copy.fingerprint, `<span id="target-fingerprint">${escapeHTML(node.fingerprintGroups)}</span>`, true)}
    ${nodeRow('protocol', copy.protocol, `v${node.protocol}`)}</dl><p id="error" role="alert"></p><button id="confirm" disabled type="button" data-copy="confirm">${copy.confirm}</button>`
    : `<p data-copy="lan">${copy.lan}</p>`
  return head(copy.title, language) + `<body><main class="card"><span class="eyebrow" data-copy="eyebrow">${copy.eyebrow}</span>
    <button id="language" class="language" type="button" lang="${language === 'en' ? 'zh-CN' : 'en'}">${language === 'en' ? '中文' : 'English'}</button>
    <h1 data-copy="heading">${copy.heading}</h1>${identity}
    <div id="progress" ${node ? 'hidden' : ''}><div class="status" role="status"><span class="dot" aria-hidden="true"></span><span id="state">${copy.checking}</span></div>
    <small data-copy="authority">${copy.authority}</small><button id="enter" type="button" hidden>${copy.retry}</button></div></main><script>
(async () => {
  const byId = id => document.getElementById(id);
  const state = byId('state'), enter = byId('enter'), confirm = byId('confirm'), error = byId('error'), languageButton = byId('language');
  const words = ${scriptValue(pairingCopy)};
  const fingerprint = ${scriptValue(node?.fingerprint ?? null)};
  const nodePublicKey = ${scriptValue(node?.publicKey ?? null)};
  const params = new URLSearchParams(location.hash.slice(1));
  let token = params.get('pair');
  const pinned = params.get('key') || nodePublicKey;
  history.replaceState(null, '', '/pair');

  let language = ${scriptValue(language)}, status = 'checking', verificationError, retry = false;
  let claim, timer, started = false, running = false, finished = false;
  function render() {
    const copy = words[language];
    if (state.textContent !== copy[status]) state.textContent = copy[status];
    enter.hidden = !retry;
    enter.textContent = copy.retry;
    if (verificationError) error.textContent = copy[verificationError];
  }
  function setLanguage(value) {
    language = value;
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    document.title = words[language].title;
    for (const element of document.querySelectorAll('[data-copy]')) element.textContent = words[language][element.dataset.copy];
    languageButton.lang = language === 'en' ? 'zh-CN' : 'en';
    languageButton.textContent = language === 'en' ? '中文' : 'English';
    render();
  }
  try {
    const saved = localStorage.getItem('dsh-rc-language');
    if (saved === 'zh' || saved === 'en') language = saved;
  } catch { /* Storage may be unavailable. */ }
  setLanguage(language);
  languageButton.onclick = () => {
    setLanguage(language === 'en' ? 'zh' : 'en');
    try { localStorage.setItem('dsh-rc-language', language); } catch { /* The page still changes language. */ }
  };

  function show(next, canRetry = false) { status = next; retry = canRetry; render(); }
  function finish(next) {
    finished = true;
    token = null;
    claim = undefined;
    clearTimeout(timer);
    show(next);
    if (next === 'approved' && !document.hidden) location.replace('/');
  }
  const post = (path, data) => fetch(path, {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    signal: AbortSignal.timeout?.(8000),
  });
  function refused(data, submitting) {
    if (data?.code === 'fingerprint_mismatch') return finish('mismatch');
    if (data?.code === 'qr_invalid') return finish('qrInvalid');
    if (data?.code === 'claim_invalid') return finish('expired');
    if (data?.code === 'pairing_busy') return show('busy', true);
    if (submitting) finish('unknown');
    else show('network', true);
  }

  async function check() {
    if (!started || finished || running || document.hidden) return;
    running = true;
    clearTimeout(timer);
    let submitting = false, waiting = false;
    try {
      if (!claim) {
        show('checking');
        const health = await post('/api/dsh-remote-connect/manage', { action: 'requests' });
        if (health.ok) return finish('approved');
        if (health.status !== 403 || (await health.json().catch(() => null))?.code !== 'unpaired') return show('network', true);
        if (!token) return finish('qrInvalid');
        if (document.hidden) return;
        let model = '';
        try { model = (await navigator.userAgentData?.getHighEntropyValues(['model']))?.model || ''; } catch { /* Optional device model. */ }
        if (document.hidden) return;
        show('sending');
        submitting = true;
        const response = await post('/rc/pair/request', fingerprint ? { token, model, fingerprint } : { token, model });
        const data = await response.json().catch(() => null);
        if (!response.ok) return refused(data, true);
        if (!data || typeof data.id !== 'string' || !data.id || typeof data.key !== 'string' || !data.key || !Number.isFinite(data.expiresAt)) return finish('unknown');
        claim = { id: data.id, key: data.key };
        token = null;
        submitting = false;
      }
      show('pending');
      if (document.hidden) return;
      const response = await post('/rc/pair/claim', { id: claim.id, key: claim.key });
      const data = await response.json().catch(() => null);
      if (!response.ok) return refused(data, false);
      if (data?.state === 'approved') return finish('approved');
      if (data?.state === 'rejected') return finish('rejected');
      if (data?.state !== 'pending') return show('network', true);
      waiting = true;
    } catch {
      // The first request may have reached the computer even if its response was lost.
      if (submitting) finish('unknown');
      else show('network', true);
    } finally {
      running = false;
      if (waiting && !document.hidden) timer = setTimeout(check, 1500);
    }
  }
  enter.onclick = check;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else if (status === 'approved') location.replace('/');
    else if (claim || !retry) void check();
  });

  const target = byId('target-fingerprint');
  // Verify the pinned public key before enabling the public confirmation button.
  if (pinned && target) {
    try {
      const binary = atob(pinned.replace(/-/g, '+').replace(/_/g, '/'));
      const der = Uint8Array.from(binary, character => character.charCodeAt(0));
      const digest = await crypto.subtle.digest('SHA-256', der);
      const derived = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
      if (derived !== fingerprint) { verificationError = 'mismatch'; render(); return; }
      target.textContent = derived.toUpperCase().match(/.{4}/g).join('-');
    } catch { verificationError = 'verifyUnavailable'; render(); return; }
  }
  function start() {
    if (confirm) confirm.hidden = true;
    byId('progress').hidden = false;
    started = true;
    return check();
  }
  if (confirm && token) { confirm.onclick = start; confirm.disabled = false; }
  else await start();
})();
</script></body></html>`
}

export function deniedPage(reason?: string, language: PageLanguage = 'zh'): string {
  const en = language === 'en';
  const title = en ? 'Connect again' : '需要重新连接';
  const next = en ? 'Open Remote Control on the same computer to scan a new QR code and approve pairing.' : '请在电脑上打开远程控制面板，扫描同一台电脑的新二维码并确认配对。';
  const message = reason ? escapeHTML(reason) : en
    ? 'This device is not paired, or its authorization expired or was revoked.'
    : '这台设备尚未配对，授权已过期，或已被撤销。';
  const note = en ? 'Paired devices can keep using their fixed public address after a restart.' : '固定公网域名不会随重启改变。已授权设备可以继续使用原地址。';
  return head(en ? 'Device not authorized' : '设备尚未授权', language) + `<body><main class="card"><span class="eyebrow">${pairingCopy[language].eyebrow}</span><h1>${title}</h1><p>${message}</p><p>${next}</p><small>${note}</small></main></body></html>`;
}

const escapeHTML = (value: string): string => value.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!)

/** The gateway is up but the Host behind it did not hand over its page. */
export function unavailablePage(language: PageLanguage): string {
  const en = language === 'en';
  const title = en ? 'Your computer is not responding' : '电脑暂时没有响应';
  const message = en ? 'The remote connection is reachable, but DeepSeek Harness did not return a page. Make sure it is running on your computer, then try again.' : '远程连接是通的，但电脑上的 DeepSeek Harness 没有返回界面。请确认电脑仍在运行、会话没有退出，然后重试。';
  return head(title, language) + `<body><main class="card"><span class="eyebrow">${pairingCopy[language].eyebrow}</span><h1>${title}</h1><p>${message}</p><button type="button" onclick="location.reload()">${en ? 'Try again' : '重试'}</button></main></body></html>`;
}
