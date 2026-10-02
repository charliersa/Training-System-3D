/**
 * 3D 人培室管理系統 · Google Apps Script 後端
 * 規格：GAS-串接規格.md（v1.0）
 *
 * 首次使用：
 *   1. 在 GAS 編輯器選函式 setup → 執行（會要求授權）
 *      只會新增下方 SHEETS 的 7 張分頁，不會動到試算表裡既有的其他分頁
 *      第一次執行會建立 admin 帳號，初始密碼顯示在「執行記錄」
 *   2. 部署 → 新增部署作業 → 網頁應用程式（執行身分：我；存取權：任何人）
 *   3. 重新整理試算表，上方選單「人培室系統 → 建立學員帳號」可依學員名單一次建好學員帳號
 */

/** ───── 依你的 Sheet 實際結構調整這一區 ───── */
const SHEET_ID = '';   // '' = 與此腳本綁定的試算表（擴充功能 → Apps Script 建立）；獨立專案才需填試算表 ID
const TZ = 'Asia/Taipei';
const DEMO_TODAY = '2026-09-30';   // 寫入 Config.today；清空該格即改用伺服器真實日期

// 固定角色與權限（系統管理員已含原「管理人員」的工作）。培訓專員／培訓輔導員的顯示名稱以後台「人員編制」為準
//   bookings   確認、婉拒、簽到、簽退、登記缺席、代學員預約或取消
//   leaves     審核請假、代學員請假
//   attendance 點名任何班別（其他角色只能點自己負責的班別，依「培訓班別」的負責職務）
//   faultFix   標記故障已修復      restock  耗材補貨
//   config     編輯全部後台設定    slots    只編輯「自由編排時段」      reset  重設全部資料
//   records    調整學員缺席次數、停權與考核備註（學員看不到考核紀錄）
const ROLES = {
  admin:   { label:'系統管理員', perms:['bookings','leaves','attendance','faultFix','restock','config','slots','reset','records'] },
  trainer: { label:'培訓專員',   perms:['leaves','records'] },
  tutor:   { label:'培訓輔導員', perms:['faultFix'] },
  editor:  { label:'編輯人員',   perms:['config','slots'] },
  student: { label:'學員',       perms:['slots'] }
};
// 舊角色併入現有角色：帳號管理分頁裡填「管理人員」的帳號視為系統管理員
const ROLE_ALIAS = { manager: 'admin' };
const SESSION_HOURS = 6;   // 登入有效時間；有操作就自動延長
const NO_BUMP = ['login', 'logout', 'changePassword'];   // 不改動共用資料的操作，不需通知其他人重新載入

// cols：左邊是程式內部名稱（固定），右邊是 Sheet 標題列文字（可改）；欄位順序即 setup() 建表時的排列
// 標「顯示用」的欄位只在寫入時填入方便人閱讀，程式不讀它（例如學員改名後，舊紀錄保留當時的姓名）
const SHEETS = {
  bookings:   { name: '預約紀錄', tab: '#B5654A',
                cols: { id:'編號', date:'日期', slotName:'時段', sname:'學員', status:'狀態',
                        sid:'學員代號', slot:'時段代號', updatedAt:'最後更新' } },
  leaves:     { name: '請假申請', tab: '#8A6A3A',
                cols: { id:'編號', date:'培訓日', sname:'學員', reason:'請假原因', status:'狀態',
                        sid:'學員代號', updatedAt:'最後更新' } },
  attendance: { name: '培訓點名', tab: '#6B7A5A',
                cols: { date:'培訓日', sname:'學員', present:'出席',
                        sid:'學員代號', updatedAt:'最後更新' } },
  faults:     { name: '故障回報', tab: '#9A4A3A',
                cols: { id:'編號', time:'回報時間', eqName:'設備', desc:'故障描述', by:'回報人', status:'狀態',
                        eq:'設備代號', updatedAt:'最後更新' } },
  useLog:     { name: '耗材取用', tab: '#4A5A6E',
                cols: { time:'時間', who:'取用人', itemName:'耗材', qty:'數量', item:'耗材代號' } },
  config:     { name: '系統設定', tab: '#3B3530',
                cols: { label:'說明', key:'設定項', value:'內容（JSON）' } },
  // 每位學員一列；缺席調整可為負數，停權設定可覆蓋自動規則
  records:    { name: '考核調整', tab: '#7A5C8A',
                cols: { sname:'學員', nsAdj:'缺席調整', suspend:'停權設定', reason:'調整原因', note:'備註',
                        by:'修改人', updatedAt:'最後更新', sid:'學員代號' } },
  // 新增帳號：填帳號、姓名、角色（學員另填學員代號），在「設定新密碼」輸入密碼，系統會立即加密並清空該格
  accounts:   { name: '帳號管理', tab: '#5A5048',
                cols: { user:'帳號', name:'姓名', role:'角色', sid:'學員代號', active:'狀態',
                        newpw:'設定新密碼', pw:'密碼（已加密）', lastLogin:'最後登入' } }
};
/** ───── 以下不需修改 ───── */

// 狀態欄在 Sheet 顯示中文，程式內部仍用英文代碼；讀取時中文、英文都接受
// 顏色與前端狀態標籤一致：[文字, 底色, 字色]
const ENUMS = {
  bookings:   { status:  { pending:['待確認','#F3E6CF','#8A6A3A'], confirmed:['已確認','#E2E6EA','#4A5A6E'],
                           checkedin:['在場中','#E3E8D8','#4F6140'], done:['已簽退','#ECE6DA','#6B7A5A'],
                           noshow:['無故未到','#F1DDD5','#9A4A3A'] } },
  leaves:     { status:  { pending:['待審核','#F3E6CF','#8A6A3A'], approved:['已核准','#E3E8D8','#4F6140'],
                           rejected:['已退回','#ECE6DA','#6B7A5A'] } },
  faults:     { status:  { open:['待處理','#F1DDD5','#9A4A3A'], fixed:['已修復','#E3E8D8','#4F6140'] } },
  attendance: { present: { TRUE:['出席','#E3E8D8','#4F6140'], FALSE:['未出席','#ECE6DA','#857A6C'] } },
  records:    { suspend: { auto:['依規則','#FFFFFF','#857A6C'], on:['強制停權','#F1DDD5','#9A4A3A'],
                           off:['解除停權','#E3E8D8','#4F6140'] } },
  accounts:   { role:    { admin:['系統管理員','#3B3530','#FBF8F2'],
                           trainer:['培訓專員','#F3E6CF','#8A6A3A'], tutor:['培訓輔導員','#E3E8D8','#4F6140'],
                           editor:['編輯人員','#ECE6DA','#6B7A5A'], student:['學員','#FFFFFF','#3B3530'] },
                active:  { TRUE:['啟用','#E3E8D8','#4F6140'], FALSE:['停用','#F1DDD5','#9A4A3A'] } }
};
// 資料分頁（重設示範資料只動這些；帳號管理永遠不會被清除）
const DATA_TABLES = ['bookings', 'leaves', 'attendance', 'faults', 'useLog', 'config', 'records'];
// 後來才新增的分頁：缺少時自動建立，已部署的系統不必重跑 setup()
const AUTO_TABLES = ['records'];

