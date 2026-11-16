/* Settings sections that need the ORION server (live mode, signed in):
 * your account · emergency contacts · people · devices · activity log.
 * What each person sees follows their role; the server enforces the same rules on every request. */
'use strict';
(function () {
  const U = ORION.util, F = ORION.fmt, esc = U.esc, C = ORION.ui;
  const A = () => ORION.app;
  const api = (p, o) => A().source.api(p, o);
  const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
  const ROLES = ['viewer', 'member', 'admin', 'owner'];
  const ROLE_TXT = { viewer: 'Viewer — sees everything, changes nothing', member: 'Member — can acknowledge alerts and use the fan/buzzer', admin: 'Admin — manages devices, contacts, people and settings', owner: 'Owner — everything' };
  const me = () => A().source.user || { role: 'viewer' };
  const isAdmin = () => RANK[me().role] >= 2;
  const wrapTbl = (h) => `<div style="overflow-x:auto">${h}</div>`;
  const msg = (el, text, bad) => { const n = el.querySelector('.ls-msg'); if (n) { n.hidden = !text; n.className = 'ls-msg note' + (bad ? ' crit' : ''); n.textContent = text || ''; } };

  async function render(root) {
    const admin = isAdmin();
    const [contacts, prefs, users, devs, audit] = await Promise.all([
      api('/contacts'), api('/aura/preferences'), admin ? api('/users') : null, admin ? api('/devices') : api('/devices'), admin ? api('/audit?limit=50') : null,
    ]);
    const u = me();
    const push = (prefs.ok && prefs.data.push) || { critical: true, warning: true, degraded: true };
    let h = `<section class="card" data-sec="account"><h2>Your account</h2>
      ${C.kv([['Name', u.name], ['Email', u.email], ['Role', ROLE_TXT[u.role] || u.role]])}
      <h3>Phone notifications</h3><p class="hint">Which alerts the ORION Android app may push to your phone. Local alarms and SMS never depend on this.</p>
      <form data-la="push" class="stack" style="gap:6px">${[['critical', 'Emergencies (smoke, flame — critical)'], ['warning', 'Warnings (water, smoke warning, high temperature)'], ['degraded', 'Connection problems (sensor, controller or GSM offline)']]
        .map(([k, l]) => `<label class="chk"><input type="checkbox" name="${k}" ${push[k] !== false ? 'checked' : ''}> ${l}</label>`).join('')}
        <div class="row-btns"><button class="btn sm" type="submit">Save notifications</button></div><div class="ls-msg note" hidden></div></form>
      <h3>Change password</h3><form data-la="password" class="fgrid" autocomplete="off">
        <label class="fld"><span>Current password</span><input type="password" name="cur" autocomplete="current-password" required></label>
        <label class="fld"><span>New password</span><input type="password" name="new" autocomplete="new-password" minlength="10" required><small>10+ characters, upper and lower case, a digit</small></label>
        <div class="row-btns" style="align-self:end"><button class="btn sm" type="submit">Change password</button></div><div class="ls-msg note" hidden style="grid-column:1/-1"></div></form></section>`;

    h += `<section class="card" data-sec="contacts"><h2>Emergency contacts</h2>
      <p class="hint">The ORION gateway texts and calls these numbers itself when it detects a flame — even without internet. Changes are sent to the gateway when it is connected; it keeps them after a restart. Up to 5 contacts; the first one marked “call” is phoned.</p>
      ${contacts.ok && contacts.data.length ? wrapTbl(`<table class="tbl"><thead><tr><th>Name</th><th>Number</th><th>SMS</th><th>Call</th>${admin ? '<th></th>' : ''}</tr></thead><tbody>${contacts.data.map((c) => `<tr><td>${esc(c.name)}</td><td class="mono">${esc(c.phone)}</td><td>${c.sms ? 'Yes' : '—'}</td><td>${c.call ? 'Yes' : '—'}</td>${admin ? `<td><button class="btn sm ghost" data-la="del-contact" data-id="${esc(c.id)}" type="button">Remove</button></td>` : ''}</tr>`).join('')}</tbody></table>`) : '<p class="hint">No contacts yet — no one will be texted or called.</p>'}
      ${admin ? `<form data-la="add-contact" class="fgrid" autocomplete="off">
        <label class="fld"><span>Name</span><input name="name" maxlength="80" required></label>
        <label class="fld"><span>Phone (international)</span><input name="phone" placeholder="+91XXXXXXXXXX" pattern="\\+[1-9][0-9]{7,14}" maxlength="16" required inputmode="tel"></label>
        <div class="stack" style="gap:4px;align-self:end"><label class="chk"><input type="checkbox" name="sms" checked> Text message</label><label class="chk"><input type="checkbox" name="call"> Phone call</label></div>
        <div class="row-btns" style="align-self:end"><button class="btn sm" type="submit">Add contact</button></div><div class="ls-msg note" hidden style="grid-column:1/-1"></div></form>` : '<p class="hint">Only an admin can change contacts.</p>'}</section>`;

    if (admin && users && users.ok) {
      h += `<section class="card" data-sec="people"><h2>People</h2><p class="hint">Who can use ORION. You can change people with a lower role than yours.</p>
        ${wrapTbl(`<table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th></th></tr></thead><tbody>${users.data.map((p) => {
          const editable = p.id !== u.id && (u.role === 'owner' || RANK[p.role] < RANK[u.role]);
          const opts = ROLES.filter((r) => u.role === 'owner' || RANK[r] < RANK[u.role]);
          return `<tr data-uid="${esc(p.id)}"><td>${esc(p.name)}</td><td class="mono">${esc(p.email)}</td>
            <td>${editable ? `<select name="role" aria-label="Role for ${esc(p.name)}">${opts.map((r) => `<option ${r === p.role ? 'selected' : ''}>${r}</option>`).join('')}</select>` : esc(p.role)}</td>
            <td>${editable ? `<input type="checkbox" name="active" aria-label="Active" ${p.is_active ? 'checked' : ''}>` : (p.is_active ? 'Yes' : 'No')}</td>
            <td>${editable ? '<button class="btn sm ghost" data-la="save-user" type="button">Save</button>' : (p.id === u.id ? '<span class="hint">you</span>' : '')}</td></tr>`;
        }).join('')}</tbody></table>`)}
        <h3>Add a person</h3><form data-la="add-user" class="fgrid" autocomplete="off">
          <label class="fld"><span>Name</span><input name="name" maxlength="80" required></label>
          <label class="fld"><span>Email</span><input name="email" type="email" maxlength="254" required></label>
          <label class="fld"><span>Role</span><select name="role">${ROLES.filter((r) => u.role === 'owner' || RANK[r] < RANK[u.role]).map((r) => `<option ${r === 'member' ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
          <label class="fld"><span>First password</span><input name="password" type="password" minlength="10" autocomplete="new-password" required><small>Tell them in person; they can change it here.</small></label>
          <div class="row-btns" style="align-self:end"><button class="btn sm" type="submit">Add person</button></div><div class="ls-msg note" hidden style="grid-column:1/-1"></div></form></section>`;
    }

    if (devs && devs.ok) {
      const d = devs.data;
      h += `<section class="card" data-sec="devices"><h2>Registered devices</h2>
        ${d.devices.length ? wrapTbl(`<table class="tbl"><thead><tr><th>Device</th><th>Type</th><th>Last seen</th><th>Data</th>${u.role === 'owner' ? '<th></th>' : ''}</tr></thead><tbody>${d.devices.map((x) => `<tr><td>${esc(x.name)} <span class="hint mono">${esc(x.id)}</span></td><td>${x.is_gateway ? 'Gateway (ESP32)' : 'Controller (UNO)'}</td><td>${x.last_seen_at ? esc(F.ago(x.last_seen_at)) : 'never'}</td><td>${x.simulated ? '<span class="tag-demo">simulated</span>' : 'hardware'}</td>${u.role === 'owner' && x.is_gateway ? `<td><button class="btn sm ghost" data-la="del-device" data-id="${esc(x.id)}" type="button">Remove</button></td>` : u.role === 'owner' ? '<td></td>' : ''}</tr>`).join('')}</tbody></table>`) + `<p class="hint">${d.sensors.length} sensors: ${d.sensors.map((s) => esc(s.label + (s.room ? ' · ' + s.room : ''))).join(', ')}</p>` : '<p class="hint">No devices yet. Register your ESP32 gateway below.</p>'}
        ${admin ? `<details class="more"${d.devices.length ? '' : ' open'}><summary>Register a gateway</summary>
          <p class="hint">Use the same ids in the ESP32's <span class="mono">secrets.h</span>. The broker password is shown once.</p>
          <form data-la="register" class="fgrid" autocomplete="off">
            ${[['gw', 'Gateway id (ESP32)', 'esp32-01'], ['ctrl', 'Controller id (UNO)', 'uno-01'], ['gsm', 'GSM module id', 'gsm-01'], ['mq2', 'MQ-2 sensor id', 'mq2-01'], ['mq2room', 'MQ-2 room', 'Hall'], ['flame', 'Flame sensor id', 'flame-01'], ['flameroom', 'Flame room', 'Kitchen'], ['water', 'Water sensor id', 'water-01'], ['waterroom', 'Water room', 'Utility area'], ['dht', 'DHT22 id', 'dht-01'], ['dhtroom', 'DHT22 room', 'Living room']]
              .map(([n, l, v]) => `<label class="fld"><span>${l}</span><input name="${n}" value="${v}" maxlength="63" required></label>`).join('')}
            <label class="chk" style="align-self:end"><input type="checkbox" name="sim"> Device simulator (data marked simulated)</label>
            <div class="row-btns" style="align-self:end"><button class="btn sm" type="submit">Register</button></div><div class="ls-msg note" hidden style="grid-column:1/-1"></div></form>
          <div data-la-out="register"></div></details>` : ''}</section>`;
    }

    if (admin && audit && audit.ok) {
      h += `<section class="card" data-sec="audit"><details class="more"><summary>Activity log (last ${audit.data.length})</summary>
        ${wrapTbl(`<table class="tbl"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Target</th></tr></thead><tbody>${audit.data.map((a) => `<tr><td class="mono">${esc(F.dt(a.at))}</td><td>${esc(a.actor_type)}</td><td class="mono">${esc(a.action)}</td><td class="mono">${esc(a.target)}</td></tr>`).join('')}</tbody></table>`)}</details></section>`;
    }
    root.innerHTML = h;
  }

  const fd = (f) => Object.fromEntries(new FormData(f).entries());

  async function onSubmit(e, root) {
    const f = e.target.closest('form[data-la]'); if (!f) return;
    e.preventDefault();
    const kind = f.dataset.la, v = fd(f);
    let r;
    if (kind === 'push') {
      const cur = await api('/aura/preferences');
      const body = Object.assign({}, cur.ok ? cur.data : {}, { push: { critical: !!v.critical, warning: !!v.warning, degraded: !!v.degraded } });
      r = await api('/aura/preferences', { method: 'PUT', body });
      return msg(f, r.ok ? 'Saved.' : r.error, !r.ok);
    }
    if (kind === 'password') {
      r = await api('/users/me/password', { method: 'POST', body: { current_password: v.cur, new_password: v.new } });
      if (r.ok) { f.reset(); return msg(f, 'Password changed. Your other devices have been signed out.'); }
      return msg(f, r.error, true);
    }
    if (kind === 'add-contact') {
      r = await api('/contacts', { method: 'POST', body: { name: v.name.trim(), phone: v.phone.trim(), sms: !!v.sms, call: !!v.call } });
      if (!r.ok) return msg(f, r.error, true);
      A().toast(r.data.gateways_updated ? 'Contact added and sent to the gateway.' : 'Contact added. It will reach the gateway when the gateway is connected.');
      return render(root);
    }
    if (kind === 'add-user') {
      r = await api('/users', { method: 'POST', body: { name: v.name.trim(), email: v.email.trim(), role: v.role, password: v.password } });
      if (!r.ok) return msg(f, r.error, true);
      A().toast(`${r.data.name} can now sign in as ${r.data.role}.`);
      return render(root);
    }
    if (kind === 'register') {
      const sensors = [['mq2', 'mq2', 'MQ-2 smoke / gas'], ['flame', 'flame', 'Flame sensor'], ['water', 'water', 'Water sensor'], ['dht', 'dht22', 'DHT22 temperature / humidity']]
        .map(([k, type, label]) => ({ id: v[k].trim(), type, label, room: (v[k + 'room'] || '').trim() }));
      r = await api('/devices/gateways', { method: 'POST', body: { id: v.gw.trim(), name: v.sim ? 'ESP32 (simulator)' : 'ESP32', simulated: !!v.sim, gsm_module_id: v.gsm.trim(), controllers: [{ id: v.ctrl.trim(), name: v.sim ? 'Arduino UNO (simulator)' : 'Arduino UNO', sensors }] } });
      if (!r.ok) return msg(f, r.error, true);
      const m = r.data.mqtt;
      await render(root);
      const out = root.querySelector('[data-la-out="register"]');
      if (out) {
        out.closest('details').open = true;
        out.innerHTML = `<div class="note" role="status"><b>Registered ${esc(r.data.gateway_id)}.</b> Copy the broker password now — it is not shown again.
          ${C.kv([['MQTT username', m.username], ['MQTT password', `<span class="mono" data-secret>${esc(m.password)}</span> <button class="btn sm ghost" data-la="copy" type="button">Copy</button>`, true]])}
          <p class="hint">${r.data.broker_account_created ? 'The broker account was created automatically. Next: put this password in the ESP32’s <span class="mono">secrets.h</span> as MQTT_PASSWORD and flash it.' : `Next: add it to the broker (<span class="mono">python3 scripts/mqtt_passwd.py deployment/mosquitto/passwd ${esc(m.username)}</span>, then restart the broker) and put it in the ESP32’s <span class="mono">secrets.h</span> as MQTT_PASSWORD.`}</p></div>`;
      }
      if (A().source.refetch) A().source.refetch();
    }
  }

  async function onClick(e, root) {
    const b = e.target.closest('[data-la]'); if (!b || b.tagName === 'FORM') return;
    const kind = b.dataset.la;
    if (kind === 'del-contact') {
      if (!window.confirm('Remove this emergency contact? The gateway will stop texting/calling it.')) return;
      const r = await api('/contacts/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' });
      A().toast(r.ok ? 'Contact removed.' : 'Not removed: ' + r.error, r.ok ? '' : 'bad');
      return render(root);
    }
    if (kind === 'save-user') {
      const tr = b.closest('tr');
      const r = await api('/users/' + encodeURIComponent(tr.dataset.uid), { method: 'PATCH', body: { role: tr.querySelector('[name=role]').value, is_active: tr.querySelector('[name=active]').checked } });
      A().toast(r.ok ? 'Saved. They will need to sign in again.' : 'Not saved: ' + r.error, r.ok ? '' : 'bad');
      return render(root);
    }
    if (kind === 'del-device') {
      if (!window.confirm(`Remove ${b.dataset.id} and everything behind it? Its history stays; it will no longer be able to report.`)) return;
      const r = await api('/devices/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' });
      A().toast(r.ok ? 'Device removed.' : 'Not removed: ' + r.error, r.ok ? '' : 'bad');
      if (A().source.refetch) A().source.refetch();
      return render(root);
    }
    if (kind === 'copy') {
      const t = root.querySelector('[data-secret]');
      try { await navigator.clipboard.writeText(t.textContent); A().toast('Copied.'); } catch (err) { const r = document.createRange(); r.selectNodeContents(t); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); A().toast('Select and copy the password.'); }
    }
  }

  function mount(root) {
    if (!root) return;
    root.innerHTML = C.skeleton(2);
    root.addEventListener('submit', (e) => onSubmit(e, root));
    root.addEventListener('click', (e) => onClick(e, root));
    render(root).catch((e) => { root.innerHTML = C.statePanel('error', 'Could not load server settings', String(e && e.message || e)); });
  }

  ORION.liveSettings = { mount };
})();
