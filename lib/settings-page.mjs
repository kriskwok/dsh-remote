// dsh-remote 设置页面（由本机代理 /__dsh-remote/ 提供）
//
// 访问方式：
//   - Mac 本机浏览器：http://127.0.0.1:<port>/__dsh-remote/（loopback，免密码）
//   - 经 App 入口：https://<域名>:3443/__dsh-remote/（Host 是公网域名，需先过 PIN）
// 页面纯静态，数据通过同目录 config 接口（GET 读 / POST 写）获取与保存。

export const SETTINGS_PAGE_PATH = '/__dsh-remote/';
export const SETTINGS_CONFIG_PATH = '/__dsh-remote/config';

export function settingsPageHtml({ base = SETTINGS_PAGE_PATH.replace(/\/$/, '') } = {}) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Remote · 设置</title>
<style>
:root{--blue:#4f6ef7;--gray:#6b7280;--line:#e5e7eb;--bg:#f3f4f6;--red:#dc2626;--green:#16a34a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827}
.wrap{max-width:560px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:20px;margin:8px 0 2px}
.sub{font-size:13px;color:var(--gray);margin:0 0 20px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px}
.card h2{font-size:15px;margin:0 0 14px}
.row{display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:none;padding-top:0}
.row .txt{flex:1}
.row .t{font-size:14px;font-weight:600;margin-bottom:3px}
.row .d{font-size:12px;color:var(--gray);line-height:1.6}
.badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;margin-left:6px;vertical-align:middle}
.badge.on{background:#dcfce7;color:var(--green)}
.badge.off{background:#fee2e2;color:var(--red)}
.badge.info{background:#e0e7ff;color:#4338ca}
/* 开关 */
.sw{position:relative;width:44px;height:26px;flex:none;margin-top:2px}
.sw input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:#cbd5e1;border-radius:26px;transition:.2s;cursor:pointer}
.slider:before{content:"";position:absolute;height:20px;width:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.sw input:checked + .slider{background:var(--blue)}
.sw input:checked + .slider:before{transform:translateX(18px)}
.sw input:disabled + .slider{opacity:.5;cursor:not-allowed}
/* 密码 */
label.f{display:block;font-size:12px;color:var(--gray);margin:10px 0 4px}
input[type=password],input[type=text]{width:100%;padding:9px 11px;font-size:14px;border:1px solid #d1d5db;border-radius:8px;outline:none}
input:focus{border-color:var(--blue)}
.pwwrap{position:relative}
.pwwrap .eye{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:none;background:none;color:var(--gray);cursor:pointer;font-size:13px;padding:4px}
.check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--gray);margin:10px 0}
.check input{width:15px;height:15px}
button.primary{padding:9px 18px;font-size:14px;background:var(--blue);color:#fff;border:none;border-radius:8px;cursor:pointer}
button.primary:disabled{opacity:.5}
.hint{font-size:12px;color:var(--gray);line-height:1.6;margin:8px 0 0}
.warn{color:var(--red)}
.kv{font-size:12px;color:var(--gray);line-height:1.9;word-break:break-all}
.kv b{color:#374151;font-weight:600}
/* toast */
#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#fff;font-size:13px;padding:9px 16px;border-radius:8px;opacity:0;transition:.25s;pointer-events:none;max-width:90%}
#toast.show{opacity:.95}
#toast.err{background:var(--red)}
</style></head><body><div class="wrap">
<h1>🛰️ DSH Remote 设置</h1>
<p class="sub">控制 App 远程访问本机 DSH 的两条链路；修改即时生效。</p>

<div class="card">
  <h2>访问方式</h2>
  <div class="row">
    <div class="txt">
      <div class="t">局域网访问 <span id="bLan" class="badge on">已开启</span></div>
      <div class="d">电脑与服务器在同一局域网时，App 经服务器<b>直连</b>本机代理，延迟最低。<br>关闭后：本机代理拒绝一切非本机连接，且不向服务器通告局域网地址。</div>
    </div>
    <label class="sw"><input id="swLan" type="checkbox" checked><span class="slider"></span></label>
  </div>
  <div class="row">
    <div class="txt">
      <div class="t">公网隧道访问 <span id="bTun" class="badge on">已开启</span></div>
      <div class="d">电脑在外网 / 公共网络时，插件<b>主动向服务器拨出</b>加密隧道（WSS）。<br>关闭后：不会向服务器发起任何连接，外网将无法访问（不影响局域网模式）。</div>
    </div>
    <label class="sw"><input id="swTun" type="checkbox" checked><span class="slider"></span></label>
  </div>
</div>

<div class="card">
  <h2>访问密码</h2>
  <div class="kv">当前状态：<span id="pinState"></span></div>
  <label class="f" for="np">新密码（格式、长度均不限，支持中文 / 空格 / 符号）</label>
  <div class="pwwrap">
    <input id="np" type="password" placeholder="留空点保存 = 不修改密码" autocomplete="new-password">
    <button type="button" class="eye" id="eye">显示</button>
  </div>
  <label class="check"><input id="clearPw" type="checkbox">我要清空密码（<span class="warn">关闭密码校验，任何人可直接访问，不推荐</span>）</label>
  <button class="primary" id="savePw">保存密码</button>
  <p class="hint">修改密码后，之前已登录的设备需要用新密码重新连接。</p>
</div>

<div class="card">
  <h2>运行信息</h2>
  <div class="kv" id="info"></div>
</div>

</div><div id="toast"></div>
<script>
const CFG='${base}/config';
let last=null;
const $=(id)=>document.getElementById(id);
function toast(m,err){const t=$('toast');t.textContent=m;t.className='show'+(err?' err':'');clearTimeout(t._t);t._t=setTimeout(()=>t.className='',2600)}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}

function render(s){
  last=s;
  $('swLan').checked=s.access.lan; $('swTun').checked=s.access.tunnel;
  $('bLan').className='badge '+(s.access.lan?'on':'off'); $('bLan').textContent=s.access.lan?'已开启':'已关闭';
  $('bTun').className='badge '+(s.access.tunnel?'on':'off'); $('bTun').textContent=s.access.tunnel?'已开启':'已关闭';
  const p=s.pin;
  $('pinState').innerHTML = p.set
    ? '<b>已设置</b>（'+p.length+' 个字符，来源：'+esc(p.source)+'）'
    : '<span class=\\'warn\\'><b>未设置 / 空密码</b>（不校验密码）</span>';
  const tun=s.tunnel;
  let tunLine = tun
    ? '隧道：<b>'+esc(tun.state)+'</b>'+(tun.activeUrl?'（'+esc(tun.activeUrl)+'）':'')+(tun.lastError?'<br><span class="warn">'+esc(tun.lastError)+'</span>':'')
    : '隧道：<b>未启用</b>';
  $('info').innerHTML = tunLine
    + '<br>节点名：<b>'+esc(s.node)+'</b>'
    + '<br>中继地址：'+(s.urls&&s.urls.length?s.urls.map(esc).join('<br>　　　　'):'<b>未配置</b>');
}

async function refresh(){
  try{const r=await fetch(CFG,{cache:'no-store'});if(!r.ok)throw new Error(await r.text());render(await r.json())}
  catch(e){toast('读取状态失败：'+e.message,true)}
}

async function save(patch){
  const r=await fetch(CFG,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
  if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||r.status);
  render(await r.json());
}
function bindSwitch(el,key,label,warnText){
  el.addEventListener('change',async()=>{
    const on=el.checked;
    if(!on&&warnText&&!confirm(warnText)){el.checked=!on;return}
    el.disabled=true;
    try{await save({[key]:on});toast(label+(on?'已开启':'已关闭'))}
    catch(e){el.checked=!on;toast(e.message,true)}
    el.disabled=false;
  });
}
bindSwitch($('swLan'),'lan','局域网访问');
bindSwitch($('swTun'),'tunnel','公网隧道访问','关闭公网隧道后，电脑一旦离开服务器所在局域网，App 将无法连接。确定关闭？');

$('eye').onclick=()=>{const i=$('np');i.type=i.type==='password'?'text':'password';$('eye').textContent=i.type==='password'?'显示':'隐藏'};
$('clearPw').onchange=(e)=>{if(e.target.checked){$('np').value='';$('np').disabled=true}else{$('np').disabled=false}};
$('savePw').onclick=async()=>{
  const clear=$('clearPw').checked;
  const val=$('np').value;
  if(!clear&&val===''){toast('未输入新密码，未修改');return}
  if(!confirm(clear?'确定清空密码？清空后任何人无需密码即可访问。':'确定修改访问密码？已登录设备将需要重新连接。'))return;
  $('savePw').disabled=true;
  try{await save({pin:clear?'':val});toast('密码已'+(clear?'清空':'修改'));$('np').value='';$('clearPw').checked=false;$('np').disabled=false}
  catch(e){toast(e.message,true)}
  $('savePw').disabled=false;
};
refresh();setInterval(refresh,5000);
</script></body></html>`;
}
