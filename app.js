/* ============================================================
   ClaimGuard · 证据链审计台  v1
   规则引擎：纯前端启发式，不联网、不上传、不调用任何模型。
   方法论：问题先于数据，数据先于结论，结论只忠于数据。
   ============================================================ */
'use strict';

/* ---------------- 示例语料 ---------------- */
const EXAMPLE_BAD = `【根因分析报告】

经过深入分析，/orders 接口性能劣化的根因是数据库慢查询。
建议为 orders 表的 user_id 字段增加索引，预计可将 P99 降低 60% 以上。
此外，建议开启查询缓存以进一步优化，预计可再提升 30% 缓存命中率。
系统整体性能显然已经得到彻底解决，无需进一步排查。`;

const EXAMPLE_GOOD = `【根因分析报告 · 证据链版】

P99 劣化与 orders 表慢查询高度相关。来源：近 24h 慢查询日志 Top 50 中，orders 表 SELECT 占 37 条；APM 显示数据库 span 耗时占比从 41% 升至 76%。

劣化起点与 v2.3.1 发布时间吻合，疑似与新增统计查询有关。来源：劣化起始时间 09-03 14:20，v2.3.1 发布于 09-03 14:05；commit a1b2c3d 引入了 SELECT COUNT(*) 全表统计。

GC 停顿是否为次要贡献因素：GC 日志未采集，无法排除，需运维开启后复核。

剩余风险：索引变更需评估写放大，建议先在影子库验证。`;

/* ---------------- 审计规则 ---------------- */
const PATTERNS = {
  causal: /(因为|由于|导致|造成|使得|根因|原因[是在]|所以|因此|归因|源于|罪魁祸首|与.{0,12}(高度)?相关)/,
  pct: /\d+(\.\d+)?\s*%|\d+\s*倍/,
  quant: /(预计|预期|估计|有望|或将|大约|约(?!束)|至少|高达|低至|(提升|提高|降低|下降|增长|减少|节省)[了]?)/,
  certainty: /(显然|无疑|必然|肯定|毫无疑问|一定是|百分百|100%|彻底解决|无需(进一步)?(排查|调查|验证))/,
  status: /(已(完成|修复|验证|通过|上线|解决))|((问题|bug|缺陷)已?不复存在)/,
  disclosure: /(未采集|无法排除|待确认|数据不足|需要?补充|缺口|未复核|暂无数据|待验证|待复核|无法确定|需要?人工|未覆盖|不掌握)/,
  evidence: /(来源[:：]|来源见|数据来源|如图|图\s?\d|见附(录|件)|引用|\[\d+\]|【\d+】|日志显示|监控显示|APM|检索到|复核过|摘自|截图|样本|统计显示|报告显示|实测|压测|trace|Trace|commit\s?[0-9a-f]{6,}|指标)/
};

const TYPE_LABEL = {
  certainty: '拍板式断言',
  pct: '无源数字',
  causal: '无源因果',
  status: '未验证的状态声明'
};

const SUGGESTION = {
  certainty: '把"显然 / 必然"换成可复核的证据引用；证据不足就降级为 inferred 并说明依据。',
  pct: '给数字标注出处与统计口径，例如：来源：APM 近 7 天 /orders 分位数曲线。',
  causal: '给因果链补上数据来源，例如：来源：慢查询日志 Top 50（近 24h）。',
  status: '状态声明必须挂验证输出，例如：来源：CI #1234 全量通过；否则只能写 candidate。',
  default: '补一句数据来源与统计口径；补不出来就显式标注 gap，不要用推测填补。'
};

/* ---------------- 分句 ---------------- */
function splitReport(text) {
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const units = [];
  for (const line of lines) {
    const parts = line.split(/(?<=[。！？；!?;])/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) parts.push(line);
    for (const p of parts) units.push(p);
  }
  return units;
}