// 排版：欄寬（px）、淡色欄（代號類）、置中欄、自動換行欄
const LAYOUT = {
  bookings:   { widths:{ id:60, date:110, slotName:170, sname:100, status:96, sid:80, slot:80, updatedAt:150 },
                muted:['sid','slot','updatedAt'], center:['id','date','status','sid','slot','updatedAt'] },
  leaves:     { widths:{ id:60, date:110, sname:100, reason:260, status:96, sid:80, updatedAt:150 },
                muted:['sid','updatedAt'], center:['id','date','status','sid','updatedAt'], wrap:['reason'] },
  attendance: { widths:{ date:110, sname:100, present:90, sid:80, updatedAt:150 },
                muted:['sid','updatedAt'], center:['date','present','sid','updatedAt'] },
  faults:     { widths:{ id:60, time:110, eqName:150, desc:280, by:110, status:96, eq:80, updatedAt:150 },
                muted:['eq','updatedAt'], center:['id','time','status','eq','updatedAt'], wrap:['desc'] },
  useLog:     { widths:{ time:110, who:110, itemName:140, qty:70, item:90 },
                muted:['item'], center:['time','qty','item'] },
  config:     { widths:{ label:170, key:130, value:620 }, muted:['key'], center:[] },
  records:    { widths:{ sname:100, nsAdj:80, suspend:96, reason:220, note:300, by:100, updatedAt:150, sid:80 },
                muted:['by','updatedAt','sid'], center:['nsAdj','suspend','updatedAt','sid'], wrap:['reason','note'] },
  accounts:   { widths:{ user:110, name:110, role:110, sid:80, active:70, newpw:130, pw:220, lastLogin:150 },
                muted:['pw','lastLogin'], center:['role','sid','active','lastLogin'] }
};

// 系統設定分頁的「說明」欄
const CFG_LABELS = {
  labBadge:'左上角標誌字', labName:'系統名稱', labSub:'副標', rulesTitle:'管理辦法標題',
  semStart:'學期開始', semEnd:'學期結束', trainDay:'固定培訓日（0=日…6=六）', capacity:'每時段人數上限',
  noShowLimit:'無故缺席停權次數', roles:'人員編制與職責', classes:'固定培訓班別', slots:'自由編排時段',
  students:'學員名單', equipment:'設備清單', consumables:'耗材項目與庫存', rules:'管理辦法條文',
  checkoutItems:'簽退檢查項目', closingItems:'最後離開者檢查項目', closing:'最後離開者勾選狀態',
  slotsV2:'時段結構版本（請勿改動）', today:'示範日期（清空 = 使用真實日期）'
};

// 舊版英文分頁名稱：setup() 遇到時會自動改名並換成中文標題
const LEGACY_NAMES = { bookings:'Bookings', leaves:'Leaves', attendance:'Attendance', faults:'Faults', useLog:'UseLog', config:'Config' };

const LIVE = ['pending', 'confirmed', 'checkedin', 'done'];
const BOOKING_STATUS = ['confirmed', 'checkedin', 'done', 'noshow'];
const LEAVE_STATUS = ['approved', 'rejected'];
const FAULT_STATUS = ['open', 'fixed'];
const USELOG_RETURN = 200;   // load 回傳的最新筆數（與前端上限一致）；Sheet 保留全部

// setConfig 可寫入的鍵與型別。closing 走 setClosing；today、slotsV2 只能在 Sheet 手動改
const CFG_TYPES = {
  labBadge:'str', labName:'str', labSub:'str', rulesTitle:'str',
  checkoutItems:'str', closingItems:'str',
  semStart:'date', semEnd:'date',
  trainDay:'num', capacity:'num', noShowLimit:'num',
  roles:'list', classes:'list', slots:'list', students:'list',
  equipment:'list', consumables:'list', rules:'list'
};

/* ════════════════════════ 進入點 ════════════════════════ */

function doGet(e) {
  const q = (e && e.parameter) || {};
  const action = q.action || 'load';
  try {
    // ping：前端每幾秒問一次「資料版本有沒有變」，只查快取、不讀 Sheet，所以很快
    if (action === 'ping') {
      if (!q.token || !CacheService.getScriptCache().get('s:' + q.token)) throw new ApiError('AUTH_REQUIRED', '請先登入');
      return json_({ ok: true, v: ver_() });
    }
    if (action !== 'load') throw new ApiError('BAD_ACTION', '未知的操作');
    const me = auth_(q.token);
    const v = ver_();
    return json_({ ok: true, v, user: userOf_(me), data: state_(me) });
  } catch (x) {
    return json_(failure_(x, null));
  }
}

