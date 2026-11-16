/* ORION SVG time-series charts: readable axes, units, thresholds, incident markers, gap breaks, hover readout. */
'use strict';
(function () {
  const U = ORION.util, F = ORION.fmt;
  const reg = {};
  let cid = 0;

  function tzOffsetMs(tz) {
    try {
      const d = new Date();
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
      const g = (t) => +p.find((x) => x.type === t).value;
      const asUTC = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
      return asUTC - (d.getTime() - d.getMilliseconds());
    } catch (e) { return 0; }
  }
  function niceStep(span, n) {
    const raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }
  const TSTEPS = [60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3];

  function segments(points) {
    const segs = []; let cur = [];
    for (let k = 0; k < points.length; k++) {
      const p = points[k], prev = points[k - 1];
      if (p.v == null) { if (cur.length) segs.push(cur); cur = []; continue; }
      if (prev && prev.v != null) {
        const gapLim = Math.max(10e3, 3 * Math.max(prev.i || 60e3, p.i || 60e3));
        if (p.t - prev.t > gapLim) { if (cur.length) segs.push(cur); cur = []; }
      }
      cur.push(p);
    }
    if (cur.length) segs.push(cur);
    return segs;
  }
  function decimate(seg, max) {
    if (seg.length <= max) return seg;
    const k = Math.ceil(seg.length / (max / 2)); const out = [];
    for (let s = 0; s < seg.length; s += k) {
      const ch = seg.slice(s, s + k); let lo = ch[0], hi = ch[0];
      for (const p of ch) { if (p.v < lo.v) lo = p; if (p.v > hi.v) hi = p; }
      if (lo.t <= hi.t) { out.push(lo); if (hi !== lo) out.push(hi); } else { out.push(hi); out.push(lo); }
    }
    return out;
  }

  /* opts: { points, from, to, unit, dp, color, thresholds:[{v,label,sev}], markers:[{t0,t1,sev,label}], step, height, yMin, yMax, title, emptyText } */
  function render(opts) {
    const id = 'ch' + (++cid);
    const W = Math.max(300, Math.round(opts.width || 860)), H = opts.height || 240, L = 52, R = 16, T = 18, B = 30;
    const iw = W - L - R, ih = H - T - B;
    const pts = opts.points || [];
    const valid = pts.filter((p) => p.v != null);
    const tz = ORION.app.config.timezone;
    if (!valid.length) {
      return `<div class="chart-empty" role="img" aria-label="${U.esc(opts.title || 'chart')}: no data"><div class="ce-icon">∅</div><div>${U.esc(opts.emptyText || 'No stored readings in this time range.')}</div></div>`;
    }
    let lo = opts.yMin != null ? opts.yMin : Math.min(...valid.map((p) => p.v));
    let hi = opts.yMax != null ? opts.yMax : Math.max(...valid.map((p) => p.v));
    for (const t of opts.thresholds || []) if (t.v != null && opts.yMax == null) { hi = Math.max(hi, t.v); lo = Math.min(lo, t.v); }
    if (hi === lo) { hi += 1; lo -= 1; }
    if (opts.yMin == null) { const pad = (hi - lo) * 0.1; lo -= pad; hi += pad; }
    const ys = niceStep(hi - lo, 4);
    lo = Math.floor(lo / ys) * ys; hi = Math.ceil(hi / ys) * ys;
    const x = (t) => L + ((t - opts.from) / (opts.to - opts.from)) * iw;
    const y = (v) => T + ih - ((v - lo) / (hi - lo)) * ih;
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" id="${id}" role="img" aria-label="${U.esc(opts.title || '')} chart, ${U.esc(F.dt(opts.from))} to ${U.esc(F.dt(opts.to))}, unit ${U.esc(opts.unit)}">`;
    // markers (incidents)
    for (const m of opts.markers || []) {
      const a = Math.max(opts.from, m.t0), b = Math.min(opts.to, m.t1 || opts.to);
      if (b < opts.from || a > opts.to) continue;
      const xa = x(a), xb = Math.max(x(b), xa + 2);
      svg += `<rect x="${xa.toFixed(1)}" y="${T}" width="${(xb - xa).toFixed(1)}" height="${ih}" class="mk mk-${m.sev}"><title>${U.esc(m.label)}</title></rect>`;
      svg += `<line x1="${xa.toFixed(1)}" x2="${xa.toFixed(1)}" y1="${T}" y2="${T + ih}" class="mkl mk-${m.sev}"/>`;
      svg += `<text x="${(xa + 3).toFixed(1)}" y="${T + 10}" class="mkt mkt-${m.sev}">${U.esc(m.short || m.sev.toUpperCase())}</text>`;
    }
    // y grid
    for (let v = lo; v <= hi + ys / 2; v += ys) {
      const yy = y(v).toFixed(1);
      svg += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="grid"/>`;
      svg += `<text x="${L - 8}" y="${+yy + 4}" class="axis" text-anchor="end">${opts.binary ? (v === 1 ? 'yes' : v === 0 ? 'no' : '') : +v.toFixed(ys < 1 ? 1 : 0)}</text>`;
    }
    svg += `<text x="${L - 8}" y="${T - 6}" class="axis unit" text-anchor="end">${U.esc(opts.unit)}</text>`;
    // x ticks aligned to local time
    const span = opts.to - opts.from;
    const tstep = TSTEPS.find((s) => span / s <= 7) || 86400e3;
    const off = tzOffsetMs(tz);
    let t0 = Math.ceil((opts.from + off) / tstep) * tstep - off;
    for (let t = t0; t <= opts.to; t += tstep) {
      const xx = x(t).toFixed(1);
      svg += `<line x1="${xx}" x2="${xx}" y1="${T}" y2="${T + ih}" class="grid v"/>`;
      const lab = tstep >= 86400e3 ? F.day(t) : (span > 86400e3 ? F.day(t) + ' ' + F.hm(t) : F.hm(t));
      svg += `<text x="${xx}" y="${H - 10}" class="axis" text-anchor="middle">${U.esc(lab)}</text>`;
    }
    // thresholds
    for (const th of opts.thresholds || []) {
      if (th.v == null || th.v < lo || th.v > hi) continue;
      const yy = y(th.v).toFixed(1);
      svg += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="thr thr-${th.sev}"/>`;
      svg += `<text x="${W - R - 4}" y="${+yy - 4}" class="thrt thr-${th.sev}" text-anchor="end">${U.esc(th.label)}</text>`;
    }
    // data + gap shading
    const segs = segments(pts.filter((p) => p.t >= opts.from && p.t <= opts.to));
    for (let s = 1; s < segs.length; s++) {
      const a = segs[s - 1][segs[s - 1].length - 1].t, b = segs[s][0].t;
      const xa = x(a), xb = x(b);
      if (xb - xa < 1) continue;
      svg += `<rect x="${xa.toFixed(1)}" y="${T}" width="${(xb - xa).toFixed(1)}" height="${ih}" class="gap"><title>No data ${U.esc(F.dt(a))} – ${U.esc(F.dt(b))}</title></rect>`;
      if (xb - xa > 34) svg += `<text x="${((xa + xb) / 2).toFixed(1)}" y="${T + ih - 6}" class="gapt" text-anchor="middle">no data</text>`;
    }
    for (const seg of segs) {
      const d = decimate(seg, 1400);
      let path = '';
      d.forEach((p, k) => {
        const xx = x(p.t).toFixed(1), yy = y(p.v).toFixed(1);
        if (k === 0) path += `M${xx},${yy}`;
        else if (opts.step) path += `H${xx}V${yy}`;
        else path += `L${xx},${yy}`;
      });
      if (d.length === 1) svg += `<circle cx="${x(d[0].t).toFixed(1)}" cy="${y(d[0].v).toFixed(1)}" r="2.5" fill="${opts.color}"/>`;
      svg += `<path d="${path}" fill="none" stroke="${opts.color}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
    }
    svg += `<line class="xh" x1="0" x2="0" y1="${T}" y2="${T + ih}" style="display:none"/><circle class="xhd" r="3.5" fill="${opts.color}" style="display:none"/>`;
    svg += `<rect x="${L}" y="${T}" width="${iw}" height="${ih}" fill="transparent" class="hit" data-chart="${id}"/>`;
    svg += '</svg>';
    reg[id] = { pts: valid, all: pts, from: opts.from, to: opts.to, L, iw, T, ih, lo, hi, W, unit: opts.unit, dp: opts.dp || 0, binary: opts.binary };
    return `<div class="chart-wrap">${svg}<div class="ctip" id="${id}-tip" hidden></div></div>`;
  }

  function onMove(ev) {
    const hit = ev.target.closest && ev.target.closest('.hit');
    if (!hit) return;
    const c = reg[hit.dataset.chart]; if (!c) return;
    const svg = hit.ownerSVGElement, box = svg.getBoundingClientRect();
    const sx = ((ev.clientX - box.left) / box.width) * c.W;
    const t = c.from + ((sx - c.L) / c.iw) * (c.to - c.from);
    let a = 0, b = c.pts.length - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (c.pts[m].t < t) a = m; else b = m; }
    const p = Math.abs(c.pts[a].t - t) < Math.abs(c.pts[b].t - t) ? c.pts[a] : c.pts[b];
    const tip = document.getElementById(hit.dataset.chart + '-tip');
    const xh = svg.querySelector('.xh'), dot = svg.querySelector('.xhd');
    const gapLim = Math.max(10e3, 3 * (p.i || 60e3));
    const px = c.L + ((p.t - c.from) / (c.to - c.from)) * c.iw;
    const py = c.T + c.ih - ((p.v - c.lo) / (c.hi - c.lo)) * c.ih;
    xh.setAttribute('x1', sx); xh.setAttribute('x2', sx); xh.style.display = '';
    let html;
    if (Math.abs(p.t - t) > gapLim) {
      dot.style.display = 'none';
      html = `<b>No data</b><span>${U.esc(F.dt(t))}</span>`;
    } else {
      dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.style.display = '';
      const val = c.binary ? (p.v ? 'detected' : 'not detected') : p.v.toFixed(c.dp) + ' ' + c.unit;
      html = `<b>${U.esc(val)}</b><span>${U.esc(F.dt(p.t))}</span><span class="muted">quality: ${U.esc(p.q)} · delay ${((p.r - p.t) / 1000).toFixed(1)} s</span>`;
    }
    tip.innerHTML = html; tip.hidden = false;
    const rel = (ev.clientX - box.left) / box.width;
    tip.style.left = rel > 0.65 ? '' : `calc(${(rel * 100).toFixed(1)}% + 12px)`;
    tip.style.right = rel > 0.65 ? `calc(${((1 - rel) * 100).toFixed(1)}% + 12px)` : '';
  }
  function onLeave(ev) {
    const hit = ev.target.closest && ev.target.closest('.hit');
    if (!hit) return;
    const svg = hit.ownerSVGElement;
    svg.querySelector('.xh').style.display = 'none'; svg.querySelector('.xhd').style.display = 'none';
    const tip = document.getElementById(hit.dataset.chart + '-tip'); if (tip) tip.hidden = true;
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseout', onLeave);

  /* compact sparkline for cards */
  function spark(points, color, from, to) {
    const v = points.filter((p) => p.v != null);
    if (v.length < 2) return '<div class="spark-empty">no recent history</div>';
    const W = 200, H = 36;
    let lo = Math.min(...v.map((p) => p.v)), hi = Math.max(...v.map((p) => p.v));
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    const segs = segments(points.filter((p) => p.t >= from));
    let d = '';
    for (const s of segs) decimate(s, 120).forEach((p, k) => {
      d += (k ? 'L' : 'M') + (((p.t - from) / (to - from)) * W).toFixed(1) + ',' + (H - 3 - ((p.v - lo) / (hi - lo)) * (H - 6)).toFixed(1);
    });
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>`;
  }

  ORION.charts = { render, spark, reset() { for (const k of Object.keys(reg)) delete reg[k]; } };
})();
