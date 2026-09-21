'use strict';

/* =======================================================================
   工大祭 設営ガント
   データは data/schedule.csv と data/layout.json のみ。ここには持たない。
   ======================================================================= */

/* ---- 色は班に固定で紐づける。変えるならここだけ ---- */
var TEAM_COLORS = {
  '映像': '#2563eb',
  '音響': '#0f766e',
  '照明': '#b45309',
  '全班': '#52525b'
};
var RESOURCE_COLOR = '#6b7280';
var WARN_COLOR = '#b91c1c';
var SHARED_LANE = '共有リソース';
var TEAM_ORDER = ['映像', '音響', '照明', '全班'];
var CROWDED = 3;   /* 同一エリアに何班以上で警告にするか */

/* ---- ガントの描画寸法 ---- */
var PAD_L = 92;   /* レーン名の幅 */
var PAD_R = 20;
var PAD_T = 62;   /* 時間軸＋マイルストーン名 */
var PAD_B = 16;
var PX_PER_MIN = 2.6;
var BAR_H = 26;
var BAR_GAP = 5;
var LANE_PAD = 7;
var SNAP = 15;    /* 時間軸の最小刻み(分)。3ビュー共通 */

var SVG_NS = 'http://www.w3.org/2000/svg';

/* =====================  時刻ユーティリティ  ===================== */

function toMin(hhmm) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function addMin(hhmm, delta) {
  var t = toMin(hhmm);
  if (t === null) return hhmm;
  return fmtMin(Math.max(0, Math.min(24 * 60 - 1, t + delta)));
}

function fmtMin(min) {
  var h = Math.floor(min / 60);
  var m = min % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

/* =====================  CSV パーサ  ===================== */
/* RFC4180 相当。Excel が付ける引用符と改行に耐える。 */

function parseCsv(text) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  var i = 0;
  text = text.replace(/^﻿/, '');          /* Excel の BOM */

  while (i < text.length) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  row.push(field);
  rows.push(row);

  while (rows.length && rows[rows.length - 1].every(function (v) { return v.trim() === ''; })) {
    rows.pop();
  }
  if (!rows.length) return [];

  var header = rows.shift().map(function (h) { return h.trim(); });
  return rows.map(function (r) {
    var o = {};
    header.forEach(function (h, idx) { o[h] = (r[idx] === undefined ? '' : r[idx]).trim(); });
    return o;
  });
}

/* =====================  データ整形  ===================== */

function splitList(s, sep) {
  if (!s) return [];
  return s.split(sep).map(function (v) { return v.trim(); }).filter(Boolean);
}

function buildModel(csvText, layout) {
  var issues = [];
  var areaIds = {};
  (layout.areas || []).forEach(function (a) { areaIds[a.id] = a.name; });

  var rows = parseCsv(csvText);
  var items = [];
  var seen = {};

  rows.forEach(function (r, n) {
    var where = 'CSV ' + (n + 2) + '行目';
    if (!r.id) { issues.push(where + '：id が空です'); return; }
    if (seen[r.id]) { issues.push(where + '：id "' + r.id + '" が重複しています'); }
    seen[r.id] = true;

    var s = toMin(r.start);
    var e = toMin(r.end);
    if (s === null || e === null) {
      issues.push(where + '（' + r.id + '）：start / end が HH:MM ではありません');
      return;
    }
    var kind = (r.kind || '').toLowerCase();
    if (kind !== 'milestone' && kind !== 'resource') kind = 'task';
    if (kind !== 'milestone' && e <= s) {
      issues.push(where + '（' + r.id + '）：end が start 以前です');
      return;
    }
    if (kind === 'task' && !r.area) {
      issues.push(r.id + '：area が空です（平面図に出せません）');
    }
    if (kind !== 'milestone' && r.area && !areaIds[r.area]) {
      issues.push(r.id + '：area "' + r.area + '" が layout.json にありません');
    }
    if (!TEAM_COLORS[r.team]) {
      issues.push(r.id + '：team "' + r.team + '" は 映像 / 音響 / 照明 / 全班 のいずれかにしてください');
    }

    items.push({
      id: r.id,
      team: r.team,
      area: r.area,
      areaName: areaIds[r.area] || r.area,
      task: r.task,
      start: s,
      end: e,
      owners: splitList(r.owner, '・'),
      depends: splitList(r.depends, ','),
      note: r.note || '',
      kind: kind
    });
  });

  var byId = {};
  items.forEach(function (it) { byId[it.id] = it; });
  items.forEach(function (it) {
    it.depends.forEach(function (d) {
      if (!byId[d]) issues.push(it.id + '：depends の "' + d + '" が見つかりません');
    });
  });

  return { items: items, byId: byId, issues: issues, layout: layout };
}

/* 時間軸の範囲。15分単位に丸めて全体を包む。3ビューで必ずこれを使う。 */
function timeRange(items) {
  var min = Infinity, max = -Infinity;
  items.forEach(function (it) {
    if (it.start < min) min = it.start;
    if (it.end > max) max = it.end;
  });
  if (!isFinite(min)) { min = 8 * 60; max = 13 * 60; }
  return {
    start: Math.floor(min / SNAP) * SNAP,
    end: Math.ceil(max / SNAP) * SNAP
  };
}

/* ある時刻に動いているものを拾う（[start, end) で判定） */
function activeAt(items, t, kind) {
  return items.filter(function (i) {
    return i.kind === kind && i.start <= t && t < i.end;
  });
}

/* =====================  SVG ヘルパ  ===================== */

function el(name, attrs, parent) {
  var node = document.createElementNS(SVG_NS, name);
  if (attrs) {
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
  }
  if (parent) parent.appendChild(node);
  return node;
}

/* 日本語は SVG で折り返らない。入らない分は省略記号にする。 */
function fitText(node, str, maxW) {
  node.textContent = str;
  if (maxW <= 4) { node.textContent = ''; return; }
  var w = node.getComputedTextLength();
  /* 表示されていない間は幅が 0 で返る。フォントサイズから概算しておき、
     表示されたときに描き直して正確に詰める。 */
  if (w === 0 && str) {
    var fs = parseFloat(node.getAttribute('font-size')) || 11;
    var max = Math.floor(maxW / (fs * 0.92));
    if (str.length > max) node.textContent = str.slice(0, Math.max(0, max - 1)) + '…';
    return;
  }
  if (w <= maxW) return;
  var lo = 0, hi = str.length;
  while (lo < hi) {
    var mid = Math.ceil((lo + hi) / 2);
    node.textContent = str.slice(0, mid) + '…';
    if (node.getComputedTextLength() <= maxW) lo = mid; else hi = mid - 1;
  }
  node.textContent = lo > 0 ? str.slice(0, lo) + '…' : '';
}

/* 同じレーン内で時間が重なるものを段に振り分ける（重ねて隠さない） */
function packRows(items) {
  var rows = [];
  items.slice().sort(function (a, b) { return a.start - b.start || a.end - b.end; })
    .forEach(function (it) {
      for (var i = 0; i < rows.length; i++) {
        var last = rows[i][rows[i].length - 1];
        if (last.end <= it.start) { rows[i].push(it); return; }
      }
      rows.push([it]);
    });
  return rows;
}

/* =====================  ビュー1: 班別ガント  ===================== */