function doPost(e) {
  let p;
  try {
    p = JSON.parse(e.postData.contents);
    if (!p || typeof p !== 'object') throw 0;
  } catch (x) {
    return json_(failure_(new ApiError('BAD_PAYLOAD', '參數不完整'), null));
  }
  const fn = Object.prototype.hasOwnProperty.call(ACTIONS, p.action) ? ACTIONS[p.action] : null;
  if (!fn) return json_(failure_(new ApiError('BAD_ACTION', '未知的操作'), null));

  // 除了 login，每個操作都要帶有效的 token；未登入時失敗回應也不附資料
  let me = null;
  if (p.action !== 'login') {
    try { me = auth_(p.token); } catch (x) { return json_(failure_(x, null)); }
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return json_(failure_(new ApiError('LOCK_TIMEOUT', '伺服器忙碌，請重試'), me));
  try {
    const extra = fn(p, me) || {};
    SpreadsheetApp.flush();
    if (p.action === 'logout') return json_({ ok: true });
    const v = NO_BUMP.includes(p.action) ? ver_() : bump_();
    return json_(Object.assign({ ok: true }, extra, { v, data: state_(me || userOf_(extra.user || {})) }));
  } catch (x) {
    return json_(failure_(x, me));
  } finally {
    lock.releaseLock();
  }
}

/* ════════════════════════ Actions ════════════════════════ */

const ACTIONS = {

  login(p) {
    const user = reqStr_(p.user), pw = String(p.password == null ? '' : p.password);
    const cache = CacheService.getScriptCache(), fk = 'fail:' + user.toLowerCase();
    const fails = Number(cache.get(fk)) || 0;
    if (fails >= 5) throw new ApiError('LOGIN_LOCKED', '密碼錯誤次數過多，請 10 分鐘後再試');
    const t = readAccounts_();
    const acc = t.rows.find(r => r.user.toLowerCase() === user.toLowerCase());
    if (!acc || !acc.pw || !checkPw_(pw, acc.pw) || acc.active === 'FALSE' || !ROLES[acc.role]) {
      cache.put(fk, String(fails + 1), 600);
      throw new ApiError('LOGIN_FAILED', '帳號或密碼錯誤');
    }
    cache.remove(fk);
    update_(t, acc, { lastLogin: ts_() });
    const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    cache.put('s:' + token, acc.user, SESSION_HOURS * 3600);
    return { token, user: userOf_(acc) };
  },

  logout(p) {
    CacheService.getScriptCache().remove('s:' + p.token);
  },

  changePassword(p, me) {
    const next = String(p.next == null ? '' : p.next);
    if (next.length < 6) throw new ApiError('BAD_PAYLOAD', '新密碼至少 6 個字元');
    const t = readAccounts_();
    const acc = t.rows.find(r => r.user === me.user);
    if (!checkPw_(String(p.current == null ? '' : p.current), acc.pw)) throw new ApiError('WRONG_PASSWORD', '目前密碼不正確');
    update_(t, acc, { pw: hashPw_(next) });
  },

  book(p, me) {
    const sid = reqStr_(p.sid), slot = reqStr_(p.slot), date = reqDate_(p.date);
    selfOr_(me, sid, 'bookings', '只能用自己的身分預約');
    const cfg = readCfg_().cfg, today = today_(cfg);
    if (!cfg.students.some(s => s.id === sid)) throw new ApiError('BAD_PAYLOAD', '學員不存在');

    const sl = cfg.slots.find(s => s.id === slot);
    if (!sl) throw new ApiError('SLOT_NOT_FOUND', '時段不存在');
    if (!isOpen_(sl)) throw new ApiError('SLOT_CLOSED', '此時段不開放預約');
    const d = dow_(date);
    if (d < 1 || d > 5) throw new ApiError('NOT_WEEKDAY', '僅開放週一至週五');
    if (!inSem_(cfg, date)) throw new ApiError('OUT_OF_SEMESTER', `已超出本學期（至 ${slash_(cfg.semEnd)}）`);
    if (date < today) throw new ApiError('PAST_DATE', '此時段已結束');
    if (d === Number(cfg.trainDay) && cfg.classes.some(c => overlap_(sl, c)))
      throw new ApiError('TRAINING_CLASH', '與固定培訓時間重疊');

    const t = readTable_('bookings');
    // 與前端一致：已不存在的時段裡的預約不計入任何統計
    const slotIds = new Set(cfg.slots.map(s => s.id));
    const all = t.rows.map(bookingOf_).filter(b => slotIds.has(b.slot));
    const limit = Math.max(1, Number(cfg.noShowLimit) || 1);
    const rec = readTable_('records').rows.find(r => r.sid === sid) || {};
    const ns = Math.max(0, all.filter(b => b.sid === sid && b.status === 'noshow').length + (parseInt(rec.nsAdj, 10) || 0));
    if (rec.suspend === 'on' || (rec.suspend !== 'off' && ns >= limit))
      throw new ApiError('SUSPENDED', rec.suspend === 'on' ? '預約權限已由管理員暫停，請洽培訓專員'
        : `無故缺席已達 ${limit} 次，預約權限暫停至學期結束`);

    const mine = all.filter(b => b.sid === sid && b.date === date && LIVE.includes(b.status));
    if (mine.some(b => b.slot === slot)) throw new ApiError('DUPLICATE', '你已預約此時段');
    const clash = mine.map(b => cfg.slots.find(s => s.id === b.slot)).find(o => overlap_(sl, o));
    if (clash) throw new ApiError('TIME_OVERLAP', `與你已預約的 ${clash.name || ''} ${clash.start}–${clash.end} 時間重疊`);

    const cap = Number(cfg.capacity) || 1;
    if (all.filter(b => b.date === date && b.slot === slot && LIVE.includes(b.status)).length >= cap)
      throw new ApiError('FULL', `此時段已達上限 ${cap} 人`);

    const id = nextId_(t);
    // 預約免審核：送出即成立（額滿、重疊等規則仍由上方檢查把關）
    append_(t, decorate_('bookings', { id, sid, date, slot, status: 'confirmed', updatedAt: ts_() }, cfg));
    return { id };
  },

  cancelBooking(p, me) {
    const t = readTable_('bookings');
    const row = findById_(t, p.id);
    // 學員只能取消自己尚未簽到的預約；婉拒或取消別人的預約需要 bookings 權限
    if (!can_(me, 'bookings') && !(me.role === 'student' && row.sid === me.sid && ['pending', 'confirmed'].includes(row.status)))
      throw new ApiError('FORBIDDEN', '只能取消自己尚未簽到的預約');
    t.sh.deleteRow(row._row);
  },

  setBookingStatus(p, me) {
    need_(me, 'bookings');
    const status = reqEnum_(p.status, BOOKING_STATUS);
    const t = readTable_('bookings');
    update_(t, findById_(t, p.id), { status, updatedAt: ts_() });
  },

  submitLeave(p, me) {
    const sid = reqStr_(p.sid), date = reqDate_(p.date);
    selfOr_(me, sid, 'leaves', '只能替自己請假');
    const reason = String(p.reason == null ? '' : p.reason).trim();
    if (!reason) throw new ApiError('BAD_PAYLOAD', '請填寫請假原因');
    const cfg = readCfg_().cfg;
    if (!cfg.students.some(s => s.id === sid)) throw new ApiError('BAD_PAYLOAD', '學員不存在');
    if (dow_(date) !== Number(cfg.trainDay) || !inSem_(cfg, date))
      throw new ApiError('NOT_TRAINING_DAY', '該日非固定培訓日');
    if (date < today_(cfg)) throw new ApiError('PAST_DATE', '該培訓日已過');

    const t = readTable_('leaves');
    if (t.rows.some(r => r.sid === sid && normDate_(r.date) === date && r.status !== 'rejected'))
      throw new ApiError('DUPLICATE_LEAVE', '該日已有請假申請');
    const id = nextId_(t);
    append_(t, decorate_('leaves', { id, sid, date, reason, status: 'pending', updatedAt: ts_() }, cfg));
    return { id };
  },

  setLeaveStatus(p, me) {
    need_(me, 'leaves');
    const status = reqEnum_(p.status, LEAVE_STATUS);
    const t = readTable_('leaves');
    update_(t, findById_(t, p.id), { status, updatedAt: ts_() });
  },

  submitFault(p, me) {
    const eq = reqStr_(p.eq);
    const desc = String(p.desc == null ? '' : p.desc).trim();
    if (!desc) throw new ApiError('BAD_PAYLOAD', '請描述故障狀況');
    const cfg = readCfg_().cfg;
    if (!cfg.equipment.some(e => e.key === eq)) throw new ApiError('BAD_PAYLOAD', '設備不存在');
    const t = readTable_('faults');
    const id = nextId_(t);
    append_(t, decorate_('faults', { id, eq, desc, by: me.name, time: stamp_(cfg), status: 'open', updatedAt: ts_() }, cfg));
    return { id };
  },

  setFaultStatus(p, me) {
    need_(me, 'faultFix');
    const status = reqEnum_(p.status, FAULT_STATUS);
    const t = readTable_('faults');
    update_(t, findById_(t, p.id), { status, updatedAt: ts_() });
  },

  logUse(p, me) {
    const { t, cfg } = readCfg_();
    const item = cfg.consumables.find(c => c.id === p.item);
    if (!item) throw new ApiError('ITEM_NOT_FOUND', '耗材項目不存在');
    const qty = Number(p.qty);
    if (!Number.isInteger(qty) || qty < 1) throw new ApiError('BAD_PAYLOAD', '數量須為 1 以上的整數');
    const stock = Number(item.stock) || 0;
    if (stock < qty) throw new ApiError('INSUFFICIENT_STOCK', '庫存不足');

    // 扣庫存與寫 UseLog 在同一個鎖內
    writeCfg_(t, { consumables: cfg.consumables.map(c => c.id === item.id ? Object.assign({}, c, { stock: stock - qty }) : c) });
    append_(readTable_('useLog'), decorate_('useLog', { who: me.name, item: item.id, qty, time: stamp_(cfg) }, cfg));
  },

  restock(p, me) {
    need_(me, 'restock');
    const { t, cfg } = readCfg_();
    const item = cfg.consumables.find(c => c.id === p.item);
    if (!item) throw new ApiError('ITEM_NOT_FOUND', '耗材項目不存在');
    const stock = (Number(item.stock) || 0) + (Number(item.step) || 1);
    writeCfg_(t, { consumables: cfg.consumables.map(c => c.id === item.id ? Object.assign({}, c, { stock }) : c) });
  },

  setAttendance(p, me) {
    const date = reqDate_(p.date), sid = reqStr_(p.sid);
    if (typeof p.present !== 'boolean') throw new ApiError('BAD_PAYLOAD', '參數不完整');
    const cfg = readCfg_().cfg;
    // 只能點自己負責的班別（班別的負責職務 = 自己的角色）；attendance 權限可點全部
    const stu = cfg.students.find(s => s.id === sid);
    const cls = stu && cfg.classes.find(c => c.id === stu.group);
    if (!can_(me, 'attendance') && !(cls && cls.leadRole === me.role))
      throw new ApiError('FORBIDDEN', '只能為自己負責的班別點名');
    const t = readTable_('attendance');
    const row = t.rows.find(r => normDate_(r.date) === date && r.sid === sid);
    const rec = decorate_('attendance', { date, sid, present: p.present, updatedAt: ts_() }, cfg);
    if (row) update_(t, row, rec); else append_(t, rec);
  },

  setClosing(p) {
    const c = p.closing;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new ApiError('BAD_PAYLOAD', '參數不完整');
    const closing = {};
    Object.keys(c).forEach(k => { if (c[k]) closing[k] = true; });
    writeCfg_(readCfg_().t, { closing });
  },

  setConfig(p, me) {
    const { t, cfg } = readCfg_();
    const entries = checkCfgEntries_([{ key: p.key, value: p.value }], cfg, me);
    writeCfg_(t, entries);
  },

  setConfigBatch(p, me) {
    if (!Array.isArray(p.entries) || !p.entries.length) throw new ApiError('BAD_PAYLOAD', '參數不完整');
    const { t, cfg } = readCfg_();
    writeCfg_(t, checkCfgEntries_(p.entries, cfg, me));   // 全部驗證通過才寫入
  },

  deleteSlot(p, me) {
    need_(me, 'slots');
    const id = reqStr_(p.id);
    const { t, cfg } = readCfg_();
    const sl = cfg.slots.find(s => s.id === id);
    if (!sl) throw new ApiError('SLOT_NOT_FOUND', '時段不存在');
    assertSlotUnused_(sl);
    writeCfg_(t, { slots: cfg.slots.filter(s => s.id !== id) });
  },

  setRecord(p, me) {
    need_(me, 'records');
    const sid = reqStr_(p.sid);
    const cfg = readCfg_().cfg;
    if (!cfg.students.some(s => s.id === sid)) throw new ApiError('BAD_PAYLOAD', '學員不存在');
    const nsAdj = Number(p.nsAdj || 0);
    if (!Number.isInteger(nsAdj) || Math.abs(nsAdj) > 99) throw new ApiError('BAD_PAYLOAD', '缺席調整須為 -99 到 99 的整數');
    const suspend = reqEnum_(p.suspend || 'auto', ['auto', 'on', 'off']);
    const txt = v => String(v == null ? '' : v).trim().slice(0, 2000);
    const reason = txt(p.reason), note = txt(p.note);
    if ((nsAdj || suspend !== 'auto') && !reason) throw new ApiError('BAD_PAYLOAD', '調整缺席或停權時請填寫調整原因');
    const t = readTable_('records');
    const row = t.rows.find(r => r.sid === sid);
    const rec = decorate_('records', { sid, nsAdj, suspend, reason, note, by: me.name, updatedAt: ts_() }, cfg);
    if (row) update_(t, row, rec); else append_(t, rec);
  },

  resetDemo(p, me) {
    need_(me, 'reset');
    seedAll_();
  }
};

/* ════════════════════════ 帳號與權限 ════════════════════════ */

// token → 目前登入者。每次都重讀帳號分頁，所以停用帳號或改角色會立即生效
function auth_(token) {
  const cache = CacheService.getScriptCache();
  const user = token && cache.get('s:' + token);
  if (!user) throw new ApiError('AUTH_REQUIRED', '請先登入');
  const acc = readTable_('accounts').rows.find(r => r.user === user);
  if (!acc || acc.active === 'FALSE' || !ROLES[acc.role]) {
    cache.remove('s:' + token);
    throw new ApiError('AUTH_REQUIRED', '帳號已停用，請洽系統管理員');
  }
  cache.put('s:' + token, user, SESSION_HOURS * 3600);   // 有操作就延長
  return { user: acc.user, name: acc.name || acc.user, role: acc.role, sid: acc.sid };
}

function userOf_(a) {
  return { user: a.user, name: a.name || a.user, role: a.role, sid: a.sid || '' };
}

const can_ = (me, perm) => ROLES[me.role].perms.includes(perm);
function need_(me, perm) {
  if (!can_(me, perm)) throw new ApiError('FORBIDDEN', '你的帳號沒有此操作的權限');
}
// 學員只能替自己操作；有 perm 權限的人可以代任何學員操作
function selfOr_(me, sid, perm, msg) {
  if (can_(me, perm)) return;
  if (me.role !== 'student') throw new ApiError('FORBIDDEN', '你的帳號沒有此操作的權限');
  if (!me.sid) throw new ApiError('FORBIDDEN', '此帳號未設定學員代號，請洽系統管理員');
  if (me.sid !== sid) throw new ApiError('FORBIDDEN', msg);
}

// 讀帳號分頁，順便把「設定新密碼」欄的明碼加密後清空
function readAccounts_() {
  const t = readTable_('accounts');
  t.rows.forEach(r => { if (r.newpw) update_(t, r, { pw: hashPw_(r.newpw), newpw: '' }); });
  return t;
}

// 加鹽 SHA-256 迭代 200 次；存成「鹽$雜湊」
function hashPw_(pw, salt) {
  salt = salt || Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  let h = salt + '|' + pw;
  for (let i = 0; i < 200; i++) {
    h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8)
      .map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
  }
  return salt + '$' + h;
}
function checkPw_(pw, stored) {
  return !!stored && hashPw_(pw, String(stored).split('$')[0]) === stored;
}

