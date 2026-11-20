/**
 * ModelGo — browser half.
 *
 * Puts the key field wherever a person looks for it after installing:
 *
 *   - the plugin's own page under Plugins, so the page that says "installed"
 *     is also the page that finishes the setup;
 *   - Settings → Models, in the ModelGo row, where every other provider's key
 *     is pasted.
 *
 * The key is checked against the site before it is stored (a wrong key is
 * refused on the spot), then written through the DSH credential service. It is
 * write-only: this page never reads a stored key back, and the key never
 * enters plugin configuration.
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
    /** The provider route and where its key lives. Mirrors lib/sites.js on the Host. */
    const ROUTE = 'modelgo';
    const KEY_REF = 'MODELGO_API_KEY';
    const CONSOLE_URL = 'https://modelgo.ai';

    const ZH = {
      ready: (n) => `已配置，可用 ${n} 个模型。`,
      checking: '正在读取模型列表…',
      missing: '粘贴 API 密钥后，模型会出现在模型选择器里。',
      label: 'API 密钥',
      placeholder: '粘贴密钥（mgk_ 开头）',
      placeholderReplace: '粘贴新密钥以替换',
      save: '验证并保存',
      saving: '验证中…',
      remove: '移除',
      removeConfirm: '确认移除',
      cancel: '取消',
      getKey: '获取密钥',
      empty: '请先粘贴密钥。',
      badFormat: '密钥以 mgk_ 开头，且不含空格。请检查是否粘贴完整。',
      auth: '这个密钥无效。请确认它没有被删除。',
      network: '无法连接 ModelGo，请检查网络后重试。密钥没有保存。',
      storedBroken: (m) => `已保存的密钥无法读取模型列表：${m}`,
      saved: (n) => `已保存，可用 ${n} 个模型。`,
      savedEmpty: '已保存，但这个密钥目前没有可用的对话模型。请在 ModelGo 控制台检查它的模型权限。',
      removed: '密钥已移除。',
      refused: 'DSH 拒绝了这次操作。',
      summary: '在这里粘贴 ModelGo 密钥即可使用。',
    };
    const EN = {
      ready: (n) => `Configured — ${n} models available.`,
      checking: 'Reading the model list…',
      missing: 'Paste your API key and the models appear in the model picker.',
      label: 'API key',
      placeholder: 'Paste your key (starts with mgk_)',
      placeholderReplace: 'Paste a new key to replace it',
      save: 'Verify and save',
      saving: 'Verifying…',
      remove: 'Remove',
      removeConfirm: 'Confirm removal',
      cancel: 'Cancel',
      getKey: 'Get a key',
      empty: 'Paste a key first.',
      badFormat: 'A key starts with mgk_ and has no spaces. Check that it was pasted completely.',
      auth: 'This key is not valid. Check that it has not been deleted.',
      network: 'Could not reach ModelGo. Check your network and try again. The key was not saved.',
      storedBroken: (m) => `The saved key cannot read the model list: ${m}`,
      saved: (n) => `Saved — ${n} models available.`,
      savedEmpty: 'Saved, but this key has no chat models available yet. Check its model permissions in the ModelGo console.',
      removed: 'Key removed.',
      refused: 'DSH refused this operation.',
      summary: 'Paste your ModelGo key here to start.',
    };
    const strings = () => (/^zh/i.test(document.documentElement.lang || navigator.language || '') ? ZH : EN);

    // Styled with the host's own tokens so the card follows light and dark themes.
    const CSS = `
      .mgo-card{display:flex;flex-direction:column;gap:8px;margin-top:8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2328)}
      .mgo-status{display:flex;align-items:flex-start;gap:6px}
      .mgo-dot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:6px;background:var(--dsw-alias-label-tertiary,#8b93a1)}
      .mgo-dot.ok{background:var(--dsw-alias-state-success-primary,#16a34a)}
      .mgo-dot.bad{background:var(--dsw-alias-state-error-primary,#dc2626)}
      .mgo-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
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
      .mgo-link{font-size:12px;color:var(--dsw-alias-brand-primary,#4d6bfe);text-decoration:none;white-space:nowrap}
      .mgo-link:hover{text-decoration:underline}
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
    const explain = (t, message) => {
      const text = String(message ?? '');
      if (/\b(401|403)\b|AUTH|unauthori[sz]ed/i.test(text)) return t.auth;
      if (/timed out|network error|UNREACHABLE|TIMEOUT|ENOTFOUND|ECONN/i.test(text)) return t.network;
      return text || t.refused;
    };

    function ModelGoCard(props) {
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
      const mine = props.provider === undefined || props.provider.provider === ROUTE;

      /** Ask the Host which chat models a key can use; with no key it answers for the stored one. */
      const listModels = async (apiKey) => {
        const response = await remote.llm.discoverModels(NS, { provider: ROUTE, ...(apiKey ? { apiKey } : {}) });
        if (!response.ok) return { ok: false, message: response.error?.message };
        return { ok: true, count: Array.isArray(response.value) ? response.value.length : 0 };
      };

      // An already-configured row reports whether its key still works. Where nobody
      // said whether a key is stored, the same read answers that too.
      useEffect(() => {
        const known = props.keyConfigured !== undefined;
        if (!mine || result?.kind === 'ok' || (known ? !configured : override !== undefined || probed !== undefined)) return undefined;
        let live = true;
        setCount(undefined);
        setStoredProblem(undefined);
        listModels().then((answer) => {
          if (!live) return;
          if (answer.ok) { setProbed(true); setCount(answer.count); return; }
          if (!known && /MISSING_CREDENTIAL|no key set/i.test(String(answer.message))) { setProbed(false); return; }
          setProbed(true);
          setStoredProblem(explain(t, answer.message));
        }, () => {});
        return () => { live = false; };
      }, [configured, props.keyConfigured]);

      if (!mine) return null;

      const save = async () => {
        const value = key.trim();
        if (!value) { setResult({ kind: 'bad', text: t.empty }); return; }
        if (!looksLikeKey(value)) { setResult({ kind: 'bad', text: t.badFormat }); return; }
        setBusy(true);
        setResult(undefined);
        try {
          const answer = await listModels(value);
          if (!answer.ok) { setResult({ kind: 'bad', text: explain(t, answer.message) }); return; }
          const stored = await remote.credentials.set(KEY_REF, value);
          if (!stored.ok) { setResult({ kind: 'bad', text: stored.error?.message ?? t.refused }); return; }
          setKey('');
          setOverride(true);
          setStoredProblem(undefined);
          setCount(answer.count);
          setResult({ kind: 'ok', text: answer.count > 0 ? t.saved(answer.count) : t.savedEmpty });
        } catch (error) {
          setResult({ kind: 'bad', text: explain(t, error?.message) });
        } finally {
          setBusy(false);
        }
      };

      const remove = async () => {
        setBusy(true);
        setResult(undefined);
        try {
          const removed = await remote.credentials.unset(KEY_REF);
          if (removed && removed.ok === false) { setResult({ kind: 'bad', text: removed.error?.message ?? t.refused }); return; }
          setOverride(false);
          setCount(undefined);
          setStoredProblem(undefined);
          setResult({ kind: 'ok', text: t.removed });
        } catch (error) {
          setResult({ kind: 'bad', text: explain(t, error?.message) });
        } finally {
          setBusy(false);
          setConfirmingRemove(false);
        }
      };

      // One line of state at a time: the outcome of what was just done, else where things stand.
      const status = result
        ? undefined
        : !configured
          ? { tone: '', text: t.missing }
          : storedProblem
            ? { tone: 'bad', text: t.storedBroken(storedProblem) }
            : count === undefined
              ? { tone: 'ok', text: t.checking }
              : { tone: 'ok', text: t.ready(count) };

      return h('div', { className: 'mgo-card' }, [
        h('div', { key: 'head', className: 'mgo-head' }, [
          h('label', { key: 'label', className: 'mgo-label', htmlFor: 'mgo-key' }, t.label),
          h('a', { key: 'link', className: 'mgo-link', href: CONSOLE_URL, target: '_blank', rel: 'noreferrer' }, `${t.getKey} ↗`),
        ]),
        h('form', {
          key: 'row',
          className: 'mgo-row',
          onSubmit: (event) => { event.preventDefault(); if (!busy) void save(); },
        }, [
          h('input', {
            key: 'input',
            id: 'mgo-key',
            className: 'mgo-input',
            type: 'password',
            autoComplete: 'new-password',
            spellCheck: false,
            value: key,
            disabled: busy,
            placeholder: configured ? t.placeholderReplace : t.placeholder,
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
        status
          ? h('div', { key: 'status', className: 'mgo-status', role: 'status' }, [
            h('span', { key: 'dot', className: `mgo-dot ${status.tone}` }),
            h('span', { key: 'text' }, status.text),
          ])
          : h('div', { key: 'result', className: `mgo-msg ${result.kind}`, role: result.kind === 'bad' ? 'alert' : 'status' }, result.text),
      ]);
    }

    /** The plugin's own page under Plugins: the key field, so setup finishes where install ended. */
    function ModelGoConfigPage(props) {
      if (props.view === 'summary') return strings().summary;
      return h(ModelGoCard, { modelgo: props.modelgo });
    }

    return {
      inject: ['slots', 'remote', 'remote.credentials', 'remote.llm'],
      apply(ctx) {
        ensureStyles();
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