function renderTeamGantt(model, container) {
  var items = model.items;
  var range = timeRange(items);
  var span = range.end - range.start;
  var plotW = span * PX_PER_MIN;
  var width = PAD_L + plotW + PAD_R;

  var milestones = items.filter(function (i) { return i.kind === 'milestone'; })
    .sort(function (a, b) { return a.start - b.start; });

  var lanes = TEAM_ORDER.filter(function (team) {
    return items.some(function (i) { return i.kind === 'task' && i.team === team; });
  }).map(function (team) {
    return {
      name: team,
      color: TEAM_COLORS[team],
      rows: packRows(items.filter(function (i) { return i.kind === 'task' && i.team === team; }))
    };
  });

  var resources = items.filter(function (i) { return i.kind === 'resource'; });
  if (resources.length) {
    lanes.push({ name: SHARED_LANE, color: RESOURCE_COLOR, shared: true, rows: packRows(resources) });
  }

  var y = PAD_T;
  lanes.forEach(function (lane) {
    lane.y = y;
    lane.h = LANE_PAD * 2 + lane.rows.length * BAR_H + (lane.rows.length - 1) * BAR_GAP;
    y += lane.h;
  });
  var plotBottom = y;
  var height = plotBottom + PAD_B;

  var x = function (min) { return PAD_L + (min - range.start) * PX_PER_MIN; };

  container.innerHTML = '';
  var svg = el('svg', {
    viewBox: '0 0 ' + width + ' ' + height,
    role: 'img',
    'aria-label': '班別設営ガントチャート'
  }, container);

  var defs = el('defs', null, svg);
  var pat = el('pattern', {
    id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)'
  }, defs);
  el('rect', { width: 6, height: 6, fill: RESOURCE_COLOR }, pat);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#ffffff', 'stroke-width': 2, opacity: 0.45 }, pat);

  /* --- レーンの帯と名前 --- */
  lanes.forEach(function (lane, idx) {
    el('rect', {
      x: 0, y: lane.y, width: width, height: lane.h,
      fill: idx % 2 ? '#f6f7f9' : '#ffffff'
    }, svg);
    el('line', {
      x1: 0, y1: lane.y, x2: width, y2: lane.y, stroke: '#d6dae0', 'stroke-width': 1
    }, svg);
    var label = el('text', {
      x: PAD_L - 12, y: lane.y + lane.h / 2 + 5,
      'text-anchor': 'end', 'font-size': 13, 'font-weight': 'bold',
      fill: lane.shared ? '#374151' : lane.color
    }, svg);
    label.textContent = lane.name;
  });
  el('line', { x1: 0, y1: plotBottom, x2: width, y2: plotBottom, stroke: '#a8afb8' }, svg);
  el('line', { x1: PAD_L, y1: PAD_T - 22, x2: PAD_L, y2: plotBottom, stroke: '#a8afb8' }, svg);

  /* --- 時間軸 --- */
  for (var t = range.start; t <= range.end; t += SNAP) {
    var isHour = t % 60 === 0;
    var isHalf = t % 30 === 0;
    el('line', {
      x1: x(t), y1: PAD_T - 22, x2: x(t), y2: plotBottom,
      stroke: isHour ? '#c3c9d1' : '#e8ebef',
      'stroke-width': 1
    }, svg);
    if (isHalf) {
      var tick = el('text', {
        x: x(t), y: PAD_T - 28, 'text-anchor': 'middle',
        'font-size': isHour ? 12 : 10,
        'font-weight': isHour ? 'bold' : 'normal',
        fill: isHour ? '#1b1d21' : '#5b6169'
      }, svg);
      tick.textContent = fmtMin(t);
    }
  }

  /* --- マイルストーン：全レーン貫通の縦破線 --- */
  milestones.forEach(function (ms, i) {
    var mx = x(ms.start);
    el('line', {
      x1: mx, y1: PAD_T - 22, x2: mx, y2: plotBottom,
      stroke: WARN_COLOR, 'stroke-width': 1.5, 'stroke-dasharray': '6 4'
    }, svg);
    el('path', {
      d: 'M' + mx + ' ' + (PAD_T - 26) + ' l5 5 l-5 5 l-5 -5 z',
      fill: WARN_COLOR
    }, svg);
    var ly = i % 2 ? 22 : 10;   /* 近接するラベルを上下に振り分ける */
    var anchor = 'middle', lx = mx;
    if (mx > width - 60) { anchor = 'end'; lx = width - 4; }
    else if (mx < PAD_L + 60) { anchor = 'start'; lx = Math.max(4, mx - 4); }
    var lbl = el('text', {
      x: lx, y: ly, 'text-anchor': anchor, 'font-size': 11,
      fill: WARN_COLOR, 'font-weight': 'bold'
    }, svg);
    lbl.textContent = ms.task + ' ' + fmtMin(ms.start);
  });

  /* --- バー --- */
  lanes.forEach(function (lane) {
    lane.rows.forEach(function (row, ri) {
      var by = lane.y + LANE_PAD + ri * (BAR_H + BAR_GAP);
      row.forEach(function (it) {
        var bx = x(it.start);
        var bw = Math.max(3, (it.end - it.start) * PX_PER_MIN);
        var g = el('g', { 'data-id': it.id }, svg);

        var title = el('title', null, g);
        title.textContent = it.id + ' ' + it.task + '\n'
          + fmtMin(it.start) + '–' + fmtMin(it.end)
          + (it.areaName ? '\n場所：' + it.areaName : '')
          + (it.owners.length ? '\n担当：' + it.owners.join('・') : '')
          + (it.depends.length ? '\n前提：' + it.depends.join(', ') : '')
          + (it.note ? '\n備考：' + it.note : '');

        el('rect', {
          x: bx, y: by, width: bw, height: BAR_H, rx: 4,
          fill: lane.shared ? 'url(#hatch)' : TEAM_COLORS[it.team],
          stroke: lane.shared ? '#4b5563' : 'rgba(0,0,0,0.25)',
          'stroke-width': 1
        }, g);

        var inner = bw - 12;
        var twoLines = it.owners.length > 0;
        var nameNode = el('text', {
          x: bx + 6, y: by + (twoLines ? 12 : 17),
          'font-size': 11, 'font-weight': 'bold', fill: '#ffffff'
        }, g);
        fitText(nameNode, it.task, inner);

        if (twoLines) {
          var ownerNode = el('text', {
            x: bx + 6, y: by + 22, 'font-size': 9.5, fill: 'rgba(255,255,255,0.92)'
          }, g);
          fitText(ownerNode, it.owners.join('・'), inner);
        }
      });
    });
  });

  return { range: range, width: width, height: height };
}

/* =====================  ビュー3: 平面図タイムライン  ===================== */
/* layout.json の座標でホールを描き、時刻ごとに各エリアにいる班を塗り分ける。 */

var CHIP_H = 17;
var CHIP_GAP = 3;
var CHIP_TOP = 26;   /* エリア名の下から積む */

function FloorView(model, opts) {
  this.t = null;
  this.timer = null;
  this.areaNodes = {};
  this.svgHost = opts.svg;
  this.listHost = opts.list;
  this.slider = opts.slider;
  this.clock = opts.clock;
  this.playBtn = opts.playBtn;
  this.bindControls();
  this.setModel(model);
}

FloorView.prototype.steps = function () {
  return Math.round((this.range.end - this.range.start) / SNAP);
};

/* データが差し替わったとき。見ている時刻はできるだけ保つ。 */
FloorView.prototype.setModel = function (model) {
  var keep = this.t;
  this.pause();
  this.model = model;
  this.range = timeRange(model.items);
  this.slider.min = 0;
  this.slider.max = this.steps();
  this.slider.step = 1;
  this.buildPlan();
  var t = this.range.start;
  if (keep !== null) {
    t = Math.min(Math.max(keep, this.range.start), this.range.end);
    t = this.range.start + Math.round((t - this.range.start) / SNAP) * SNAP;
  }
  this.setTime(t);
};