function randomPw_(len) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  let out = '';
  for (let i = 0; i < len; i++) out += chars[parseInt(hex.substr(i * 2, 2), 16) % chars.length];
  return out;
}

// 試算表上方選單
function onOpen() {
  SpreadsheetApp.getUi().createMenu('人培室系統')
    .addItem('建立學員帳號（依學員名單）', 'createStudentAccounts')
    .addItem('重新套用排版', 'setup')
    .addToUi();
}

// 簡易觸發器：在「設定新密碼」欄輸入後立即加密；手動修改任何系統分頁都通知前端重新載入
function onEdit(e) {
  try {
    const name = e && e.range && e.range.getSheet().getName();
    if (name === SHEETS.accounts.name) readAccounts_();
    if (Object.keys(SHEETS).some(k => SHEETS[k].name === name)) bump_();
  } catch (x) {}
}

// 資料版本號：任何寫入後更新，前端 ping 到不同的版本就重新載入
function ver_() {
  const cache = CacheService.getScriptCache();
  return cache.get('ver') || bump_();   // 快取被清掉時產生新版本，前端多載入一次即可
}
function bump_() {
  const v = Date.now() + '-' + Math.random().toString(36).slice(2, 8);   // 加隨機碼，同一毫秒內兩次寫入也不會撞號
  CacheService.getScriptCache().put('ver', v, 21600);
  return v;
}

