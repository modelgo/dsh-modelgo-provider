/**
 * ModelGo — browser half.
 *
 * Puts the key card wherever a person looks for it after installing:
 *
 *   - Settings → Models, in each ModelGo row, where every other provider's key
 *     is pasted;
 *   - the plugin's own page under Plugins, so the page that says "installed"
 *     is also the page that finishes the setup.
 *
 * Nobody has to edit a file or already know where the setting lives.
 *
 * The key is checked against the site before it is stored (a wrong key, or a
 * key from the other ModelGo site, is refused on the spot), then written
 * through the DSH credential service. It is write-only: this page never reads
 * a stored key back, and the key never enters plugin configuration.
 *
 * Hand-written in the DSH client-module format — no build step.
 */
window.__ModuleLoader__.load({
  id: '@model-go/dsh-modelgo-provider',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    /** Settings namespace: the profile entry id pinned by cordis.patch.yml. */
    const NS = 'modelgo';
    const PACKAGE = '@model-go/dsh-modelgo-provider';
    /** Route → the facts the card shows. Mirrors lib/sites.js on the Host. */
    const SITES = {
      modelgo: { domain: 'modelgo.com', other: 'modelgo.ai', ref: 'MODELGO_API_KEY', console: 'https://modelgo.com' },
      'modelgo-ai': { domain: 'modelgo.ai', other: 'modelgo.com', ref: 'MODELGO_AI_API_KEY', console: 'https://modelgo.ai' },
    };

    const ZH = {
      ready: (n) => `密钥已配置，可用 ${n} 个对话模型。`,
      readyNoCount: '密钥已配置。',
      checking: '正在读取模型列表…',
      missing: (s) => `还没有配置 ${s.domain} 的密钥，配置后它的模型才会出现在模型选择器里。`,
      label: 'API 密钥',
      placeholder: (s) => `粘贴 ${s.domain} 的密钥（mgk_ 开头）`,
      placeholderReplace: '粘贴新密钥以替换已保存的密钥',
      save: '验证并保存',
      saving: '验证中…',
      remove: '移除密钥',
      removeConfirm: '确认移除',
      cancel: '取消',
      getKey: (s) => `没有密钥？到 ${s.domain} 创建`,
      note: (s) => `密钥只保存在本机的 DSH 凭据库，不写入配置文件，也不会回显。${s.domain} 与 ${s.other} 的密钥互不通用。`,
      empty: '请先粘贴密钥。',
      badFormat: 'ModelGo 的密钥以 mgk_ 开头，且不含空格。请检查是否粘贴完整。',
      auth: (s) => `${s.domain} 不接受这个密钥。请确认密钥没有被删除，并且不是 ${s.other} 的密钥。`,
      network: (s) => `无法连接 ${s.domain}，请检查网络后重试。密钥没有保存。`,
      storedBroken: (s, m) => `已保存的密钥无法读取 ${s.domain} 的模型列表：${m}`,
      saved: (n) => `已保存，可用 ${n} 个对话模型。现在可以在模型选择器里选用。`,
      savedEmpty: '已保存，但这个密钥目前没有可用的对话模型。请在 ModelGo 控制台检查它的模型权限。',
      removed: '密钥已移除。',
      refused: 'DSH 拒绝了这次操作。',
      summary: '在这里填写 ModelGo 密钥；填好后模型出现在模型选择器里。',
      pageIntro: 'ModelGo 有两个站点，密钥互不通用。只需要给你使用的站点填写密钥；保存后它的模型会立刻出现在对话框的模型选择器里。同样的输入框也在「设置 → 模型」里。',
      siteHeading: (s) => `ModelGo（${s.domain}）`,
    };
    const EN = {
      ready: (n) => `Key configured — ${n} chat models available.`,
      readyNoCount: 'Key configured.',
      checking: 'Reading the model list…',
      missing: (s) => `No key for ${s.domain} yet. Its models appear in the model picker once a key is set.`,
      label: 'API key',
      placeholder: (s) => `Paste your ${s.domain} key (starts with mgk_)`,
      placeholderReplace: 'Paste a new key to replace the saved one',
      save: 'Verify and save',
      saving: 'Verifying…',
      remove: 'Remove key',
      removeConfirm: 'Confirm removal',
      cancel: 'Cancel',
      getKey: (s) => `No key? Create one at ${s.domain}`,
      note: (s) => `The key is kept in the local DSH credential store only — never in a config file, never shown again. Keys for ${s.domain} and ${s.other} are separate.`,
      empty: 'Paste a key first.',
      badFormat: 'A ModelGo key starts with mgk_ and has no spaces. Check that it was pasted completely.',
      auth: (s) => `${s.domain} did not accept this key. Check that it has not been deleted and that it is not a ${s.other} key.`,
      network: (s) => `Could not reach ${s.domain}. Check your network and try again. The key was not saved.`,
      storedBroken: (s, m) => `The saved key cannot read the ${s.domain} model list: ${m}`,
      saved: (n) => `Saved — ${n} chat models available. Pick one in the model picker.`,
      savedEmpty: 'Saved, but this key has no chat models available yet. Check its model permissions in the ModelGo console.',
      removed: 'Key removed.',
      refused: 'DSH refused this operation.',
      summary: 'Set your ModelGo key here; its models then appear in the model picker.',
      pageIntro: 'ModelGo runs two sites with separate keys. Set a key only for the site you use; its models appear in the composer\'s model picker as soon as it is saved. The same fields are in Settings → Models.',
      siteHeading: (s) => `ModelGo (${s.domain})`,
    };
    const strings = () => (/^zh/i.test(document.documentElement.lang || navigator.language || '') ? ZH : EN);

    // Styled with the host's own tokens so the card follows light and dark themes.
    const CSS = `
      .mgo-card{display:flex;flex-direction:column;gap:8px;margin-top:8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2328)}
      .mgo-status{display:flex;align-items:flex-start;gap:6px}
      .mgo-dot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:6px;background:var(--dsw-alias-label-tertiary,#8b93a1)}
      .mgo-dot.ok{background:var(--dsw-alias-state-success-primary,#16a34a)}
      .mgo-dot.bad{background:var(--dsw-alias-state-error-primary,#dc2626)}
      .mgo-label{font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}
      .mgo-row{display:flex;gap:8px;flex-wrap:wrap}
      .mgo-input{flex:1;min-width:180px;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
      .mgo-input:focus{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-1px}
      .mgo-btn{height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
      .mgo-btn.primary{border-color:transparent;background:var(--dsw-alias-label-primary,#1f2328);color:var(--dsw-alias-bg-base,#fff)}
      .mgo-btn.danger{color:var(--dsw-alias-state-error-primary,#dc2626)}
      .mgo-btn:disabled{opacity:.5;cursor:default}
      .mgo-msg{font-size:12px}
      .mgo-msg.ok{color:var(--dsw-alias-state-success-primary,#16a34a)}
      .mgo-msg.bad{color:var(--dsw-alias-state-error-primary,#dc2626)}
      .mgo-foot{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b93a1)}
      .mgo-link{color:var(--dsw-alias-brand-primary,#4d6bfe);text-decoration:none;align-self:flex-start}
      .mgo-link:hover{text-decoration:underline}
      .mgo-page{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2328)}
      .mgo-intro{color:var(--dsw-alias-label-secondary,#57606a)}
      .mgo-site{padding:12px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12))}
      .mgo-site-title{font-weight:600}
    `;
    const ensureStyles = () => {
      if (document.getElementById('mgo-card-styles')) return;
      const style = document.createElement('style');
      style.id = 'mgo-card-styles';
      style.textContent = CSS;
      document.head.appendChild(style);
    };

    /** A key ModelGo could have issued: the `mgk_` prefix, then printable ASCII with no spaces. */
    const looksLikeKey = (value) => /^mgk_[\x21-\x7E]{8,}$/.test(value);

    /** Turn a Host refusal into something a person can act on. */
    const explain = (t, site, message) => {
      const text = String(message ?? '');
      if (/\b(401|403)\b|AUTH|unauthori[sz]ed/i.test(text)) return t.auth(site);
      if (/timed out|network error|UNREACHABLE|TIMEOUT|ENOTFOUND|ECONN/i.test(text)) return t.network(site);
      return text || t.refused;
    };

    function ModelGoCard(props) {
      const routeId = props.provider?.provider;
      const site = SITES[routeId];
      const remote = props.modelgo.remote;
      const t = strings();
      const [key, setKey] = useState('');
      const [busy, setBusy] = useState(false);
      const [confirmingRemove, setConfirmingRemove] = useState(false);
      // What this card itself learned since it opened; the page's own join catches up afterwards.
      const [override, setOverride] = useState(undefined);
      const [result, setResult] = useState(undefined);
      const [count, setCount] = useState(undefined);
      const [storedProblem, setStoredProblem] = useState(undefined);
      // The Models page tells the card whether a key is stored; elsewhere the card finds out by asking.
      const [probed, setProbed] = useState(undefined);
      const configured = override ?? (props.keyConfigured ?? probed) === true;

      /** Ask the Host which chat models a key can use; with no key it answers for the stored one. */
      const listModels = async (apiKey) => {
        const response = await remote.llm.discoverModels(NS, { provider: routeId, ...(apiKey ? { apiKey } : {}) });
        if (!response.ok) return { ok: false, message: response.error?.message };
        return { ok: true, count: Array.isArray(response.value) ? response.value.length : 0 };
      };

      // An already-configured row reports whether its key still works. Where nobody
      // said whether a key is stored, the same read answers that too.
      useEffect(() => {
        const known = props.keyConfigured !== undefined;
        if (!site || result?.kind === 'ok' || (known ? !configured : override !== undefined || probed !== undefined)) return undefined;
        let live = true;
        setCount(undefined);
        setStoredProblem(undefined);
        listModels().then((answer) => {
          if (!live) return;
          if (answer.ok) { setProbed(true); setCount(answer.count); return; }
          if (!known && /MISSING_CREDENTIAL|no key for/i.test(String(answer.message))) { setProbed(false); return; }
          setProbed(true);
          setStoredProblem(explain(t, site, answer.message));
        }, () => {});
        return () => { live = false; };
      }, [routeId, configured, props.keyConfigured]);

      if (!site) return null;

      const save = async () => {
        const value = key.trim();
        if (!value) { setResult({ kind: 'bad', text: t.empty }); return; }
        if (!looksLikeKey(value)) { setResult({ kind: 'bad', text: t.badFormat }); return; }
        setBusy(true);
        setResult(undefined);
        try {
          const answer = await listModels(value);
          if (!answer.ok) { setResult({ kind: 'bad', text: explain(t, site, answer.message) }); return; }
          const stored = await remote.credentials.set(site.ref, value);
          if (!stored.ok) { setResult({ kind: 'bad', text: stored.error?.message ?? t.refused }); return; }
          setKey('');
          setOverride(true);
          setStoredProblem(undefined);
          setCount(answer.count);
          setResult({ kind: 'ok', text: answer.count > 0 ? t.saved(answer.count) : t.savedEmpty });
        } catch (error) {
          setResult({ kind: 'bad', text: explain(t, site, error?.message) });
        } finally {
          setBusy(false);
        }
      };

      const remove = async () => {
        setBusy(true);
        setResult(undefined);
        try {
          const removed = await remote.credentials.unset(site.ref);
          if (removed && removed.ok === false) { setResult({ kind: 'bad', text: removed.error?.message ?? t.refused }); return; }
          setOverride(false);
          setCount(undefined);
          setStoredProblem(undefined);
          setResult({ kind: 'ok', text: t.removed });
        } catch (error) {
          setResult({ kind: 'bad', text: explain(t, site, error?.message) });
        } finally {
          setBusy(false);
          setConfirmingRemove(false);
        }
      };

      const status = !configured
        ? { tone: '', text: t.missing(site) }
        : storedProblem
          ? { tone: 'bad', text: t.storedBroken(site, storedProblem) }
          : count === undefined
            ? { tone: 'ok', text: t.checking }
            : { tone: 'ok', text: t.ready(count) };
      const inputId = `mgo-key-${routeId}`;

      return h('div', { className: 'mgo-card' }, [
        h('div', { key: 'status', className: 'mgo-status', role: 'status' }, [
          h('span', { key: 'dot', className: `mgo-dot ${status.tone}` }),
          h('span', { key: 'text' }, status.text),
        ]),
        h('label', { key: 'label', className: 'mgo-label', htmlFor: inputId }, t.label),
        h('form', {
          key: 'row',
          className: 'mgo-row',
          onSubmit: (event) => { event.preventDefault(); if (!busy) void save(); },
        }, [
          h('input', {
            key: 'input',
            id: inputId,
            className: 'mgo-input',
            type: 'password',
            autoComplete: 'new-password',
            spellCheck: false,
            value: key,
            disabled: busy,
            placeholder: configured ? t.placeholderReplace : t.placeholder(site),
            onChange: (event) => { setKey(event.target.value); setResult(undefined); },
          }),
          h('button', { key: 'save', type: 'submit', className: 'mgo-btn primary', disabled: busy || key.trim() === '' }, busy ? t.saving : t.save),
          configured && !confirmingRemove
            ? h('button', { key: 'remove', type: 'button', className: 'mgo-btn', disabled: busy, onClick: () => setConfirmingRemove(true) }, t.remove)
            : null,
          configured && confirmingRemove
            ? h('button', { key: 'confirm', type: 'button', className: 'mgo-btn danger', disabled: busy, onClick: () => void remove() }, t.removeConfirm)
            : null,
          configured && confirmingRemove
            ? h('button', { key: 'cancel', type: 'button', className: 'mgo-btn', disabled: busy, onClick: () => setConfirmingRemove(false) }, t.cancel)
            : null,
        ]),
        result ? h('div', { key: 'result', className: `mgo-msg ${result.kind}`, role: result.kind === 'bad' ? 'alert' : 'status' }, result.text) : null,
        h('div', { key: 'foot', className: 'mgo-foot' }, [
          h('a', { key: 'link', className: 'mgo-link', href: site.console, target: '_blank', rel: 'noreferrer' }, `${t.getKey(site)} ↗`),
          h('span', { key: 'note' }, t.note(site)),
        ]),
      ]);
    }

    /** The plugin's own page under Plugins: both sites' key cards, so setup finishes where install ended. */
    function ModelGoConfigPage(props) {
      const t = strings();
      if (props.view === 'summary') return t.summary;
      return h('div', { className: 'mgo-page' }, [
        h('div', { key: 'intro', className: 'mgo-intro' }, t.pageIntro),
        ...Object.entries(SITES).map(([id, site]) => h('div', { key: id, className: 'mgo-site' }, [
          h('div', { key: 'title', className: 'mgo-site-title' }, t.siteHeading(site)),
          h(ModelGoCard, { key: 'card', provider: { provider: id }, modelgo: props.modelgo }),
        ])),
      ]);
    }

    return {
      inject: ['slots', 'remote', 'remote.credentials', 'remote.llm'],
      apply(ctx) {
        ensureStyles();
        // One registration under the plugin's settings namespace receives both site rows.
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
          name: 'settings.models.provider-card',
          key: NS,
          inject: () => ({ modelgo: { remote: ctx.remote } }),
        }, ModelGoCard));
        // Keyed by package name; a host without the Plugins page simply never asks for it.
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PACKAGE,
          inject: () => ({ modelgo: { remote: ctx.remote } }),
        }, ModelGoConfigPage));
      },
    };
  },
});