/* スライダーと再生ボタンの配線は1回だけ。作り直しても二重にしない。 */
FloorView.prototype.bindControls = function () {
  var self = this;
  this.slider.addEventListener('input', function () {
    self.pause();
    self.setTime(self.range.start + parseInt(self.slider.value, 10) * SNAP);
  });
  this.playBtn.addEventListener('click', function () {
    if (self.timer) self.pause(); else self.play();
  });
};

/* 平面図の器を組み立てる。時刻が動くたびには作り直さない。 */
FloorView.prototype.buildPlan = function () {
  var self = this;
  var layout = this.model.layout;

  this.areaNodes = {};
  this.svgHost.innerHTML = '';
  var svg = el('svg', {
    viewBox: layout.viewBox || '0 0 680 400',
    role: 'img',
    'aria-label': '多目的ホール平面図タイムライン'
  }, this.svgHost);
  this.svg = svg;

  /* ホールの外枠 */
  el('rect', {
    x: 24, y: 8, width: 632, height: 380, rx: 8,
    fill: 'none', stroke: '#cfd4da', 'stroke-width': 1, 'stroke-dasharray': '4 4'
  }, svg);
  var hall = el('text', {
    x: 648, y: 384, 'text-anchor': 'end', 'font-size': 10, fill: '#8a9099'
  }, svg);
  hall.textContent = '多目的ホール';

  (layout.areas || []).forEach(function (a) {
    var g = el('g', null, svg);
    var rect = el('rect', {
      x: a.x, y: a.y, width: a.w, height: a.h, rx: 6,
      fill: '#f1f3f5', stroke: '#cfd4da', 'stroke-width': 1
    }, g);
    var name = el('text', {
      x: a.x + 8, y: a.y + 16, 'font-size': 11, 'font-weight': 'bold', fill: '#5b6169'
    }, g);
    fitText(name, a.name, a.w - Math.min(62, a.w * 0.45));   /* 右上のバッジ分を空ける */
    var count = el('text', {
      x: a.x + a.w - 8, y: a.y + 16, 'text-anchor': 'end',
      'font-size': 10, fill: '#8a9099'
    }, g);
    var chips = el('g', null, g);
    self.areaNodes[a.id] = { area: a, rect: rect, name: name, count: count, chips: chips };
  });

};

/* 隠れている間に描いた図を、表示された状態で正確に描き直す */
FloorView.prototype.redraw = function () {
  if (!this.model) return;
  this.buildPlan();
  this.update();
};

FloorView.prototype.setTime = function (t) {
  this.t = t;
  this.slider.value = Math.round((t - this.range.start) / SNAP);
  this.update();
};

FloorView.prototype.step = function (delta) {
  this.pause();
  var next = this.t + delta * SNAP;
  if (next < this.range.start) next = this.range.start;
  if (next > this.range.end) next = this.range.end;
  this.setTime(next);
};

FloorView.prototype.play = function () {
  var self = this;
  if (this.t >= this.range.end) this.setTime(this.range.start);
  this.playBtn.textContent = '❚❚ 停止';
  this.playBtn.setAttribute('aria-pressed', 'true');
  this.timer = setInterval(function () {
    if (self.t >= self.range.end) { self.setTime(self.range.start); return; }
    self.setTime(self.t + SNAP);
  }, 850);
};

FloorView.prototype.pause = function () {
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  this.playBtn.textContent = '▶ 再生';
  this.playBtn.setAttribute('aria-pressed', 'false');
};

FloorView.prototype.update = function () {
  var t = this.t;
  var items = this.model.items;
  var tasks = activeAt(items, t, 'task');
  var resources = activeAt(items, t, 'resource');

  /* エリアごとに、その時刻にいる班をまとめる */
  var byArea = {};
  tasks.forEach(function (it) {
    if (!byArea[it.area]) byArea[it.area] = [];
    byArea[it.area].push(it);
  });

  var self = this;
  Object.keys(this.areaNodes).forEach(function (id) {
    var node = self.areaNodes[id];
    var a = node.area;
    var here = byArea[id] || [];
    var teams = [];
    here.forEach(function (it) { if (teams.indexOf(it.team) < 0) teams.push(it.team); });
    var crowded = teams.length >= CROWDED;

    /* 作業がないエリアは淡色のまま */
    node.rect.setAttribute('fill', here.length ? '#ffffff' : '#f1f3f5');
    node.rect.setAttribute('stroke', crowded ? WARN_COLOR : (here.length ? '#94a3b8' : '#cfd4da'));
    node.rect.setAttribute('stroke-width', crowded ? 2.5 : (here.length ? 1.5 : 1));
    node.name.setAttribute('fill', here.length ? '#1b1d21' : '#9aa1a9');
    var room = Math.max(0, Math.floor((a.h - CHIP_TOP - 4 + CHIP_GAP) / (CHIP_H + CHIP_GAP)));
    var hidden = Math.max(0, here.length - room);
    node.count.textContent = (teams.length ? (crowded ? '⚠ ' : '') + teams.length + '班' : '')
      + (hidden ? ' +' + hidden + '件' : '');
    node.count.setAttribute('fill', crowded ? WARN_COLOR : '#8a9099');
    node.count.setAttribute('font-weight', crowded ? 'bold' : 'normal');

    while (node.chips.firstChild) node.chips.removeChild(node.chips.firstChild);

    var show = here.slice(0, room);

    show.forEach(function (it, i) {
      var cy = a.y + CHIP_TOP + i * (CHIP_H + CHIP_GAP);
      var cg = el('g', null, node.chips);
      var tip = el('title', null, cg);
      tip.textContent = it.team + '：' + it.task + '\n' + fmtMin(it.start) + '–' + fmtMin(it.end)
        + (it.owners.length ? '\n担当：' + it.owners.join('・') : '')
        + (it.note ? '\n備考：' + it.note : '');
      el('rect', {
        x: a.x + 6, y: cy, width: a.w - 12, height: CHIP_H, rx: 3,
        fill: TEAM_COLORS[it.team] || RESOURCE_COLOR
      }, cg);
      var label = el('text', {
        x: a.x + 11, y: cy + 12, 'font-size': 10, fill: '#ffffff', 'font-weight': 'bold'
      }, cg);
      fitText(label, it.team + ' ' + it.task, a.w - 22);
    });
  });

  this.clock.textContent = fmtMin(t);
  this.renderList(t, tasks, resources);
};