// 替學員名單中還沒有帳號的人建立帳號（帳號 = 學員代號），初始密碼只顯示這一次
function createStudentAccounts() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const cfg = readCfg_().cfg, t = readAccounts_();
    const has = new Set(t.rows.map(r => r.sid).filter(Boolean));
    const taken = new Set(t.rows.map(r => r.user.toLowerCase()));
    const lines = [];
    cfg.students.filter(s => !has.has(s.id)).forEach(s => {
      let user = s.id;
      for (let n = 2; taken.has(user.toLowerCase()); n++) user = s.id + '-' + n;
      taken.add(user.toLowerCase());
      const pw = randomPw_(6);
      append_(t, { user, name: s.name, role: 'student', sid: s.id, active: true, pw: hashPw_(pw) });
      lines.push(`${user}\t${s.name}\t${pw}`);
    });
    showOnce_('學員帳號已建立（初始密碼只顯示這一次，請複製保存）',
      lines.length ? '帳號\t姓名\t初始密碼\n' + lines.join('\n') : '所有學員都已有帳號，未新增。');
    return lines.length;
  } finally {
    lock.releaseLock();
  }
}

// 從試算表選單執行時跳出對話框；從 GAS 編輯器執行時寫入執行記錄
function showOnce_(title, text) {
  Logger.log(title + '\n' + text);
  try { SpreadsheetApp.getUi().alert(title, text, SpreadsheetApp.getUi().ButtonSet.OK); } catch (x) {}
}

/* ════════════════════════ 設定驗證 ════════════════════════ */

function checkCfgEntries_(list, cfg, me) {
  const out = {};
  list.forEach(en => {
    if (!en || typeof en !== 'object') throw new ApiError('BAD_PAYLOAD', '參數不完整');
    const key = en.key, v = en.value, type = Object.prototype.hasOwnProperty.call(CFG_TYPES, key) ? CFG_TYPES[key] : null;
    if (!type) throw new ApiError('BAD_CONFIG_KEY', '不允許的設定項');
    need_(me, key === 'slots' ? 'slots' : 'config');
    const bad = () => { throw new ApiError('BAD_PAYLOAD', `設定「${key}」格式錯誤`); };
    if (type === 'str' && typeof v !== 'string') bad();
    if (type === 'date' && !(v === '' || (typeof v === 'string' && isDate_(v)))) bad();
    if (type === 'num' && !(typeof v === 'number' && isFinite(v))) bad();
    if (type === 'list' && !(Array.isArray(v) && v.every(x => x && typeof x === 'object' && !Array.isArray(x)))) bad();
    out[key] = v;
  });
  // 以整包陣列覆寫 slots 時，同樣不可讓仍有預約的時段消失（等同 deleteSlot）
  if (out.slots) {
    if (out.slots.some(s => typeof s.id !== 'string' || !s.id)) throw new ApiError('BAD_PAYLOAD', '設定「slots」格式錯誤');
    const kept = new Set(out.slots.map(s => s.id));
    cfg.slots.filter(s => !kept.has(s.id)).forEach(assertSlotUnused_);
  }
  return out;
}

function assertSlotUnused_(sl) {
  const used = readTable_('bookings').rows.filter(r => r.slot === sl.id).length;
  if (used) throw new ApiError('SLOT_IN_USE', `「${sl.name || sl.id}」已有 ${used} 筆預約紀錄，無法刪除`);
}

/* ════════════════════════ 狀態組裝 ════════════════════════ */

function state_(me) {
  const cfg = readCfg_().cfg;
  const recs = readTable_('records').rows.map(r => ({ sid: r.sid, nsAdj: parseInt(r.nsAdj, 10) || 0, suspend: r.suspend || 'auto',
    reason: r.reason, note: r.note, by: r.by, updatedAt: r.updatedAt }));
  const records = me && me.role === 'student'
    ? recs.filter(r => r.sid === me.sid).map(r => ({ sid: r.sid, nsAdj: r.nsAdj, suspend: r.suspend }))
    : recs;
  const attendance = {};
  readTable_('attendance').rows.forEach(r => { if (isTrue_(r.present)) attendance[normDate_(r.date) + '|' + r.sid] = true; });
  const pub = Object.assign({}, cfg);
  delete pub.today; delete pub.closing;
  return {
    today: today_(cfg),
    bookings: readTable_('bookings').rows.map(bookingOf_),
    leaves: readTable_('leaves').rows.map(r => ({ id: Number(r.id), sid: r.sid, date: normDate_(r.date), reason: r.reason, status: r.status })),
    attendance,
    faults: readTable_('faults').rows.map(r => ({ id: Number(r.id), eq: r.eq, desc: r.desc, by: r.by, time: r.time, status: r.status })),
    // Sheet 由舊到新附加；前端要新的在前
    useLog: readTable_('useLog').rows.slice(-USELOG_RETURN).reverse().map(r => ({ who: r.who, item: r.item, qty: Number(r.qty) || 0, time: r.time })),
    closing: cfg.closing && typeof cfg.closing === 'object' ? cfg.closing : {},
    records,
    cfg: pub
  };
}

function bookingOf_(r) {
  return { id: Number(r.id), sid: r.sid, date: normDate_(r.date), slot: r.slot, status: r.status };
}

/* ════════════════════════ Sheet 存取 ════════════════════════ */

let SS_ = null;
function ss_() {
  return SS_ || (SS_ = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet());
}

function readTable_(k) {
  const def = SHEETS[k];
  const sh = ss_().getSheetByName(def.name) || (AUTO_TABLES.includes(k) ? ensureSheet_(k) : null);
  if (!sh) throw new ApiError('SETUP', `找不到分頁「${def.name}」，請先在 GAS 編輯器執行 setup()`);
  // 一律讀顯示文字，避免日期被 Sheets 轉成 Date 物件
  const vals = sh.getDataRange().getDisplayValues();
  const head = (vals[0] || []).map(h => String(h).trim());
  const idx = {};
  Object.keys(def.cols).forEach(f => {
    const i = head.indexOf(def.cols[f]);
    if (i < 0) throw new ApiError('SETUP', `分頁「${def.name}」缺少欄位「${def.cols[f]}」，請重新執行 setup()`);
    idx[f] = i;
  });
  const rows = [];
  for (let r = 1; r < vals.length; r++) {
    const v = vals[r];
    if (v.every(x => x === '')) continue;
    const o = { _row: r + 1 };
    Object.keys(idx).forEach(f => { o[f] = fromSheet_(k, f, String(v[idx[f]]).trim()); });
    rows.push(o);
  }
  return { k, sh, idx, width: head.length, rows };
}