/* ---------------- 单句判定 ---------------- */
/* 标题/档头豁免：【xxx报告】、markdown 标题不是结论，禁止误伤 */
const TITLE_RE = /^[【\[#\s].{0,30}[】\]]\s*$/;
function isTitle(sentence) {
  return TITLE_RE.test(sentence) || /^#{1,6}\s/.test(sentence);
}

function classifySentence(sentence) {
  if (isTitle(sentence)) {
    return { status: 'ok', type: null, suggestion: null };
  }
  const hit = name => PATTERNS[name].test(sentence);
  const disclosure = hit('disclosure');
  if (disclosure) {
    return { status: 'disc', type: '诚实披露', suggestion: '数据缺口本身是诚实的交付物；关键路径上的缺口要触发补数据动作。' };
  }
  let type = null;
  if (hit('certainty')) type = 'certainty';
  else if (hit('pct')) type = 'pct';
  else if (hit('causal')) type = 'causal';
  else if (hit('status')) type = 'status';

  if (type) {
    const bound = hit('evidence');
    return bound
      ? { status: 'bound', type: TYPE_LABEL[type] + '（有来源）', suggestion: '已附来源——点开核对数据口径与时效后，可人工升级为 verified。' }
      : { status: 'bare', type: TYPE_LABEL[type], suggestion: SUGGESTION[type] };
  }
  return { status: 'ok', type: null, suggestion: null };
}

function audit(text) {
  const units = splitReport(text);
  const results = units.map(s => ({ sentence: s, ...classifySentence(s) }));

  // 证据回溯："结论。来源：xxx" 是标准证据链写法——裸结论的紧邻句若给出明确来源
  //（且其自身不是裸结论），则视为证据链相邻，升级为 bound，避免分句切断证据链的误报。
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== 'bare') continue;
    const near = [results[i - 1], results[i + 1]].filter(Boolean);
    const cited = near.find(n => n.status !== 'bare' && PATTERNS.evidence.test(n.sentence));
    if (cited) {
      r.status = 'bound';
      r.type = r.type + '（来源在紧邻句）';
      r.suggestion = '来源出现在紧邻句中，证据链已建立；人工核对口径后可升级为 verified。';
    }
  }

  const claims = results.filter(r => r.status === 'bare' || r.status === 'bound');
  const bare = results.filter(r => r.status === 'bare');
  const bound = results.filter(r => r.status === 'bound');
  const disclosures = results.filter(r => r.status === 'disc');
  const completeness = claims.length ? Math.round((bound.length / claims.length) * 100) : 100;

  let verdict, stampClass;
  if (!claims.length && !disclosures.length) {
    verdict = '无可审结论'; stampClass = 'grey';
  } else if (bare.length === 0) {
    verdict = '予 以 放 行'; stampClass = 'green';
  } else if (bare.length <= 2) {
    verdict = '存 疑'; stampClass = 'amber';
  } else {
    verdict = '不予放行'; stampClass = 'red';
  }
  return { results, claims, bare, bound, disclosures, completeness, verdict, stampClass };
}

/* ---------------- 渲染 ---------------- */
const $ = id => document.getElementById(id);
const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BADGE = { bare: '裸奔', bound: '有来源', disc: '已披露' };
const FLAG_CLASS = { bare: 'f-bare', bound: 'f-bound', disc: 'f-disc' };

function renderMarkup(results, caseNo) {
  const html = results.map(r => {
    const safe = escapeHtml(r.sentence);
    if (r.status === 'ok') return safe;
    const tip = `【${r.type}】${r.suggestion}`;
    return `<span class="f ${FLAG_CLASS[r.status]}" title="${escapeHtml(tip)}">${safe}<b class="mini">${BADGE[r.status]}</b></span>`;
  });
  $('markup').innerHTML = html.join('\n');
  $('case-no').textContent = '案卷号 ' + caseNo;
}

function renderLedger(results) {
  const order = { bare: 0, bound: 1, disc: 2 };
  const rows = results
    .filter(r => r.status !== 'ok')
    .sort((a, b) => order[a.status] - order[b.status]);

  const head = '<thead><tr><th>#</th><th>声明</th><th>判定</th><th>修复建议</th></tr></thead>';
  const body = rows.map((r, i) => {
    const cls = r.status === 'bare' ? 'bare' : r.status === 'bound' ? 'bound' : 'disc';
    const label = r.status === 'bare' ? '裸奔结论' : r.status === 'bound' ? '待复核' : '诚实披露';
    const rowCls = r.status === 'disc' ? ' class="disc-row"' : '';
    return `<tr${rowCls}><td>${i + 1}</td>` +
      `<td><span class="quote">${escapeHtml(r.sentence.slice(0, 80))}${r.sentence.length > 80 ? '…' : ''}</span></td>` +
      `<td><span class="tag ${cls}">${label}</span><br><span style="font-size:11.5px;color:var(--ink-soft)">${escapeHtml(r.type)}</span></td>` +
      `<td><span class="fix">${escapeHtml(r.suggestion)}</span></td></tr>`;
  }).join('');

  $('ledger').innerHTML = head + '<tbody>' + (body || '<tr><td colspan="4" style="color:var(--ink-soft)">未检出结论性声明。</td></tr>') + '</tbody>';
}

