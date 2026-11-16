/* Shared UI pieces: icons, plain-language status, small helpers. Status is always words + icon + colour. */
'use strict';
(function () {
  const U = ORION.util, F = ORION.fmt, esc = U.esc;

  const P = {
    smoke: '<path d="M7 17.5a4 4 0 0 1-.7-7.9A5.5 5.5 0 0 1 17 8.6a3.5 3.5 0 0 1 .4 7"/><path d="M8 21h9"/>',
    flame: '<path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3-1-3 0-6 1-8.5z"/>',
    water: '<path d="M12 3.5s6 6.2 6 10.5a6 6 0 0 1-12 0c0-4.3 6-10.5 6-10.5z"/><path d="M9 14.5a3 3 0 0 0 3 3"/>',
    temp: '<path d="M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>',
    hum: '<path d="M12 3.5s6 6.2 6 10.5a6 6 0 0 1-12 0c0-4.3 6-10.5 6-10.5z"/><path d="M9.5 16.5l5-5"/><circle cx="10" cy="12" r=".6"/><circle cx="14" cy="16" r=".6"/>',
    fan: '<circle cx="12" cy="12" r="1.6"/><path d="M12 10.4c0-4 1-6.4 3.4-6.4S18 7 13.4 11.3M13.6 12c4 0 6.4 1 6.4 3.4S17 18 12.7 13.4M12 13.6c0 4-1 6.4-3.4 6.4S6 17 10.6 12.7M10.4 12C6.4 12 4 11 4 8.6S7 6 11.3 10.6"/>',
    bell: '<path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    door: '<path d="M6 21V4h11v17"/><path d="M4 21h16"/><circle cx="14" cy="12.5" r=".9"/>',
    bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
    relay: '<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M8 7V4M16 7V4M8 17v3M16 17v3"/>',
    mist: '<path d="M4 9h10M4 13h16M7 17h10M9 5h6"/>',
    servo: '<rect x="4" y="8" width="12" height="9" rx="1.5"/><circle cx="10" cy="12.5" r="2"/><path d="M16 11h4"/>',
    chip: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M9 4v3M15 4v3M9 17v3M15 17v3M4 9h3M4 15h3M17 9h3M17 15h3"/>',
    wifi: '<path d="M4.5 10.5a10.5 10.5 0 0 1 15 0M7.5 13.5a6.5 6.5 0 0 1 9 0"/><circle cx="12" cy="17.5" r="1.1"/>',
    signal: '<path d="M5 19v-3M10 19v-7M15 19v-11M20 19V4"/>',
    home: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-5h4v5"/>',
    chart: '<path d="M4 19h16"/><path d="M6 15l4-5 3 3 5-7"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
    sliders: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.2"/><circle cx="15" cy="17" r="2.2"/>',
    aura: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    speaker: '<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16 9.2a4 4 0 0 1 0 5.6M18.6 6.6a7.8 7.8 0 0 1 0 10.8"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
    send: '<path d="M4.5 12L20 4.5l-6.2 15.5-2.6-6.6z"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.5"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z"/>',
    off: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    wave: '<path d="M4 11v2M8 8v8M12 5v14M16 8v8M20 11v2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  };
  const icon = (n, cls) => `<svg class="ic ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || P.dot}</svg>`;

  /* Plain-language overall state */
  const PLAIN = {
    NORMAL: { cls: 'ok', icon: 'check', title: 'All good', sub: 'Every sensor is reporting and nothing needs your attention.' },
    ATTENTION: { cls: 'warn', icon: 'alert', title: 'Needs attention', sub: '' },
    EMERGENCY: { cls: 'crit', icon: 'alert', title: 'Emergency', sub: '' },
    DEGRADED: { cls: 'degr', icon: 'info', title: 'Partly offline', sub: 'Some sensors or devices aren’t reporting, so ORION can’t fully see your home.' },
    OFFLINE: { cls: 'off', icon: 'off', title: 'Offline', sub: 'ORION can’t reach your home. Values shown are the last ones received.' },
    LOADING: { cls: 'off', icon: 'clock', title: 'Connecting…', sub: 'Waiting for the first data.' },
  };
  const SEV = { critical: { cls: 'crit', word: 'Danger' }, warning: { cls: 'warn', word: 'Warning' }, degraded: { cls: 'degr', word: 'Connection' }, info: { cls: 'info', word: 'Info' } };

  /* One plain sentence for an incident */
  function incidentSentence(i) {
    const room = (i.source_label.split(' · ')[1]) || '';
    const at = room ? ` in the ${room.toLowerCase()}` : '';
    switch (i.type) {
      case 'smoke': return i.severity === 'critical' ? `Smoke or gas at danger level${at}` : `Smoke or gas detected${at}`;
      case 'flame': return `Flame detected${at}`;
      case 'water': return `Water detected${at}`;
      case 'sensor_stale': return `${i.source_label.split(' · ')[0]} stopped reporting`;
      case 'sensor_fault': return `${i.source_label.split(' · ')[0]} reported a fault`;
      case 'controller': return `${i.source_label} is not responding`;
      case 'gsm': return 'GSM module has no network — text and call alerts can’t be sent';
      default: return i.source_label;
    }
  }

  const chip = (cls, text, ic) => `<span class="chip-s s-${cls}">${ic ? icon(ic) : '<i class="d"></i>'}${esc(text)}</span>`;
  const demoTag = () => '<span class="tag-demo">demo</span>';

  function statePanel(kind, title, body, extra) {
    const ic = { loading: 'clock', empty: 'info', error: 'x', unconfigured: 'off' }[kind] || 'info';
    return `<div class="state-panel sp-${kind}" role="status">${icon(ic)}<div><div class="sp-t">${esc(title)}</div><div class="sp-b">${esc(body)}</div>${extra || ''}</div></div>`;
  }
  function skeleton(n) { let s = ''; for (let k = 0; k < (n || 3); k++) s += '<div class="skel"></div>'; return `<div class="skel-wrap" aria-busy="true" aria-label="Loading">${s}</div>`; }
  function guard(ev, n) {
    if (!ev || ev.system === 'LOADING') return skeleton(n);
    if (ev.backendError) return statePanel('error', 'Can’t load data', 'The ORION server returned an error. Nothing is shown rather than guessing.', ORION.app.lastOkAt ? `<div class="sp-x">Last good update: ${esc(F.dt(ORION.app.lastOkAt))}</div>` : '');
    if (ev.noData) return statePanel('empty', 'No data yet', 'Nothing has been received from the home yet. Readings appear here once the ESP32 starts sending.');
    if (ev.unconfigured) return statePanel('unconfigured', 'Live data not connected yet', 'A live backend arrives in Phase 2. Switch to demo to explore ORION.', '<div class="sp-x"><button class="btn sm" data-action="mode" data-mode="demo">Use demo data</button></div>');
    return null;
  }
  function kv(rows) {
    return '<dl class="kv">' + rows.filter(Boolean).map(([k, v, raw]) => `<dt>${esc(k)}</dt><dd>${raw ? v : esc(v)}</dd>`).join('') + '</dl>';
  }
  const CMDWORD = { requested: ['info', 'Requested'], queued: ['info', 'Queued'], sent: ['info', 'Sent'], accepted: ['info', 'Accepted'], completed: ['ok', 'Completed'], unknown: ['degr', 'Done · unconfirmed'], failed: ['crit', 'Failed'], rejected: ['warn', 'Rejected'], expired: ['degr', 'Expired'] };
  const cmdChip = (s) => { const w = CMDWORD[s] || ['info', s]; return chip(w[0], w[1]); };

  ORION.ui = { icon, PLAIN, SEV, incidentSentence, chip, demoTag, statePanel, skeleton, guard, kv, cmdChip };
})();