/* 平面図の脇に、その時刻の作業・資源・直近マイルストーンを文字でも出す */
FloorView.prototype.renderList = function (t, tasks, resources) {
  var items = this.model.items;
  var html = '';

  var ms = items.filter(function (i) { return i.kind === 'milestone'; })
    .sort(function (a, b) { return a.start - b.start; });
  var passed = ms.filter(function (m) { return m.start <= t; });
  var next = ms.filter(function (m) { return m.start > t; })[0];
  var last = passed[passed.length - 1];
  html += '<div class="ms-strip">';
  html += last
    ? '<span class="ms-done">済 ' + esc(last.task) + ' ' + fmtMin(last.start) + '</span>'
    : '<span class="ms-done ms-none">まだ節目なし</span>';
  html += next
    ? '<span class="ms-next">次 ' + esc(next.task) + ' ' + fmtMin(next.start)
      + '（あと' + (next.start - t) + '分）</span>'
    : '<span class="ms-next ms-none">この先の節目なし</span>';
  html += '</div>';

  html += '<h3>' + fmtMin(t) + ' に動いている作業（' + tasks.length + '）</h3>';
  if (!tasks.length) {
    html += '<p class="empty">この時刻に進行中の作業はありません。</p>';
  } else {
    html += '<ul class="now-list">';
    tasks.slice().sort(function (a, b) {
      return TEAM_ORDER.indexOf(a.team) - TEAM_ORDER.indexOf(b.team) || a.start - b.start;
    }).forEach(function (it) {
      html += '<li><i style="background:' + (TEAM_COLORS[it.team] || RESOURCE_COLOR) + '"></i>'
        + '<span class="nl-main"><strong>' + esc(it.task) + '</strong>'
        + '<span class="nl-sub">' + esc(it.areaName || '-') + '／'
        + (it.owners.length ? esc(it.owners.join('・')) : '担当未定') + '</span></span>'
        + '<span class="nl-time">' + fmtMin(it.start) + '–' + fmtMin(it.end) + '</span></li>';
    });
    html += '</ul>';
  }

  if (resources.length) {
    html += '<h3>使用中の共有リソース（' + resources.length + '）</h3><ul class="res-list">';
    resources.forEach(function (r) {
      html += '<li><strong>' + esc(r.task) + '</strong> '
        + fmtMin(r.start) + '–' + fmtMin(r.end)
        + (r.note ? '<span class="nl-sub">' + esc(r.note) + '</span>' : '') + '</li>';
    });
    html += '</ul>';
  }

  this.listHost.innerHTML = html;
};

/* =====================  編集パネル  ===================== */
/* 画面で直したものを CSV に書き戻す。唯一の真実は最後まで schedule.csv のまま。 */

var CSV_COLS = ['id', 'team', 'area', 'task', 'start', 'end', 'owner', 'depends', 'note', 'kind'];

var KIND_OPTIONS = [
  { value: '', label: '作業' },
  { value: 'milestone', label: 'マイルストーン' },
  { value: 'resource', label: '共有リソース' }
];

var EDIT_FIELDS = [
  { key: 'kind',    label: '種別',  type: 'kind',  width: '9em' },
  { key: 'id',      label: 'ID',    type: 'text',  width: '5em' },
  { key: 'team',    label: '班',    type: 'team',  width: '6em' },
  { key: 'task',    label: '作業名', type: 'text',  width: '12em' },
  { key: 'area',    label: '場所',  type: 'area',  width: '10em' },
  { key: 'start',   label: '開始',  type: 'time',  width: '7em' },
  { key: 'end',     label: '終了',  type: 'time',  width: '7em' },
  { key: 'owner',   label: '担当',  type: 'text',  width: '10em' },
  { key: 'depends', label: '前提',  type: 'text',  width: '7em' },
  { key: 'note',    label: '備考',  type: 'text',  width: '12em' }
];

/* 行データ（生の文字列）を CSV に戻す。Excel が読める素直な引用符の付け方をする。 */
function toCsv(rows) {
  function cell(v) {
    v = v === undefined || v === null ? '' : String(v);
    if (/[",\n\r]/.test(v) || v !== v.trim()) {
      return '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  }
  var out = [CSV_COLS.join(',')];
  rows.forEach(function (r) {
    out.push(CSV_COLS.map(function (c) { return cell(r[c]); }).join(','));
  });
  return out.join('\n') + '\n';
}

function blankRow() {
  var r = {};
  CSV_COLS.forEach(function (c) { r[c] = ''; });
  r.team = '映像';
  r.start = '09:00';
  r.end = '10:00';
  return r;
}

/* 既存と衝突しない ID を作る。depends が指すので勝手に振り直さない。 */
function nextId(rows, team) {
  var prefix = { '映像': 'V', '音響': 'S', '照明': 'L', '全班': 'A' }[team] || 'T';
  var used = {};
  rows.forEach(function (r) { used[r.id] = true; });
  for (var n = 1; n < 1000; n++) {
    if (!used[prefix + n]) return prefix + n;
  }
  return prefix + Date.now();
}

function EditorView(opts) {
  this.host = opts.table;
  this.countHost = opts.count;
  this.onChange = opts.onChange;
  this.rows = [];
  this.layout = null;
  this.badIds = {};
  this.renderedIds = [];
  this.onUndoable = opts.onUndoable;
  this.bind();
}

EditorView.prototype.setData = function (rows, layout) {
  this.rows = rows;
  this.layout = layout;
  this.render();
};

/* buildModel が返した警告から、どの行が赤くなるかを決める */
EditorView.prototype.markIssues = function (issues) {
  var self = this;
  this.badIds = {};
  this.rows.forEach(function (r) {
    if (!r.id) return;
    /* 単純な部分一致だと A1 が「A10 の…」でも光ってしまう。前後を区切りで見る。 */
    var re = new RegExp('(^|[^0-9A-Za-z_])' + r.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + '([^0-9A-Za-z_]|$)');
    issues.forEach(function (msg) {
      if (re.test(msg)) self.badIds[r.id] = true;
    });
  });
  var trs = this.host.querySelectorAll('tbody tr');
  [].slice.call(trs).forEach(function (tr, i) {
    var row = self.rows[i];
    if (!row) return;
    if (self.badIds[row.id]) tr.classList.add('row-bad');
    else tr.classList.remove('row-bad');
  });
};

EditorView.prototype.cellHtml = function (f, row, i) {
  var name = 'data-i="' + i + '" data-f="' + f.key + '"';
  var v = row[f.key] || '';
  var id = 'ed-' + f.key + '-' + i;
  if (f.type === 'team' || f.type === 'kind' || f.type === 'area') {
    var opts;
    if (f.type === 'team') {
      opts = TEAM_ORDER.map(function (t) { return { value: t, label: t }; });
    } else if (f.type === 'kind') {
      opts = KIND_OPTIONS;
    } else {
      opts = [{ value: '', label: '（なし）' }].concat(
        (this.layout.areas || []).map(function (a) { return { value: a.id, label: a.name }; })
      );
      /* layout.json に無い area が入っていても消さずに見せる */
      if (v && !opts.some(function (o) { return o.value === v; })) {
        opts.push({ value: v, label: v + '（不明）' });
      }
    }
    return '<select id="' + id + '" ' + name + '>' + opts.map(function (o) {
      return '<option value="' + esc(o.value) + '"' + (o.value === v ? ' selected' : '') + '>'
        + esc(o.label) + '</option>';
    }).join('') + '</select>';
  }
  if (f.type === 'time') {
    var lock = (f.key === 'end' && row.kind === 'milestone') ? ' disabled' : '';
    return '<input id="' + id + '" type="time" step="300" ' + name
      + ' value="' + esc(v) + '"' + lock + '>';
  }
  return '<input id="' + id + '" type="text" ' + name + ' value="' + esc(v) + '">';
};

EditorView.prototype.render = function () {
  var self = this;
  var head = EDIT_FIELDS.map(function (f) {
    return '<th style="min-width:' + f.width + '">' + f.label + '</th>';
  }).join('') + '<th class="ops-col">操作</th>';

  var body = this.rows.map(function (row, i) {
    var cells = EDIT_FIELDS.map(function (f) {
      return '<td data-label="' + f.label + '">' + self.cellHtml(f, row, i) + '</td>';
    }).join('');
    return '<tr>' + cells
      + '<td data-label="操作" class="ops-col"><div class="ops">'
      + '<button type="button" data-act="up" data-i="' + i + '" title="上へ" aria-label="上へ">↑</button>'
      + '<button type="button" data-act="down" data-i="' + i + '" title="下へ" aria-label="下へ">↓</button>'
      + '<button type="button" data-act="dup" data-i="' + i + '" title="複製" aria-label="複製">複製</button>'
      + '<button type="button" data-act="del" data-i="' + i + '" title="削除" aria-label="削除" class="danger">削除</button>'
      + '</div></td></tr>';
  }).join('');

  this.host.innerHTML = '<table class="edit-table"><thead><tr>' + head + '</tr></thead>'
    + '<tbody>' + body + '</tbody></table>';
  this.countHost.textContent = this.rows.length + '行';
  /* ID を書き換えたときに、変更前の値を知るための控え */
  this.renderedIds = this.rows.map(function (r) { return r.id; });
};

EditorView.prototype.bind = function () {
  var self = this;

  /* input と change の両方が飛んでくる。実際に変わったときだけ処理する。 */
  function write(e) {
    var t = e.target;
    var i = t.getAttribute('data-i');
    var f = t.getAttribute('data-f');
    if (i === null || !f) return;
    var idx = parseInt(i, 10);
    var row = self.rows[idx];
    if (!row) return;

    var prevKind = row.kind;
    var changed = row[f] !== t.value;
    row[f] = t.value;

    /* ID を変えたら、それを指している depends も一緒に書き換える。
       確定（change）のときだけ。打っている途中の文字で巻き込まないため。 */
    if (f === 'id' && e.type === 'change') self.renameId(idx);

    if (!changed) return;

    if (f === 'kind' || (f === 'start' && row.kind === 'milestone')) {
      if (row.kind === 'milestone') {
        /* マイルストーンは長さを持たない。終了を開始に揃えて固定する。 */
        row.end = row.start;
        var endEl = self.host.querySelector('input[data-f="end"][data-i="' + i + '"]');
        if (endEl) endEl.value = row.end;
      } else if (prevKind === 'milestone') {
        /* 作業に戻すと開始＝終了のままになる。1時間の幅を与えておく。 */
        row.end = addMin(row.start, 60);
      }
    }

    /* 班を変えたら、未入力の ID だけ自動で振る */
    if (f === 'team' && !row.id) row.id = nextId(self.rows, row.team);

    var structural = (f === 'kind' || f === 'team');
    self.onChange(structural);
    if (structural) self.render();
  }

  this.host.addEventListener('input', write);
  this.host.addEventListener('change', write);

  this.host.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
    if (!btn) return;
    var i = parseInt(btn.getAttribute('data-i'), 10);
    var act = btn.getAttribute('data-act');
    var rows = self.rows;
    var before = toCsv(rows);

    if (act === 'up' && i > 0) { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); }
    else if (act === 'down' && i < rows.length - 1) { rows.splice(i + 1, 0, rows.splice(i, 1)[0]); }
    else if (act === 'dup') {
      var copy = {};
      CSV_COLS.forEach(function (c) { copy[c] = rows[i][c]; });
      copy.id = nextId(rows, copy.team);
      copy.depends = '';
      rows.splice(i + 1, 0, copy);
    } else if (act === 'del') {
      /* 確認ダイアログは共有ページ（sandbox された画面）では出せず、
         押しても何も起きないように見える。消してから取り消せるようにする。 */
      var name = rows[i].task || rows[i].id || 'この行';
      rows.splice(i, 1);
      self.render();
      self.onChange(true);
      if (self.onUndoable) self.onUndoable('「' + name + '」を削除しました', before);
      return;
    } else { return; }

    self.render();
    self.onChange(true);
  });
};