// 物件 → 整列陣列（未對應的欄位留空）
function rowOf_(t, obj) {
  const row = new Array(t.width).fill('');
  Object.keys(t.idx).forEach(f => { if (f in obj) row[t.idx[f]] = toSheet_(t.k, f, obj[f]); });
  return row;
}

function append_(t, obj) {
  const r = t.sh.getLastRow() + 1;
  if (r > t.sh.getMaxRows()) {   // 列數用完時一次加 500 列，並把排版延伸過去
    t.sh.insertRowsAfter(t.sh.getMaxRows(), 500);
    format_(t.k, t.sh);
  }
  t.sh.getRange(r, 1, 1, t.width).setNumberFormat('@').setValues([rowOf_(t, obj)]);
  return r;
}

// 逐格寫入，保留使用者自行加在同一列的其他欄位
function update_(t, row, obj) {
  Object.keys(obj).forEach(f => {
    if (!(f in t.idx)) return;
    t.sh.getRange(row._row, t.idx[f] + 1).setNumberFormat('@').setValue(toSheet_(t.k, f, obj[f]));
    row[f] = cell_(obj[f]);
  });
}

// 內部代碼 ⇄ Sheet 顯示文字（只有 ENUMS 列出的欄位會轉換）
function toSheet_(k, f, v) {
  const c = cell_(v), e = ENUMS[k] && ENUMS[k][f];
  return e && e[c] ? e[c][0] : c;
}
function fromSheet_(k, f, s) {
  const e = ENUMS[k] && ENUMS[k][f];
  if (!e) return s;
  const hit = Object.keys(e).find(code => e[code][0] === s) || s;
  if (k === 'accounts' && f === 'role') {
    const legacy = hit === '管理人員' ? 'manager' : hit;
    return ROLE_ALIAS[legacy] || legacy;
  }
  return hit;
}

// 補上顯示用欄位
function decorate_(k, o, cfg) {
  const stu = id => (cfg.students.find(s => s.id === id) || {}).name || id;
  const x = Object.assign({}, o);
  if ('sid' in o) x.sname = stu(o.sid);
  if (k === 'bookings') {
    const sl = cfg.slots.find(s => s.id === o.slot);
    x.slotName = sl ? `${sl.name || ''} ${sl.start}–${sl.end}`.trim() : o.slot;
  }
  if (k === 'faults') {
    const e = cfg.equipment.find(q => q.key === o.eq);
    x.eqName = e ? `${e.code}・${e.type}` : o.eq;
  }
  if (k === 'useLog') x.itemName = (cfg.consumables.find(c => c.id === o.item) || {}).name || o.item;
  if (k === 'config') x.label = CFG_LABELS[o.key] || '';
  return x;
}

function findById_(t, id) {
  const n = Number(id);
  if (!isFinite(n) || id === '' || id == null) throw new ApiError('BAD_PAYLOAD', '參數不完整');
  const row = t.rows.find(r => Number(r.id) === n);
  if (!row) throw new ApiError('NOT_FOUND', '找不到資料');
  return row;
}

function nextId_(t) {
  return t.rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
}

function cell_(v) {
  if (v === true) return 'TRUE';
  if (v === false) return 'FALSE';
  return v == null ? '' : String(v);
}

/* ─── Config（逐鍵存，value 為 JSON 字串） ─── */

function readCfg_() {
  const t = readTable_('config');
  const cfg = seedCfg_();   // 缺漏的鍵以預設值補齊（與前端 Object.assign(seedCfg(), saved.cfg) 一致）
  t.rows.forEach(r => {
    if (!r.key) return;
    try { cfg[r.key] = JSON.parse(r.value); } catch (x) { cfg[r.key] = r.value; }
  });
  ['roles', 'classes', 'slots', 'students', 'equipment', 'consumables', 'rules'].forEach(k => {
    if (!Array.isArray(cfg[k])) cfg[k] = [];
  });
  return { t, cfg };
}

function writeCfg_(t, entries) {
  Object.keys(entries).forEach(key => {
    const value = JSON.stringify(entries[key]);
    const row = t.rows.find(r => r.key === key);
    if (row) update_(t, row, { value });
    else { const r = append_(t, decorate_('config', { key, value })); t.rows.push({ _row: r, key, value }); }
  });
}

/* ════════════════════════ 日期與規則 ════════════════════════ */

const pad_ = n => String(n).padStart(2, '0');
const valid_ = x => !!x && String(x.start) < String(x.end);
const overlap_ = (a, b) => valid_(a) && valid_(b) && a.start < b.end && b.start < a.end;
const isOpen_ = sl => sl.open !== 'no' && valid_(sl);
const isTrue_ = v => String(v).toUpperCase() === 'TRUE';
const slash_ = s => String(s || '').replace(/-/g, '/');
const ts_ = () => Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm:ss');

function isDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}

// 容忍 2026/9/30、2026-9-30 等手動輸入，統一成 YYYY-MM-DD
function normDate_(s) {
  const m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(String(s || '').trim());
  return m ? `${m[1]}-${pad_(m[2])}-${pad_(m[3])}` : String(s || '').trim();
}

