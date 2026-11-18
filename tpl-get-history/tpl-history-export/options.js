// options.js -- edit the web app URL, shared secret and download setting.
// Uses helpers from upload.js. Settings live in chrome.storage.local.

(() => {
  const $ = (id) => document.getElementById(id);

  function setMsg(text, cls = '') {
    $('msg').textContent = text;
    $('msg').className = cls;
  }

  function readForm() {
    return {
      url: $('url').value.trim(),
      secret: $('secret').value.trim(),
      alwaysDownload: $('alwaysDownload').checked,
    };
  }

  async function load() {
    const { settings, lastSync } = await chrome.storage.local.get(['settings', 'lastSync']);
    const s = settings || {};
    $('url').value = s.url || '';
    $('secret').value = s.secret || '';
    $('alwaysDownload').checked = !!s.alwaysDownload;
    $('last').textContent = formatLastSync(lastSync);
  }

  async function save() {
    const s = readForm();
    const problems = checkSettings(s);
    if (problems.length) {
      setMsg(`Not saved: ${problems.join('; ')}.`, 'err');
      return;
    }
    await chrome.storage.local.set({ settings: s });
    setMsg('Saved.', 'ok');
  }

  // GET the URL: doGet() is a health check. It confirms the URL and schema
  // version only; the secret is checked on the first upload.
  async function test() {
    const { url } = readForm();
    const problems = checkSettings({ url, secret: 'x' });
    if (problems.length) {
      setMsg(`Cannot test: ${problems.join('; ')}.`, 'err');
      return;
    }
    setMsg('Testing...');
    try {
      const res = await fetch(url, {
        credentials: 'omit',
        cache: 'no-store',
        signal: AbortSignal.timeout(UPLOAD.HEALTH_TIMEOUT_MS),
      });
      const r = interpretHealth(res.status, await res.text());
      if (r.ok) setMsg('Web app reached. (The secret is checked on the first upload.)', 'ok');
      else setMsg(r.error, 'err');
    } catch (e) {
      setMsg(`Network error: ${e.message}`, 'err');
    }
  }

  $('save').addEventListener('click', save);
  $('test').addEventListener('click', test);
  $('show').addEventListener('click', () => {
    const hidden = $('secret').type === 'password';
    $('secret').type = hidden ? 'text' : 'password';
    $('show').textContent = hidden ? 'Hide' : 'Show';
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.lastSync) $('last').textContent = formatLastSync(changes.lastSync.newValue);
  });

  load();
})();