/* ID の変更を、それを指している depends に反映する */
EditorView.prototype.renameId = function (idx) {
  var self = this;
  var before = this.renderedIds[idx];
  var after = this.rows[idx].id;
  this.renderedIds[idx] = after;
  if (!before || !after || before === after) return;

  var hits = 0;
  this.rows.forEach(function (r, j) {
    if (!r.depends) return;
    var found = false;
    var list = splitList(r.depends, ',').map(function (d) {
      if (d === before) { found = true; hits++; return after; }
      return d;
    });
    if (!found) return;
    r.depends = list.join(',');
    /* 表を作り直すと入力中のフォーカスが飛ぶので、値だけ差し替える */
    var el = self.host.querySelector('input[data-f="depends"][data-i="' + j + '"]');
    if (el) el.value = r.depends;
  });
  if (hits) this.onChange(true);
};

/* 今どの行を触っているかを外に知らせる（プレビューの強調に使う） */
EditorView.prototype.watchFocus = function (fn) {
  var self = this;
  this.host.addEventListener('focusin', function (e) {
    var tr = e.target.closest ? e.target.closest('tr') : null;
    if (!tr) return;
    var trs = [].slice.call(self.host.querySelectorAll('tbody tr'));
    var i = trs.indexOf(tr);
    if (i >= 0 && self.rows[i]) fn(self.rows[i]);
  });
  this.host.addEventListener('focusout', function (e) {
    /* 表の外に出たときだけ解除する。セル間の移動では消さない。 */
    setTimeout(function () {
      if (!self.host.contains(document.activeElement)) fn(null);
    }, 0);
  });
};

EditorView.prototype.addRow = function () {
  var r = blankRow();
  r.id = nextId(this.rows, r.team);
  this.rows.push(r);
  this.render();
  this.onChange(true);
  var last = this.host.querySelector('tbody tr:last-child input[data-f="task"]');
  if (last) last.focus();
};

/* =====================  案（変種）の保管  ===================== */
/* 予定のパターンを複数持てるようにする。編集するたびに自動で保存する。
   保存先はこの端末のブラウザだけ。サーバーにもDBにも置かない。 */

var VARIANTS_KEY = 'kodaisai-gantt-variants-v1';
var OLD_DRAFT_KEY = 'kodaisai-gantt-draft-v1';
var BASE_LABEL = '配布時の予定';

function VariantStore(baseCsv) {
  this.base = baseCsv;
  this.list = [];            /* [{ name, csv, at }] 並び順そのまま */
  this.activeName = null;    /* null なら配布時の予定を見ている */
  this.persistent = true;    /* localStorage が使えるか */
  this.load();
}

VariantStore.prototype.read = function (key) {
  try { return window.localStorage.getItem(key); }
  catch (e) { this.persistent = false; return null; }
};

VariantStore.prototype.load = function () {
  var raw = this.read(VARIANTS_KEY);
  if (raw) {
    try {
      var data = JSON.parse(raw);
      if (data && Object.prototype.toString.call(data.list) === '[object Array]') {
        this.list = data.list.filter(function (v) { return v && v.name && typeof v.csv === 'string'; });
        this.activeName = data.activeName || null;
      }
    } catch (e) { /* 壊れていたら無かったことにする */ }
  }

  /* 以前の版が作った下書きを、ひとつの案として引き継ぐ */
  var old = this.read(OLD_DRAFT_KEY);
  if (old && old !== this.base && !this.byName('下書き')) {
    this.list.push({ name: '下書き', csv: old, at: Date.now() });
    this.activeName = '下書き';
    this.save();
  }
  if (old) { try { window.localStorage.removeItem(OLD_DRAFT_KEY); } catch (e) { /* 消せなくても困らない */ } }

  if (this.activeName && !this.byName(this.activeName)) this.activeName = null;
};