function buildJson(auditResult, caseNo) {
  const iso = new Date().toISOString().slice(0, 19) + 'Z';
  return {
    meta: {
      tool: 'ClaimGuard v1', case_no: caseNo, audited_at: iso,
      completeness: auditResult.completeness + '%',
      policy: '问题先于数据，数据先于结论，结论只忠于数据'
    },
    claims: auditResult.claims.map(r => ({
      statement: r.sentence,
      issue: r.type,
      confidence: r.status === 'bare' ? 'gap（无证据来源）' : 'inferred（有来源，待复核）',
      evidence: r.status === 'bound' ? ['报告内文已含来源标注，需人工点开核对'] : []
    })),
    disclosures: auditResult.disclosures.map(r => r.sentence),
    remaining_risks: auditResult.bare.map(r => '补证据或降级置信：' + r.suggestion),
    note: '本输出为 candidate 状态；verified 需由人工或独立验证方复核后标注。'
  };
}

/* ---------------- 审计主流程 ---------------- */
function runAudit() {
  const text = $('report-input').value.trim();
  if (!text) {
    const card = $('input-card');
    card.classList.remove('shake');
    void card.offsetWidth;           // 重启动画
    card.classList.add('shake');
    toast('先贴一份报告再审计');
    return;
  }

  const caseNo = 'CG-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' +
    Math.random().toString(16).slice(2, 6).toUpperCase();
  const auditResult = audit(text);

  $('empty-state').classList.add('hidden');
  $('verdict-bar').classList.remove('hidden');
  $('markup-card').classList.remove('hidden');
  $('ledger-card').classList.remove('hidden');
  $('json-card').classList.remove('hidden');

  $('verdict-bar').innerHTML =
    `<span class="stat">结论性声明<b>${auditResult.claims.length}</b></span>` +
    `<span class="stat">裸奔<b class="red">${auditResult.bare.length}</b></span>` +
    `<span class="stat">有来源待复核<b class="amber" style="color:var(--amber)">${auditResult.bound.length}</b></span>` +
    `<span class="stat">诚实披露<b class="blue">${auditResult.disclosures.length}</b></span>` +
    `<span class="stat">证据链完整度<b class="${auditResult.completeness === 100 ? 'green' : 'red'}">${auditResult.completeness}%</b></span>` +
    `<span class="stamp ${auditResult.stampClass}">${auditResult.verdict}</span>`;

  renderMarkup(auditResult.results, caseNo);
  renderLedger(auditResult.results);

  const json = buildJson(auditResult, caseNo);
  $('json-out').textContent = JSON.stringify(json, null, 2);
}

/* ---------------- Task Contract ---------------- */
function lines(v) { return v.split('\n').map(s => s.trim()).filter(Boolean); }

function renderContract() {
  const contract = {
    intent: $('c-intent').value.trim(),
    audience: '见 intent（读者是谁、读完做什么决策）',
    acceptance: lines($('c-acceptance').value),
    forbidden: lines($('c-forbidden').value),
    verify_commands: lines($('c-verify').value),
    rule: '定的是问题，不是答案。Contract 获得确认后再拉数据。'
  };
  $('contract-out').textContent = JSON.stringify(contract, null, 2);
}

/* ---------------- 自查清单 ---------------- */
function renderChecklist() {
  const boxes = ['ck1', 'ck2', 'ck3', 'ck4', 'ck5'].map($);
  const done = boxes.filter(b => b.checked).length;
  $('check-progress').textContent = `已确认 ${done} / 5`;
  $('check-stamp').classList.toggle('hidden', done !== 5);
}

/* ---------------- 工具函数 ---------------- */
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
}

function copyText(text, btn) {
  const done = () => {
    const old = btn.textContent;
    btn.textContent = '已复制 ✓';
    toast('已复制到剪贴板');
    setTimeout(() => { btn.textContent = old; }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择'); }
  document.body.removeChild(ta);
}

/* ---------------- 事件绑定 ---------------- */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
}

document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => switchTab(t.dataset.tab)));

$('btn-audit').addEventListener('click', runAudit);
$('report-input').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runAudit();
});
$('btn-example-bad').addEventListener('click', () => {
  $('report-input').value = EXAMPLE_BAD;
  toast('已载入反例 · 先画靶后射箭');
});
$('btn-example-good').addEventListener('click', () => {
  $('report-input').value = EXAMPLE_GOOD;
  toast('已载入正例 · 证据链驱动');
});
$('btn-copy').addEventListener('click', () => copyText($('json-out').textContent, $('btn-copy')));
$('btn-copy-contract').addEventListener('click', () => copyText($('contract-out').textContent, $('btn-copy-contract')));

['c-intent', 'c-acceptance', 'c-forbidden', 'c-verify'].forEach(id =>
  $(id).addEventListener('input', renderContract));

['ck1', 'ck2', 'ck3', 'ck4', 'ck5'].forEach(id =>
  $(id).addEventListener('change', renderChecklist));

/* 初始渲染 */
renderContract();