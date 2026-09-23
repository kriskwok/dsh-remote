// dsh-remote —— 浏览器侧（client 半）
//
// 注意写法：host 会把各插件 client 文件拼进同一个 plugins 包，按普通脚本执行。
// 所以必须用 window.__ModuleLoader__.load 自注册外壳，factory 里 return module.exports；
// 顶层禁止 return（否则整个 bundle 报 Illegal return statement，连 64 个内置插件一起挂）。
// React 通过 loader 注入的 require('react') 拿。
//
// 功能：向 host 的 `plugins.row.config` 槽位注册 `dsh-remote#remote` 面板，
// 在 DSH「设置 → 插件 → remote 卡片」上出现「配置」入口：
//   两个开关（局域网访问 / 公网隧道访问）+ 修改访问密码（格式长度不限）。
// 数据走同源 GET/POST /__dsh-remote/config。

window.__ModuleLoader__.load({
  id: 'dsh-remote',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useCallback = React.useCallback;
    var createElement = React.createElement;

    var CSS_ID = 'dsh-remote-client-css';
    function installStyles() {
      if (typeof document === 'undefined' || document.getElementById(CSS_ID)) return;
      var style = document.createElement('style');
      style.id = CSS_ID;
      style.textContent = [
        '.dr_wrap{max-width:560px;display:flex;flex-direction:column;gap:14px}',
        '.dr_row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
        '.dr_row:last-child{border-bottom:0}',
        '.dr_label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
        '.dr_hint{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px;line-height:18px}',
        '.dr_toggle{appearance:none;cursor:pointer;width:38px;height:22px;border-radius:11px;background:var(--dsw-alias-fill-l3,rgba(128,128,128,.3));border:none;position:relative;transition:background .15s}',
        '.dr_toggle::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
        '.dr_toggle[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#4f6ef7)}',
        '.dr_toggle[aria-checked="true"]::after{transform:translateX(16px)}',
        '.dr_input{box-sizing:border-box;width:100%;height:34px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l4);border-radius:8px;padding:0 10px;font:inherit;font-size:13px}',
        '.dr_btn{cursor:pointer;height:32px;padding:0 14px;border:none;border-radius:8px;background:var(--dsw-alias-brand-primary,#4f6ef7);color:#fff;font:inherit;font-size:13px}',
        '.dr_btn:hover{opacity:.9}',
        '.dr_btn:disabled{opacity:.5;cursor:default}',
        '.dr_status{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:18px}',
        '.dr_err{color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px;line-height:18px}',
        '.dr_chk{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:6px}',
        '.dr_btns{display:flex;gap:8px;margin-top:10px}',
      ].join('');
      document.head.appendChild(style);
    }

    // 配置接口在插件自己的 :3081 代理上（dsh web 在 :3080），
    // 页面跑在本机浏览器，按 location.hostname 拼绝对地址；跨源已在代理侧放行。
    function apiBase() {
      if (typeof location !== 'undefined' && location && location.hostname) {
        return 'http://' + location.hostname + ':3081';
      }
      return '';
    }

    function loadConfig() {
      return fetch(apiBase() + '/__dsh-remote/config', { credentials: 'include', cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    }

    function savePatch(patch) {
      return fetch(apiBase() + '/__dsh-remote/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(patch),
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    }

    function Toggle(props) {
      return createElement('button', {
        type: 'button',
        className: 'dr_toggle',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        onClick: function () { props.onChange(!props.checked); },
      });
    }

    function modeText(snap) {
      if (!snap || !snap.tunnel) return '未配置中继';
      var t = snap.tunnel;
      if (t.state === 'connected') return '隧道已连接（' + (t.node || '') + '）';
      if (t.state === 'stopped') return '隧道已停止';
      return '隧道：' + (t.state || 'unknown');
    }

    function RemoteConfig(props) {
      var view = props.view;
      var state = useState(null);
      var snap = state[0];
      var setSnap = state[1];
      var errState = useState('');
      var setErr = errState[1];
      var pinState = useState('');
      var setPinDraft = pinState[1];
      var clearState = useState(false);
      var setClearPin = clearState[1];
      var busyState = useState(false);
      var setBusy = busyState[1];

      var refresh = useCallback(function () {
        loadConfig().then(function (c) { setErr(''); setSnap(c); }).catch(function (e) { setErr('读取配置失败：' + e.message); });
      }, [setSnap, setErr]);

      useEffect(function () { installStyles(); refresh(); }, [refresh]);

      var flip = function (key, value) {
        setBusy(true);
        var patch = {};
        patch[key] = value;
        savePatch(patch).then(function (c) { setSnap(c); setErr(''); }).catch(function (e) { setErr('保存失败：' + e.message); }).finally(function () { setBusy(false); });
      };

      var savePin = function () {
        setBusy(true);
        var value = clearState[0] ? '' : pinState[0];
        savePatch({ pin: value }).then(function (c) { setSnap(c); setPinDraft(''); setClearPin(false); setErr(''); }).catch(function (e) { setErr('修改密码失败：' + e.message); }).finally(function () { setBusy(false); });
      };

      if (view === 'summary') {
        if (!snap) return createElement('span', { className: 'dr_status' }, '加载中…');
        return createElement('span', { className: 'dr_status' },
          '局域网访问：' + (snap.access && snap.access.lan ? '开' : '关') +
          '　公网隧道：' + (snap.access && snap.access.tunnel ? '开' : '关') +
          '　' + modeText(snap));
      }

      var access = (snap && snap.access) || { lan: true, tunnel: true };
      var children = [
        createElement('div', { className: 'dr_row', key: 'lan' },
          createElement('div', null,
            createElement('div', { className: 'dr_label' }, '局域网访问'),
            createElement('div', { className: 'dr_hint' }, '与服务器同局域网时直连本机代理。关闭后不再通告 LAN 候选，且拒绝非本机连接。')),
          createElement(Toggle, { checked: !!access.lan, onChange: function (v) { flip('lan', v); } })),
        createElement('div', { className: 'dr_row', key: 'tunnel' },
          createElement('div', null,
            createElement('div', { className: 'dr_label' }, '公网隧道访问'),
            createElement('div', { className: 'dr_hint' }, '外网时插件主动向服务器拨出 WSS 隧道。关闭后不发起任何外连。')),
          createElement(Toggle, { checked: !!access.tunnel, onChange: function (v) { flip('tunnel', v); } })),
        createElement('div', { className: 'dr_row', key: 'pin' },
          createElement('div', { style: { flex: 1 } },
            createElement('div', { className: 'dr_label' }, '访问密码'),
            createElement('div', { className: 'dr_hint' },
              snap && snap.pin && snap.pin.set
                ? '当前已设置（' + snap.pin.length + ' 字符）。修改后旧登录立即失效。'
                : '当前未设置密码，任何人都能访问。'),
            createElement('input', {
              className: 'dr_input', style: { marginTop: 8 }, type: 'text',
              placeholder: '输入新密码（格式长度不限，留空不改）',
              value: pinState[0], onChange: function (e) { setPinDraft(e.target.value); },
            }),
            createElement('label', { className: 'dr_chk' },
              createElement('input', { type: 'checkbox', checked: clearState[0], onChange: function (e) { setClearPin(e.target.checked); } }),
              '清空密码（关闭密码校验，任何人无需密码即可访问）'),
            createElement('div', { className: 'dr_btns' },
              createElement('button', { className: 'dr_btn', disabled: busyState[0] || (!pinState[0] && !clearState[0]), onClick: savePin }, '保存密码')))),
        createElement('div', { className: 'dr_status' }, modeText(snap) + (snap && snap.urls && snap.urls.length ? '　中继：' + snap.urls.length + ' 个地址' : '')),
      ];
      if (errState[0]) children.push(createElement('div', { className: 'dr_err' }, errState[0]));
      return createElement('div', { className: 'dr_wrap' }, children);
    }

    function apply(ctx) {
      installStyles();
      // 设置 → 插件卡片里的「配置」入口（保留，作为快捷入口）
      ctx.slots.inject('plugins.row.config', function () {
        return ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-remote#remote',
        }, RemoteConfig);
      });
      // 设置左侧导航直接出现「远程访问」整页（跟「网页搜索」同机制）
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-remote',
          order: 60,
          label: function () { return '远程访问'; },
        }, RemoteConfig);
      });
    }

    exports.RemoteConfig = RemoteConfig;
    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