VariantStore.prototype.save = function () {
  try {
    window.localStorage.setItem(VARIANTS_KEY,
      JSON.stringify({ activeName: this.activeName, list: this.list }));
    this.persistent = true;
  } catch (e) {
    this.persistent = false;   /* 画面の中だけで持つ。警告は帯で出す。 */
  }
  return this.persistent;
};

VariantStore.prototype.byName = function (name) {
  for (var i = 0; i < this.list.length; i++) {
    if (this.list[i].name === name) return this.list[i];
  }
  return null;
};

VariantStore.prototype.active = function () {
  return this.activeName ? this.byName(this.activeName) : null;
};

/* 今見ている内容 */
VariantStore.prototype.currentCsv = function () {
  var v = this.active();
  return v ? v.csv : this.base;
};

VariantStore.prototype.uniqueName = function (want) {
  var name = want || '案';
  if (!this.byName(name)) return name;
  for (var n = 2; n < 999; n++) {
    if (!this.byName(name + n)) return name + n;
  }
  return name + Date.now();
};

VariantStore.prototype.create = function (csv, want) {
  var v = { name: this.uniqueName(want || ('案' + (this.list.length + 1))), csv: csv, at: Date.now() };
  this.list.push(v);
  this.activeName = v.name;
  this.save();
  return v;
};

/* 自動保存。配布時の予定を見たまま編集したら、新しい案を起こす。 */
VariantStore.prototype.put = function (csv) {
  var v = this.active();
  if (!v) {
    if (csv === this.base) return null;      /* 変えていないなら何もしない */
    return this.create(csv, '案1');
  }
  v.csv = csv;
  v.at = Date.now();
  this.save();
  return v;
};

VariantStore.prototype.setActive = function (name) {
  this.activeName = name && this.byName(name) ? name : null;
  this.save();
};

VariantStore.prototype.rename = function (name) {
  var v = this.active();
  if (!v || !name || name === v.name) return v;
  v.name = this.uniqueName(name);
  this.activeName = v.name;
  this.save();
  return v;
};

VariantStore.prototype.remove = function () {
  var v = this.active();
  if (!v) return null;
  var i = this.list.indexOf(v);
  this.list.splice(i, 1);
  this.activeName = this.list.length ? this.list[Math.max(0, i - 1)].name : null;
  this.save();
  return { variant: v, index: i };
};

/* 消した案を元の位置に戻す */
VariantStore.prototype.insert = function (v, index) {
  this.list.splice(Math.min(index, this.list.length), 0, v);
  this.activeName = v.name;
  this.save();
};

/* ---- 案を選ぶ操作盤 ---- */

function VariantBar(store, onLoad) {
  var self = this;
  this.store = store;
  this.onLoad = onLoad;
  this.select = document.getElementById('variant-select');
  this.nameInput = document.getElementById('variant-name');
  this.savedMsg = document.getElementById('variant-saved');

  this.select.addEventListener('change', function () {
    store.setActive(self.select.value || null);
    self.render();
    onLoad(store.currentCsv());
  });

  this.nameInput.addEventListener('change', function () {
    var v = store.rename(self.nameInput.value.trim());
    self.render();
    if (v) self.flash('名前を変えました');
  });

  document.getElementById('variant-new').addEventListener('click', function () {
    store.create(self.getCsv(), '');
    self.render();
    self.flash('新しい案として保存しました');
    self.nameInput.focus();
    self.nameInput.select();
  });

  document.getElementById('variant-del').addEventListener('click', function () {
    var gone = store.remove();
    if (!gone) return;
    self.render();
    onLoad(store.currentCsv());
    if (self.onRemoved) self.onRemoved(gone.variant, gone.index);
  });

  this.render();
}

VariantBar.prototype.render = function () {
  var store = this.store;
  var active = store.active();
  var opts = ['<option value="">' + BASE_LABEL + '</option>'];
  store.list.forEach(function (v) {
    opts.push('<option value="' + esc(v.name) + '"'
      + (active && v.name === active.name ? ' selected' : '') + '>' + esc(v.name) + '</option>');
  });
  this.select.innerHTML = opts.join('');
  this.nameInput.value = active ? active.name : '';
  this.nameInput.disabled = !active;
  this.nameInput.placeholder = active ? '案の名前' : '（配布時の予定）';
  document.getElementById('variant-del').disabled = !active;
  this.showSaved(active);
  updateDraftBar(this.store);   /* 帯に出す案の名前も合わせる */
};

VariantBar.prototype.showSaved = function (v) {
  if (!v) { this.savedMsg.textContent = '編集すると新しい案として自動保存します'; return; }
  var d = new Date(v.at || Date.now());
  this.savedMsg.textContent = '自動保存 '
    + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
};

VariantBar.prototype.flash = function (text) {
  var self = this;
  this.savedMsg.textContent = text;
  if (this.timer) clearTimeout(this.timer);
  this.timer = setTimeout(function () { self.showSaved(self.store.active()); }, 2500);
};

/* 編集のたびに呼ばれる。保存して、選択欄の見た目を合わせる。 */
VariantBar.prototype.autoSave = function (csv) {
  var wasActive = this.store.activeName;
  var v = this.store.put(csv);
  if (this.store.activeName !== wasActive) this.render();   /* 案が新しくできた */
  else this.showSaved(v);
  return this.store.persistent;
};

/* =====================  編集中のプレビュー  ===================== */
/* 編集タブの中に、同じモデルから描いたガントと平面図を並べて出す。 */

function PreviewPane(model, layout) {
  var self = this;
  this.root = document.getElementById('edit-preview');
  this.body = document.getElementById('preview-body');
  this.ganttHost = document.getElementById('prev-team');
  this.floorWrap = document.getElementById('prev-floor-wrap');
  this.ganttWrap = document.getElementById('prev-team-wrap');
  this.which = 'both';
  this.model = model;
  this.layout = layout;
  this.highlightId = null;

  this.floor = new FloorView(model, {
    svg: document.getElementById('prev-floor'),
    list: document.createElement('div'),   /* プレビューでは一覧は出さない */
    slider: document.getElementById('prev-slider'),
    clock: document.getElementById('prev-clock'),
    playBtn: document.getElementById('prev-play')
  });
  document.getElementById('prev-prev').addEventListener('click', function () { self.floor.step(-1); });
  document.getElementById('prev-next').addEventListener('click', function () { self.floor.step(1); });

  [].slice.call(this.root.querySelectorAll('[data-prev]')).forEach(function (b) {
    b.addEventListener('click', function () { self.show(b.getAttribute('data-prev')); });
  });

  var toggle = document.getElementById('preview-toggle');
  toggle.addEventListener('click', function () {
    var open = self.root.getAttribute('data-open') !== 'false';
    self.root.setAttribute('data-open', open ? 'false' : 'true');
    toggle.textContent = open ? '開く' : '折りたたむ';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    if (open) self.floor.pause(); else self.render();
  });

  this.root.setAttribute('data-open', 'true');
  this.show(this.which);
}

PreviewPane.prototype.show = function (which) {
  this.which = which;
  [].slice.call(this.root.querySelectorAll('[data-prev]')).forEach(function (b) {
    b.setAttribute('aria-selected', b.getAttribute('data-prev') === which ? 'true' : 'false');
  });
  /* both は両方出す。時間の前後と、その時刻の場所を同時に確かめられる。 */
  this.ganttWrap.hidden = which === 'floor';
  this.floorWrap.hidden = which === 'team';
  this.body.setAttribute('data-mode', which);
  if (which === 'team') this.floor.pause();
  this.render();
};