function dow_(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function inSem_(cfg, d) {
  return (!cfg.semStart || d >= cfg.semStart) && (!cfg.semEnd || d <= cfg.semEnd);
}

function today_(cfg) {
  const t = normDate_(cfg.today);
  return isDate_(t) ? t : Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

// 與前端 now() 相同格式：MM/DD HH:mm（日期取系統今日，時間取真實時鐘）
function stamp_(cfg) {
  const t = today_(cfg);
  return t.slice(5, 7) + '/' + t.slice(8, 10) + ' ' + Utilities.formatDate(new Date(), TZ, 'HH:mm');
}

/* ─── 參數檢查 ─── */

function reqStr_(v) {
  if (typeof v !== 'string' || !v.trim()) throw new ApiError('BAD_PAYLOAD', '參數不完整');
  return v.trim();
}
function reqDate_(v) {
  if (typeof v !== 'string' || !isDate_(v)) throw new ApiError('BAD_PAYLOAD', '日期格式錯誤');
  return v;
}
function reqEnum_(v, list) {
  if (!list.includes(v)) throw new ApiError('BAD_PAYLOAD', '不支援的狀態');
  return v;
}

/* ════════════════════════ 回應 ════════════════════════ */

function ApiError(code, message) {
  this.code = code;
  this.message = message;
}

function failure_(x, me) {
  const known = x instanceof ApiError;
  const res = { ok: false, error: known ? x.code : 'SERVER', message: known ? x.message : '伺服器錯誤：' + (x && x.message || x) };
  if (me) {
    try { res.v = ver_(); res.data = state_(me); } catch (e) { res.data = null; }   // 分頁缺失時無法附帶狀態
  }
  return res;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ════════════════════════ 建表與示範資料 ════════════════════════ */

/**
 * 在 GAS 編輯器手動執行一次（之後想重新套用排版也可以再執行，不會動到資料）。
 * 建立缺少的分頁與標題列、套用排版；若 6 張分頁都沒有資料列，就寫入示範資料。
 * 已有資料時不會覆寫——要重建請在前端按「重設全部示範資料」或執行 resetDemoFromEditor()。
 */
function setup() {
  Object.keys(SHEETS).forEach(ensureSheet_);
  const empty = DATA_TABLES.every(k => readTable_(k).rows.length === 0);
  if (empty) { seedAll_(); Logger.log('已建立資料分頁並寫入示範資料'); }
  else Logger.log('分頁已存在且有資料，未覆寫；已重新套用排版');

  const acc = readAccounts_();
  if (!acc.rows.some(r => r.role === 'admin' && r.active !== 'FALSE')) {
    const pw = randomPw_(10);
    append_(acc, { user: 'admin', name: '系統管理員', role: 'admin', active: true, pw: hashPw_(pw) });
    showOnce_('已建立系統管理員帳號（密碼只顯示這一次，登入後請立即修改）', `帳號：admin\n密碼：${pw}`);
  }
}

// 建立（或補齊）一張系統分頁的標題列並套用排版；可重複執行
function ensureSheet_(k) {
  const book = ss_(), def = SHEETS[k], heads = Object.values(def.cols);
  let sh = book.getSheetByName(def.name);
  const legacy = LEGACY_NAMES[k] && book.getSheetByName(LEGACY_NAMES[k]);
  if (!sh && legacy) { legacy.setName(def.name); sh = legacy; relabel_(k, sh); }
  if (!sh) {
    try { sh = book.insertSheet(def.name, book.getNumSheets()); }
    catch (x) { sh = book.getSheetByName(def.name); }   // 兩個請求同時建立時，後到的直接沿用
    if (!sh) throw new ApiError('SETUP', `無法建立分頁「${def.name}」`);
  }
  const cur = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getDisplayValues()[0].map(String);
  const missing = heads.filter(h => !cur.includes(h));
  if (sh.getLastColumn() === 0 || cur.every(h => h === '')) {
    sh.getRange(1, 1, 1, heads.length).setValues([heads]);
  } else if (missing.length) {
    sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  }
  format_(k, sh);
  return sh;
}

// 舊版英文標題（與程式內部名稱相同）換成中文；資料裡的英文狀態仍可讀取，重設示範資料後全面換成中文
function relabel_(k, sh) {
  const n = sh.getLastColumn();
  if (!n) return;
  const r = sh.getRange(1, 1, 1, n);
  r.setValues([r.getDisplayValues()[0].map(h => SHEETS[k].cols[String(h).trim()] || h)]);
}

// 排版：深色標題列、交錯底色、欄寬、狀態下拉選單與顏色。可重複執行
function format_(k, sh) {
  const def = SHEETS[k], lay = LAYOUT[k] || {};
  const nCols = Math.max(sh.getLastColumn(), 1), nRows = sh.getMaxRows();
  const head = sh.getRange(1, 1, 1, nCols).getDisplayValues()[0].map(h => String(h).trim());
  const col = f => head.indexOf(def.cols[f]) + 1;   // 0 = 此欄不存在
  const body = c => sh.getRange(2, c, nRows - 1, 1);

  sh.setTabColor(def.tab);
  sh.setHiddenGridlines(true);
  sh.setFrozenRows(1);
  const all = sh.getRange(1, 1, nRows, nCols);
  all.setNumberFormat('@').setFontSize(10).setVerticalAlignment('middle')
     .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP).setFontColor('#3B3530');
  sh.getBandings().forEach(b => b.remove());
  all.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false)
     .setHeaderRowColor('#3B3530').setFirstRowColor('#FFFFFF').setSecondRowColor('#F6F2EA');
  sh.getRange(1, 1, 1, nCols).setFontColor('#FBF8F2').setFontWeight('bold').setFontSize(11)
    .setHorizontalAlignment('center');
  sh.setRowHeight(1, 34);
  sh.setRowHeights(2, nRows - 1, 26);

  Object.keys(lay.widths || {}).forEach(f => { const c = col(f); if (c) sh.setColumnWidth(c, lay.widths[f]); });
  (lay.center || []).forEach(f => { const c = col(f); if (c) body(c).setHorizontalAlignment('center'); });
  (lay.wrap || []).forEach(f => { const c = col(f); if (c) body(c).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP); });
  (lay.muted || []).forEach(f => { const c = col(f); if (c) body(c).setFontColor('#A89C8A'); });

  const rules = [];
  Object.keys(ENUMS[k] || {}).forEach(f => {
    const c = col(f);
    if (!c) return;
    const e = ENUMS[k][f], rng = body(c);
    rng.setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(Object.keys(e).map(code => e[code][0]), true).setAllowInvalid(false).build());
    Object.keys(e).forEach(code => {
      const [label, bg, fg] = e[code];
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(label)
        .setBackground(bg).setFontColor(fg).setBold(true).setRanges([rng]).build());
    });
  });
  sh.setConditionalFormatRules(rules);
}

function resetDemoFromEditor() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { seedAll_(); } finally { lock.releaseLock(); }
}

function seedAll_() {
  const now = ts_(), T = DEMO_TODAY;
  let id = 1;
  const b = (sid, date, slot, status) => ({ id: id++, sid, date, slot, status, updatedAt: now });
  const cfg = seedCfg_();
  cfg.closing = {};
  cfg.today = DEMO_TODAY;

  const data = {
    bookings: [
      b('A8','2026-09-14','p6','noshow'), b('B8','2026-09-15','p2','noshow'), b('B8','2026-09-22','p9','noshow'),
      b('A1','2026-09-21','p2','done'), b('A3','2026-09-21','p2','done'), b('B2','2026-09-24','p6','done'),
      b('A2','2026-09-28','p6','done'), b('B1','2026-09-28','p6','done'), b('A8','2026-09-28','p6','noshow'),
      b('A4','2026-09-29','p9','done'), b('B8','2026-09-29','p9','noshow'), b('B4','2026-09-29','p9','done'),
      b('A1',T,'p2','checkedin'), b('A6',T,'p2','done'), b('A3',T,'p2','confirmed'), b('B2',T,'p2','confirmed'), b('B5',T,'p2','pending'),
      b('A1','2026-10-01','p6','pending'), b('A2','2026-10-01','p6','confirmed'), b('B3','2026-10-01','p6','pending'), b('B4','2026-10-01','p6','confirmed'),
      b('B6','2026-10-01','p6','confirmed'), b('A5','2026-10-01','p6','confirmed'), b('A7','2026-10-01','p6','confirmed'),
      b('B7','2026-10-02','p2','pending'), b('A4','2026-10-02','p9','confirmed'), b('B1','2026-10-05','p2','pending')
    ],
    leaves: [
      { id:1, sid:'B3', date:T, reason:'身體不適', status:'approved', updatedAt:now },
      { id:2, sid:'A4', date:'2026-10-07', reason:'系上期中考', status:'pending', updatedAt:now },
      { id:3, sid:'A2', date:'2026-09-23', reason:'家中有事', status:'approved', updatedAt:now }
    ],
    faults: [
      { id:1, eq:'P3', desc:'噴頭堵塞，出料不順', by:'張家豪', time:'09/29 16:40', status:'open', updatedAt:now },
      { id:2, eq:'PC06', desc:'開機後螢幕無訊號', by:'值班研究生', time:'09/30 09:12', status:'open', updatedAt:now },
      { id:3, eq:'P1', desc:'平台調平偏移', by:'王柏凱', time:'09/24 17:05', status:'fixed', updatedAt:now }
    ],
    // 由舊到新（state_ 會反轉成新的在前）
    useLog: [
      { who:'王柏凱', item:'nozzle', qty:1, time:'09/29 17:30' },
      { who:'吳承恩', item:'cut', qty:2, time:'09/30 09:05' },
      { who:'林品妤', item:'pla', qty:1, time:'09/30 09:20' }
    ],
    attendance: [],
    records: [],
    config: Object.keys(cfg).map(key => ({ key, value: JSON.stringify(cfg[key]) }))
  };

  DATA_TABLES.forEach(k => {
    const t = readTable_(k);
    const last = t.sh.getLastRow();
    if (last > 1) t.sh.getRange(2, 1, last - 1, Math.max(t.width, 1)).clearContent();
    const rows = data[k].map(o => rowOf_(t, decorate_(k, o, cfg)));
    if (rows.length) t.sh.getRange(2, 1, rows.length, t.width).setNumberFormat('@').setValues(rows);
  });
}

