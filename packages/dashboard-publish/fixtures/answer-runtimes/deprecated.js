(function installAnswerPersistence() {
  const win = document.defaultView;
  if (win.AudioDashboardAnswers) return;
  const listeners = new WeakMap();
  function listen(remote, method, callback) {
    if (typeof remote[method] !== 'function') return;
    if (!listeners.has(remote)) listeners.set(remote, {});
    const hub = listeners.get(remote);
    if (!hub[method]) { hub[method] = []; remote[method]((...args) => hub[method].forEach(fn => fn(...args))); }
    hub[method].push(callback);
  }
  win.AudioDashboardAnswers = function ({ key, prefix = '', status, change }) {
    let remote;
    try { remote = win.__answerStore ?? win.parent?.__answerStore; } catch {}
    const account = remote != null;
    const owns = field => field !== '_prefs' && (prefix ? field.startsWith(prefix) : !field.startsWith('_notes:'));
    const id = document.querySelector('meta[name=dashboard-id]')?.content;
    key ||= 'dbx:' + id + (prefix ? '.notes' : '');
    const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const clone = value => JSON.parse(JSON.stringify(value));
    let values = {}, snapshot = {}, loading = account, localError = '', loadError = '';
    const pending = new Map(), sending = new Map(), touched = new Set(), failed = new Set(), retries = new Map();
    const queued = new Set(), fieldStatus = new Map();
    let statusTimer;
    function bridgeStatus() {
      if (!account) return '';
      if (typeof remote.status === 'function') {
        try {
          const text = remote.status();
          if (text === 'Saved') queued.clear();
          return typeof text === 'string' && text !== 'Saved' ? text : '';
        } catch { return 'Account sync status unavailable · keep this page open'; }
      }
      const states = [...queued].map(field => fieldStatus.get(prefix + field));
      if (queued.size) states.push(fieldStatus.get(''));
      const active = states.filter(text => text && text !== 'Saved');
      return active.find(text => text !== 'Saving…') || active[0] || '';
    }
    function report() {
      const bridgeText = bridgeStatus();
      const error = localError || loadError || (failed.size ? 'Account saving unavailable · retrying…' : '');
      const text = error || (loading ? 'Loading account answers…' : bridgeText || (pending.size || queued.size ? 'Saving answers to your account…' : account ? 'Answers saved to your account.' : 'Answers saved on this device only.'));
      status(text, Boolean(error || !account || bridgeText && bridgeText !== 'Saving…'));
      // Another tab can confirm a shared journal without emitting this bridge's callback.
      const watching = account && typeof remote.status === 'function' && (bridgeText || queued.size);
      if (watching && statusTimer === undefined && typeof win.setInterval === 'function') statusTimer = win.setInterval(report, 500);
      else if (!watching && statusTimer !== undefined) { win.clearInterval(statusTimer); statusTimer = undefined; }
    }
    if (!account) {
      try { values = record(JSON.parse(localStorage.getItem(key) || '{}')); delete values._prefs; }
      catch { localError = 'Storage unavailable · use Copy answers'; }
    }
    snapshot = clone(values);
    function apply(field, value) {
      if (value == null) { delete values[field]; delete snapshot[field]; }
      else { values[field] = clone(value); snapshot[field] = clone(value); }
      change(field, value);
    }
    function send(field) {
      if (sending.has(field)) return sending.get(field);
      if (!pending.has(field)) return Promise.resolve();
      win.clearTimeout(retries.get(field)); retries.delete(field);
      const item = pending.get(field);
      const delivery = Promise.resolve().then(async () => {
        let result;
        // Track the handoff before save can synchronously confirm through onStatus.
        queued.add(field);
        try { result = await remote.save(prefix + field, item.value); } catch {}
        sending.delete(field);
        if (result?.ok === true) {
          failed.delete(field);
          // A queued acknowledgement transfers durability to the bridge, not confirmation.
          if (result.queued !== true) queued.delete(field);
          if (pending.get(field) === item) pending.delete(field);
        } else { queued.delete(field); failed.add(field); retries.set(field, win.setTimeout(() => send(field), 3000)); }
        report();
        if (result?.ok === true && pending.has(field)) return send(field);
      });
      sending.set(field, delivery);
      return delivery;
    }
    function enqueue() {
      for (const field of pending.keys()) send(field);
    }
    async function flush() {
      // Finish handing edits to the bridge before the explicit lifecycle flush.
      if (pending.size) await Promise.all([...pending.keys()].map(send));
      try { await remote?.flush?.(); } catch {}
      report();
    }
    const ready = account ? Promise.resolve().then(async () => {
      for (;;) {
        let loaded;
        try { loaded = record(await remote.load()); }
        catch {
          loadError = 'Account answers unavailable · retrying…'; report();
          await new Promise(resolve => win.setTimeout(resolve, 3000));
          continue;
        }
        for (const [remoteField, value] of Object.entries(loaded)) {
          if (!owns(remoteField)) continue;
          const field = remoteField.slice(prefix.length);
          if (!touched.has(field)) apply(field, value);
        }
        loading = false; loadError = ''; report(); enqueue(); return;
      }
    }) : Promise.resolve();
    if (account) {
      listen(remote, 'onRemoteChange', (remoteField, value) => {
        if (!owns(remoteField)) return;
        const field = remoteField.slice(prefix.length);
        if (pending.has(field)) return;
        touched.add(field); apply(field, value);
      });
      listen(remote, 'onStatus', (field, text) => {
        fieldStatus.set(field, text);
        if (text === 'Saved') {
          if (!field) queued.clear();
          else if (owns(field)) queued.delete(field.slice(prefix.length));
        }
        report();
      });
    }
    win.addEventListener('pagehide', flush);
    win.addEventListener('online', flush);
    report();
    return {
      values, ready,
      save(next) {
        if (!account) {
          try {
            const raw = localStorage.getItem(key);
            let device = {}; try { device = record(JSON.parse(raw || '{}')); } catch {}
            const prefs = device._prefs;
            localStorage.setItem(key, JSON.stringify({ ...next, ...(prefs === undefined ? {} : { _prefs: prefs }) }));
            values = clone(next); snapshot = clone(next); localError = ''; report(); return true;
          } catch { localError = 'Storage unavailable · use Copy answers'; report(); return false; }
        }
        for (const field of new Set([...Object.keys(snapshot), ...Object.keys(next)])) {
          if (!owns(prefix + field) || JSON.stringify(snapshot[field]) === JSON.stringify(next[field])) continue;
          touched.add(field); pending.set(field, { value: clone(next[field] ?? null) });
        }
        values = clone(next); snapshot = clone(next); report(); enqueue(); return true;
      },
    };
  };
})();