PreviewPane.prototype.setModel = function (model) {
  this.model = model;
  this.floor.setModel(model);
  this.render();
};

/* 表示されている状態で描き直す。隠れたまま描くと文字幅を測れないため。 */
PreviewPane.prototype.render = function () {
  if (this.root.getAttribute('data-open') === 'false') return;
  if (this.which !== 'floor') {
    renderTeamGantt(this.model, this.ganttHost);
    this.applyHighlight();
  }
  if (this.which !== 'team') this.floor.redraw();
};

/* 編集中の行に当たるバーを濃く、それ以外を薄くする */
PreviewPane.prototype.applyHighlight = function () {
  var groups = [].slice.call(this.ganttHost.querySelectorAll('g[data-id]'));
  /* 指していた行が消えた（削除・ID変更）ときに、全部を薄いままにしない */
  var id = this.highlightId;
  if (id && !groups.some(function (g) { return g.getAttribute('data-id') === id; })) {
    id = this.highlightId = null;
  }
  groups.forEach(function (g) {
    g.classList.remove('hl');
    g.classList.remove('dim');
    if (!id) return;
    if (g.getAttribute('data-id') === id) g.classList.add('hl');
    else g.classList.add('dim');
  });
};

PreviewPane.prototype.highlight = function (row) {
  this.highlightId = row ? row.id : null;
  if (this.which !== 'floor') this.applyHighlight();
  if (this.which !== 'team' && row) {
    /* 平面図を見ているときは、その作業が動いている時刻へ飛ぶ */
    var t = toMin(row.start);
    if (t !== null) {
      var r = this.floor.range;
      t = Math.min(Math.max(t, r.start), r.end);
      this.floor.pause();
      this.floor.setTime(r.start + Math.round((t - r.start) / SNAP) * SNAP);
    }
  }
};

PreviewPane.prototype.pause = function () { this.floor.pause(); };

/* =====================  取り消し  ===================== */
/* 共有ページでは確認ダイアログが出せない。先に実行して、あとから戻せるようにする。 */

function UndoBar() {
  this.bar = document.getElementById('undo-bar');
  this.msg = document.getElementById('undo-msg');
  this.action = null;
  this.timer = null;
  var self = this;

  document.getElementById('undo-btn').addEventListener('click', function () {
    var act = self.action;
    if (!act) return;
    self.hide();
    act();
  });
  document.getElementById('undo-close').addEventListener('click', function () { self.hide(); });
}

/* action は「その操作をなかったことにする関数」。
   消した行なのか案そのものなのかで戻し方が違うので、呼び出し側に決めさせる。 */
UndoBar.prototype.offer = function (message, action) {
  var self = this;
  this.action = action;
  this.msg.textContent = message;
  this.bar.hidden = false;
  if (this.timer) clearTimeout(this.timer);
  this.timer = setTimeout(function () { self.hide(); }, 15000);
};

UndoBar.prototype.hide = function () {
  this.bar.hidden = true;
  this.action = null;
  if (this.timer) { clearTimeout(this.timer); this.timer = null; }
};

/* =====================  CSV の書き出し  ===================== */

function openCsvDialog(csv) {
  var back = document.getElementById('csv-modal');
  var area = document.getElementById('csv-text');
  var msg = document.getElementById('csv-msg');
  area.value = csv;
  msg.textContent = '';
  back.hidden = false;
  area.focus();
  area.select();        /* すぐ ⌘C できる状態にしておく */
}

var BOM = '\uFEFF';   /* Excel に UTF-8 だと伝えるための印 */

function setupCsvDialog(getCsv) {
  var back = document.getElementById('csv-modal');
  var area = document.getElementById('csv-text');
  var msg = document.getElementById('csv-msg');

  document.getElementById('csv-close').addEventListener('click', function () { back.hidden = true; });
  back.addEventListener('click', function (e) { if (e.target === back) back.hidden = true; });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !back.hidden) back.hidden = true;
  });

  document.getElementById('csv-copy').addEventListener('click', function () {
    var text = area.value;
    function fallback() {
      area.focus();
      area.select();
      var done = false;
      try { done = document.execCommand('copy'); } catch (err) { done = false; }
      msg.textContent = done
        ? 'コピーしました。schedule.csv に貼り付けてください。'
        : '枠の中を全選択しました。⌘C（Windows は Ctrl+C）でコピーしてください。';
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        msg.textContent = 'コピーしました。schedule.csv に貼り付けてください。';
      }, fallback);
    } else {
      fallback();
    }
  });

  var dlBtn = document.getElementById('csv-download');

  /* 共有ページ（claude.ai）では、ページが自分でファイルを保存できない。
     用意された保存機能があればそれを使い、無ければ通常のダウンロードにする。 */
  var hostDownloads = null;
  if (window.claude && typeof window.claude.use === 'function') {
    dlBtn.disabled = true;
    window.claude.use('downloads').then(function (dl) {
      hostDownloads = dl;
      if (dl) dlBtn.disabled = false;
      else dlBtn.hidden = true;     /* 保存できない画面ではボタンごと出さない */
    }, function () { dlBtn.hidden = true; });
  }

  function saveLocally(text) {
    var blob = new Blob([BOM + text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'schedule.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    msg.textContent = 'ダウンロードしました。始まらない場合は「コピー」を使ってください。';
  }

  dlBtn.addEventListener('click', function () {
    var text = area.value;
    if (hostDownloads) {
      msg.textContent = '保存を確認しています…';
      hostDownloads.save({ filename: 'schedule.csv', data: BOM + text }).then(function () {
        msg.textContent = 'schedule.csv を保存しました。';
      }, function (err) {
        var code = err && err.code;
        if (code === 'declined') msg.textContent = '保存をやめました。';
        else if (code === 'rate_limited') msg.textContent = '少し待ってからもう一度押してください。';
        else msg.textContent = 'この画面では保存できませんでした。「コピー」を使ってください。';
      });
      return;
    }
    try { saveLocally(text); }
    catch (err) { msg.textContent = 'この画面ではダウンロードできません。「コピー」を使ってください。'; }
  });

  document.getElementById('csv-open').addEventListener('click', function () {
    openCsvDialog(getCsv());
  });
}

/* =====================  凡例・警告  ===================== */

function esc(s) {
  return String(s).replace(/[&<>]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
  });
}

function renderLegend(container, withMilestone) {
  container.innerHTML = '';
  TEAM_ORDER.forEach(function (team) {
    var s = document.createElement('span');
    s.innerHTML = '<i style="background:' + TEAM_COLORS[team] + '"></i>' + team;
    container.appendChild(s);
  });
  var r = document.createElement('span');
  r.innerHTML = '<i style="background:' + RESOURCE_COLOR + '"></i>' + SHARED_LANE;
  container.appendChild(r);
  if (withMilestone) {
    var m = document.createElement('span');
    m.innerHTML = '<i style="background:' + WARN_COLOR + '"></i>マイルストーン';
    container.appendChild(m);
  }
}

function renderIssues(issues, container) {
  if (!issues.length) { container.hidden = true; return; }
  container.hidden = false;
  container.innerHTML = '<strong>データの確認が必要です（' + issues.length + '件）</strong><ul>'
    + issues.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('')
    + '</ul>';
}

/* =====================  ビュー切替  ===================== */