// 與 index.html 的 seedCfg() 保持一致
function seedCfg_() {
  return {
    labBadge:'3D', labName:'人培室管理', labSub:'TRAINING LAB · 115-1', rulesTitle:'3D 人培室規劃與管理辦法',
    semStart:'2026-09-14', semEnd:'2026-11-13', trainDay:3, capacity:8, noShowLimit:3,
    roles:[
      {key:'trainer',title:'培訓專員',people:'小赫',duties:'整體課程規劃\n教學進度掌控\n學員培訓成果評估'},
      {key:'tutor',title:'培訓輔導員',people:'周子耘、王柏凱',duties:'現場實作指導\n學員疑難解答\n設備操作示範與基礎維護'},
      {key:'manager',title:'管理人員',people:'研究生（值班）',duties:'教室借用登記\n設備耗材盤點\n環境安全維護與緊急狀況回報'}
    ],
    classes:[
      {id:'A',code:'A 時段',start:'14:00',end:'16:00',name:'前段班',desc:'核心課程 / 基礎培訓',leadRole:'trainer'},
      {id:'B',code:'B 時段',start:'16:00',end:'18:00',name:'後段班',desc:'實作練習 / 進階輔導',leadRole:'tutor'}
    ],
    slotsV2:true,
    slots:[['p1','第1節','08:10','09:00','自由時間','隨心時刻','yes'],['p2','第2節','09:10','10:00','自由時間','隨心時刻','yes'],['p3','第3節','10:10','11:00','自由時間','隨心時刻','yes'],['p4','第4節','11:10','12:00','自由時間','隨心時刻','yes'],
      ['p5','第5節','12:50','13:40','休息時間','隨心時刻','no'],['p6','第6節','13:50','14:40','自由時間','隨心時刻','yes'],['p7','第7節','14:50','15:40','自由時間','隨心時刻','yes'],['p8','第8節','15:50','16:40','自由時間','隨心時刻','yes'],['p9','第9節','16:50','17:40','自由時間','隨心時刻','yes'],
      ['p10','第中節','17:50','18:20','吃飯時間','滿足這一刻','no'],['p11','第11節','18:30','19:30','緩衝時間','解題大冒險','yes'],['p12','第12節','19:30','20:30','訓練時間','能力修練戰','yes'],['p13','第13節','20:30','21:30','訓練時間','能力修練戰','yes'],
      ['p14','夜間','21:00','10:00','自由時間','回家睡覺','no']].map(([id,name,start,end,note,slogan,open])=>({id,name,start,end,note,slogan,open})),
    students:[['A1','林品妤'],['A2','陳冠宇'],['A3','黃詩涵'],['A4','張家豪'],['A5','李欣怡'],['A6','吳承恩'],['A7','劉宜蓁'],['A8','蔡明哲'],
      ['B1','楊子晴'],['B2','許育誠'],['B3','鄭雅婷'],['B4','謝孟軒'],['B5','郭佩珊'],['B6','洪浩然'],['B7','曾若瑜'],['B8','邱柏宇']].map(([id,name])=>({id,name,group:id[0]})),
    equipment:[['P1','3D 印表機'],['P2','3D 印表機'],['P3','3D 印表機'],['P4','3D 印表機'],['CNC','CNC 雕刻機'],['PC01','電腦'],['PC02','電腦'],['PC03','電腦'],['PC04','電腦'],['PC05','電腦'],['PC06','電腦'],['PC07','電腦'],['PC08','電腦']].map(([code,type])=>({key:code,code,type})),
    consumables:[{id:'pla',name:'PLA 絲材',unit:'捲',stock:14,min:5,max:24,step:6},{id:'cut',name:'切削料件',unit:'塊',stock:26,min:10,max:40,step:10},{id:'nozzle',name:'備用噴頭',unit:'個',stock:3,min:4,max:10,step:5}],
    checkoutItems:'設備已復原（關機、歸位、清除列印平台）\n環境已清潔（桌面、廢料、垃圾帶走）\n耗材已登記或未取用',
    closingItems:'電源已關閉\n空調已關閉\n門窗已上鎖',
    rules:[
      {id:'r1',title:'人員編制與職責',body:'培訓專員（小赫）：整體課程規劃、教學進度掌控、學員培訓成果評估。\n培訓輔導員（周子耘、王柏凱）：現場實作指導、學員疑難解答、設備操作示範與基礎維護。\n管理人員（研究生）：教室借用登記、設備耗材盤點、環境安全維護與緊急狀況回報。'},
      {id:'r2',title:'半學期固定培訓時段',body:'每週三，採 8 人一組。\nA 時段 14:00–16:00・培訓專員（小赫）・前段班（核心課程 / 基礎培訓）\nB 時段 16:00–18:00・培訓輔導員（子耘、柏凱）・後段班（實作練習 / 進階輔導）'},
      {id:'r3',title:'自由練習時段管理規範',body:'週三固定培訓以外的開放時間採預約制。\n人數上限：每一時段最高 8 人。\n預約方式：需提前於本系統登記，送出即完成預約，額滿為止。\n簽到簽退：進入前需找當值管理人員簽到，離開前需完成設備復原與環境清潔檢查。'},
      {id:'r4',title:'設備與空間使用規範',body:'設備維護：電腦設備使用前需確認狀態，如有故障需立即回報管理人員記錄；耗材（PLA 絲材、切削料件等）依規定取用並填寫消耗登記。\n環境安全：可攜帶食物但垃圾請帶走；未加蓋飲料不得進入設備區。最後離開者需確認電源、空調及門窗均已關閉。\n考核與請假：無法參加週三固定培訓需提前向培訓專員（小赫）請假；自由時段預約後無故缺席達 3 次，暫停自由預約權限至學期結束。'}
    ]
  };
}