function setupTabs(onShow) {
  var tabs = [].slice.call(document.querySelectorAll('[data-view]'));
  var panels = {
    team: document.getElementById('panel-team'),
    floor: document.getElementById('panel-floor'),
    edit: document.getElementById('panel-edit')
  };
  function show(name) {
    tabs.forEach(function (b) {
      var on = b.getAttribute('data-view') === name;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== name; });
    if (onShow) onShow(name);
  }
  tabs.forEach(function (b) {
    b.addEventListener('click', function () { show(b.getAttribute('data-view')); });
  });
  show('team');
}

/* =====================  読み込み  ===================== */
/* dist/index.html では build.py が window.EMBEDDED_DATA を埋め込む。
   開発中（src/ を http.server で開く）だけ fetch する。 */

function loadData() {
  if (window.EMBEDDED_DATA) {
    return Promise.resolve({
      csv: window.EMBEDDED_DATA.schedule,
      layout: window.EMBEDDED_DATA.layout
    });
  }
  return Promise.all([
    fetch('../data/schedule.csv').then(function (r) { return r.text(); }),
    fetch('../data/layout.json').then(function (r) { return r.json(); })
  ]).then(function (v) { return { csv: v[0], layout: v[1] }; });
}

function main() {
  var chart = document.getElementById('view-team');
  loadData().then(function (d) {
    var layout = d.layout;
    var originalCsv = d.csv;

    /* この端末に保存されている案があれば、前回の続きから開く */
    var store = new VariantStore(originalCsv);
    var startCsv = store.currentCsv();

    var undoBar = new UndoBar();

    var editor = new EditorView({
      table: document.getElementById('edit-table'),
      count: document.getElementById('edit-count'),
      onChange: function () { refresh(); },
      onUndoable: function (msg, csvBefore) {
        /* 消した行を戻す：いまの案の中身を、消す前の内容に書き戻す */
        undoBar.offer(msg, function () {
          editor.setData(normalizeRows(parseCsv(csvBefore)), layout);
          restore(csvBefore);
        });
      }
    });
    editor.setData(normalizeRows(parseCsv(startCsv)), layout);

    renderLegend(document.getElementById('legend'), true);
    renderLegend(document.getElementById('legend-floor'), false);

    var model = buildModel(toCsv(editor.rows), layout);
    renderIssues(model.issues, document.getElementById('issues'));
    var info = renderTeamGantt(model, chart);
    editor.markIssues(model.issues);

    var floor = new FloorView(model, {
      svg: document.getElementById('view-floor'),
      list: document.getElementById('floor-now'),
      slider: document.getElementById('floor-slider'),
      clock: document.getElementById('floor-clock'),
      playBtn: document.getElementById('floor-play')
    });

    var preview = new PreviewPane(model, layout);
    editor.watchFocus(function (row) { preview.highlight(row); });

    var variantBar = new VariantBar(store, function (csv) {
      /* 案を切り替えたとき。表も図もその内容で作り直す。 */
      editor.setData(normalizeRows(parseCsv(csv)), layout);
      rerender();
    });
    variantBar.getCsv = function () { return toCsv(editor.rows); };
    variantBar.onRemoved = function (v, index) {
      /* 消した案を戻す：他の案の中身を上書きしないよう、案そのものを差し戻す */
      undoBar.offer('案「' + v.name + '」を削除しました', function () {
        store.insert(v, index);
        variantBar.render();
        editor.setData(normalizeRows(parseCsv(v.csv)), layout);
        rerender();
      });
    };

    updateMeta(model, info.range);
    updateDraftBar(store);

    /* 図だけ作り直す（案の切替や取り消しのように、保存しなくてよいとき） */
    function rerender() {
      var csv = toCsv(editor.rows);
      var m = buildModel(csv, layout);
      renderIssues(m.issues, document.getElementById('issues'));
      var i2 = renderTeamGantt(m, chart);
      floor.setModel(m);
      preview.setModel(m);
      editor.markIssues(m.issues);
      updateMeta(m, i2.range);
      return csv;
    }

    /* 編集されるたびに、同じ CSV から全ビューを作り直し、案に自動保存する */
    function refresh() {
      var csv = rerender();
      variantBar.autoSave(csv);
      updateDraftBar(store);
    }

    /* 取り消しで戻したときは、いまの案にその内容を書き戻す */
    function restore(csv) {
      rerender();
      variantBar.autoSave(csv);
      variantBar.render();
      updateDraftBar(store);
    }

    document.getElementById('edit-add').addEventListener('click', function () {
      editor.addRow();
    });

    setupCsvDialog(function () { return toCsv(editor.rows); });

    document.getElementById('floor-prev').addEventListener('click', function () { floor.step(-1); });
    document.getElementById('floor-next').addEventListener('click', function () { floor.step(1); });
    document.addEventListener('keydown', function (e) {
      if (document.getElementById('panel-floor').hidden) return;
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') { floor.step(-1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { floor.step(1); e.preventDefault(); }
    });

    setupTabs(function (name) {
      if (name !== 'floor') floor.pause();
      if (name !== 'edit') preview.pause();
      /* 隠れている間に描いた図は文字幅を測れていない。見せる時に描き直す。 */
      if (name === 'edit') preview.render();
      if (name === 'floor') floor.redraw();
    });

    /* 印刷は常に班別ガント1枚。他のタブを開いていても同じものが出る。 */
    /* 共有ページでは印刷ダイアログがブラウザに止められることがある。
       beforeprint が来なければ、開かなかったとみなして案内を出す。 */
    var printOpened = false;
    window.addEventListener('beforeprint', function () { printOpened = true; });
    document.getElementById('print-btn').addEventListener('click', function () {
      floor.pause();
      preview.pause();
      printOpened = false;
      var hint = document.getElementById('print-hint');
      hint.hidden = true;
      try { window.print(); } catch (e) { /* 案内に回す */ }
      setTimeout(function () { if (!printOpened) hint.hidden = false; }, 500);
    });
    document.getElementById('print-stamp').textContent =
      '出力：' + new Date().toLocaleString('ja-JP', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
  }).catch(function (e) {
    chart.innerHTML = '<p style="padding:16px">データを読み込めませんでした：' + esc(e.message)
      + '<br>src/ を直接ダブルクリックした場合はこうなります。dist/index.html を開いてください。</p>';
  });
}

/* CSV に列が足りなくても編集できるように、欠けている列を空で埋める */
function normalizeRows(rows) {
  return rows.map(function (r) {
    var o = {};
    CSV_COLS.forEach(function (c) { o[c] = r[c] === undefined ? '' : r[c]; });
    return o;
  });
}

function updateMeta(model, range) {
  var counts = { task: 0, milestone: 0, resource: 0 };
  model.items.forEach(function (i) { counts[i.kind]++; });
  document.getElementById('meta').textContent =
    fmtMin(range.start) + '–' + fmtMin(range.end)
    + ' ／ 作業 ' + counts.task + '件'
    + ' ／ マイルストーン ' + counts.milestone + '件'
    + ' ／ 共有リソース ' + counts.resource + '件';
}

/* 案を編集していることと、それがこの端末にしか無いことを常に出しておく */
function updateDraftBar(store) {
  var bar = document.getElementById('draft-bar');
  var v = store.active();
  bar.hidden = !v;
  if (v) document.getElementById('draft-name').textContent = v.name;
  /* 保存が塞がれている画面（プライベートウインドウ等）では、消えることを伝える */
  document.getElementById('draft-volatile').hidden = store.persistent;
}

/* 公開ページに埋め込まれたときは DOMContentLoaded を過ぎていることがある */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
