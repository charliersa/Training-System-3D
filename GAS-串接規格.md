# 3D 人培室管理系統 · Google Apps Script 串接規格

> 版本 1.0 ・ 2026-10-01
> 對應前端：`index.html`（861 行，dc-runtime 單檔應用）
> 後端實作：`Code.gs`（第 6 節已依「南台培訓專區-外部」試算表定案）。

---

## 1. 整體架構

```
┌─────────────────┐   fetch (text/plain)   ┌──────────────────┐   SpreadsheetApp   ┌──────────────┐
│   index.html    │ ─────────────────────► │  GAS  /exec      │ ─────────────────► │ Google Sheet │
│                 │                        │  doGet / doPost  │                    │   6 張分頁    │
│  renderVals()   │ ◄───────────────────── │  + LockService   │ ◄───────────────── │              │
└─────────────────┘   { ok, data }         └──────────────────┘                    └──────────────┘
        │
        └── localStorage（僅作離線快取，非權威來源）
```

### 設計原則

| 原則 | 說明 |
|---|---|
| **伺服器是權威來源** | 每次成功或失敗的回應都附帶完整最新狀態，前端直接整包覆蓋，不做差異合併 |
| **前端樂觀更新** | 按鈕按下立即更新畫面，再送伺服器；若伺服器拒絕，用回傳的權威狀態覆蓋回去並顯示原因 |
| **設定類本機優先** | 後台打字不即時送出（GAS 往返約 0.3–2 秒），改為停止輸入 800ms 後才推送 |
| **離線可降級** | `API_URL` 留空時完全走現有 localStorage 行為，等同目前的示範模式 |

### 狀態分類

前端 `DATA_KEYS` 共 11 個鍵，並非全部都上傳：

| 鍵 | 去向 | 理由 |
|---|---|---|
| `bookings` `leaves` `attendance` `faults` `useLog` `closing` | **上傳** | 共用紀錄 |
| `cfg` | **上傳**（逐鍵） | 共用設定 |
| `role` `me` `page` | **僅本機** | 每台裝置各自的 UI 狀態，不該同步 |
| `nextId` | **廢除** | 改由伺服器在鎖內指派 id |

---

## 2. Sheet 結構（6 張分頁）

> **重要**：日期欄位請先把整欄格式設為「純文字」（格式 → 數值 → 純文字），
> 否則 Sheets 會把 `2026-10-06` 自動轉成日期物件，讀回來變成 `Date` 而非字串。
> `Code.gs` 讀取時仍會做一次正規化防呆，但設成純文字可以少掉一類問題。

### 2.1 `Bookings` — 自由練習預約

| 欄 | 型別 | 範例 | 說明 |
|---|---|---|---|
| `id` | 數字 | `28` | 伺服器在鎖內指派 `max(id)+1` |
| `sid` | 文字 | `A1` | 學員代號，對應 `Config.students` |
| `date` | 文字 | `2026-10-06` | `YYYY-MM-DD`，僅週一至週五 |
| `slot` | 文字 | `p6` | 時段代號，對應 `Config.slots` |
| `status` | 文字 | `pending` | 見下方狀態機 |
| `updatedAt` | 文字 | `2026/10/01 18:22:31` | 台北時間，僅供人閱讀 |

**狀態機**

```
            ┌──────────────── noshow（無故未到，計入停權）
            │
pending ──► confirmed ──► checkedin ──► done
  │              │
  └──────────────┴──► （刪除列：學員取消 / 管理者婉拒）
```

- 預約免審核：`book` 直接寫入 `confirmed`；`pending` 只保留給舊資料相容
- `live` 狀態 = `pending` `confirmed` `checkedin` `done` → **計入人數上限**
- `noshow` 不計入人數，但計入停權次數
- 取消與婉拒是**刪除整列**，不是改狀態

### 2.2 `Leaves` — 固定培訓請假

| 欄 | 型別 | 範例 |
|---|---|---|
| `id` | 數字 | `4` |
| `sid` | 文字 | `A4` |
| `date` | 文字 | `2026-10-07`（必須是培訓日） |
| `reason` | 文字 | `系上期中考` |
| `status` | 文字 | `pending` / `approved` / `rejected` |
| `updatedAt` | 文字 | ISO 8601 |

### 2.3 `Faults` — 設備故障回報

| 欄 | 型別 | 範例 |
|---|---|---|
| `id` | 數字 | `4` |
| `eq` | 文字 | `P3`，對應 `Config.equipment[].key` |
| `desc` | 文字 | `噴頭堵塞，出料不順` |
| `by` | 文字 | `張家豪` |
| `time` | 文字 | `09/29 16:40`（顯示字串） |
| `status` | 文字 | `open` / `fixed` |
| `updatedAt` | 文字 | ISO 8601 |

### 2.4 `UseLog` — 耗材取用紀錄

| 欄 | 型別 | 範例 |
|---|---|---|
| `who` | 文字 | `林品妤` |
| `item` | 文字 | `pla`，對應 `Config.consumables[].id` |
| `qty` | 數字 | `1` |
| `time` | 文字 | `09/30 09:20` |

> 無 `id`：這是純附加的流水紀錄，不會被修改或刪除。
> 前端只顯示最新 6 筆，伺服器建議保留全部（或定期歸檔）。

### 2.5 `Attendance` — 固定培訓點名

| 欄 | 型別 | 範例 |
|---|---|---|
| `date` | 文字 | `2026-09-30` |
| `sid` | 文字 | `A1` |
| `present` | 布林 | `TRUE` |
| `updatedAt` | 文字 | ISO 8601 |

> `(date, sid)` 為複合主鍵；寫入時先找同鍵列，有就更新、沒有就新增。
> 前端狀態格式是 `{ "2026-09-30|A1": true }`，由 `Code.gs` 負責雙向轉換。

### 2.6 `Config` — 系統設定

| 欄 | 型別 | 範例 |
|---|---|---|
| `key` | 文字 | `capacity` |
| `value` | 文字 | `8` 或 JSON 字串 |

**鍵清單**（`value` 一律存 `JSON.stringify` 後的字串）

| key | 型別 | 預設 | 用途 |
|---|---|---|---|
| `labBadge` | 字串 | `3D` | 左上角標誌 |
| `labName` | 字串 | `人培室管理` | 系統名稱 |
| `labSub` | 字串 | `TRAINING LAB · 115-1` | 副標 |
| `rulesTitle` | 字串 | `3D 人培室規劃與管理辦法` | 管理辦法標題 |
| `semStart` | 字串 | `2026-09-14` | 學期開始 |
| `semEnd` | 字串 | `2026-11-13` | 學期結束 |
| `trainDay` | 數字 | `3` | 固定培訓日（0=日 … 6=六） |
| `capacity` | 數字 | `8` | 每時段人數上限 |
| `noShowLimit` | 數字 | `3` | 無故缺席停權門檻 |
| `roles` | 陣列 | 3 筆 | `{key,title,people,duties}` |
| `classes` | 陣列 | 2 筆 | `{id,code,start,end,name,desc,leadRole}` |
| `slots` | 陣列 | 14 筆 | `{id,name,start,end,note,slogan,open}` |
| `students` | 陣列 | 16 筆 | `{id,name,group}` |
| `equipment` | 陣列 | 13 筆 | `{key,code,type}` |
| `consumables` | 陣列 | 3 筆 | `{id,name,unit,stock,min,max,step}` |
| `rules` | 陣列 | 4 筆 | `{id,title,body}` |
| `checkoutItems` | 字串 | 3 行 | 簽退檢查項目，`\n` 分行 |
| `closingItems` | 字串 | 3 行 | 最後離開者檢查項目 |
| `slotsV2` | 布林 | `true` | 時段結構版本標記，**請勿改動** |
| `closing` | 物件 | `{}` | 最後離開者勾選狀態，key 為項目文字 |
| `today` | — | — | **已停用**：系統一律使用台灣真實日期，Sheet 裡若還有此列可刪除 |

> **為什麼要逐鍵存而不是整包 JSON 存一格**
> 學員現在可以編輯 `slots`。若整包存一格，學員改時段時會連帶覆蓋管理者剛改的 `students`。
> 逐鍵存可讓不同鍵的編輯互不干擾。同一個鍵的同時編輯仍是後寫者勝（見第 7 節）。

---

## 3. API 契約

### 3.1 通用規則

**端點**：`https://script.google.com/macros/s/<DEPLOY_ID>/exec`

**請求**
```js
// 讀取
GET  {EXEC_URL}?action=load

// 寫入 —— Content-Type 必須是 text/plain，原因見第 5 節
POST {EXEC_URL}
Content-Type: text/plain;charset=utf-8

{ "action": "book", "sid": "A1", "date": "2026-10-06", "slot": "p6" }
```

**回應信封**

成功：
```json
{
  "ok": true,
  "data": {
    "today": "2026-09-30",
    "bookings": [ ... ],
    "leaves": [ ... ],
    "attendance": { "2026-09-30|A1": true },
    "faults": [ ... ],
    "useLog": [ ... ],
    "closing": { "電源已關閉": true },
    "cfg": { ... }
  }
}
```

失敗：
```json
{
  "ok": false,
  "error": "FULL",
  "message": "此時段已達上限 8 人",
  "data": { ... 同上，完整最新狀態 ... }
}
```

> **失敗時也回傳 `data`** 是刻意的：前端的樂觀更新需要用權威狀態覆蓋回去。
> 例如兩人同時搶最後一個名額，失敗那位的畫面會立刻從「9/8」修正成「8/8 額滿」。

**同步機制**：每次寫入都會更新資料版本號（手動改系統分頁也會，由 `onEdit` 觸發）。
前端每 5 秒呼叫 `GET ?action=ping&token=…`（只查快取、不讀 Sheet），版本不同才呼叫 `load` 重新載入；
`load` 與寫入回應都附 `v`。分頁在背景時暫停詢問。

**`error` 代碼一覽**

| 代碼 | `message` 範例 | 觸發時機 |
|---|---|---|
| `BAD_ACTION` | 未知的操作 | `action` 不在清單內 |
| `BAD_PAYLOAD` | 參數不完整 | 必填欄位缺漏或型別錯誤 |
| `LOCK_TIMEOUT` | 伺服器忙碌，請重試 | `waitLock` 逾時（10 秒） |
| `NOT_FOUND` | 找不到資料 | 依 id 查無該列 |
| `SLOT_NOT_FOUND` | 時段不存在 | `slot` 不在 `cfg.slots` |
| `SLOT_CLOSED` | 此時段不開放預約 | `open === 'no'` 或 `start >= end` |
| `NOT_WEEKDAY` | 僅開放週一至週五 | `dow` 不在 1–5 |
| `OUT_OF_SEMESTER` | 已超出本學期（至 2026/11/13） | 不在 `[semStart, semEnd]` |
| `PAST_DATE` | 此時段已結束 | `date < today`，或今天且時段結束時間已過（台灣時間） |
| `TRAINING_CLASH` | 與固定培訓時間重疊 | 培訓日且與 `classes` 時間重疊 |
| `SUSPENDED` | 無故缺席已達 3 次，預約權限暫停至學期結束 | `noshow >= noShowLimit` |
| `DUPLICATE` | 你已預約此時段 | 同 `sid+date+slot` 已有 live 預約 |
| `TIME_OVERLAP` | 與你已預約的 第6節 13:50–14:40 時間重疊 | 同日其他時段時間重疊 |
| `FULL` | 此時段已達上限 8 人 | live 人數 >= `capacity` |
| `NOT_TRAINING_DAY` | 該日非固定培訓日 | 請假日期不是培訓日 |
| `DUPLICATE_LEAVE` | 該日已有請假申請 | 同 `sid+date` 已有未退回的請假 |
| `ITEM_NOT_FOUND` | 耗材項目不存在 | `item` 不在 `cfg.consumables` |
| `INSUFFICIENT_STOCK` | 庫存不足 | `stock < qty` |
| `SLOT_IN_USE` | 「第6節」已有 12 筆預約紀錄，無法刪除 | 刪除仍有預約的時段 |
| `BAD_CONFIG_KEY` | 不允許的設定項 | `key` 不在第 2.6 節允許清單內 |

### 3.2 Action 清單

對應到前端的 18 個操作：

#### 讀取

| action | 參數 | 說明 |
|---|---|---|
| `load` | — | 回傳完整狀態。前端 `componentDidMount` 呼叫 |

#### 預約

| action | 參數 | 伺服器行為 |
|---|---|---|
| `book` | `sid` `date` `slot` | 跑完第 4.1 節全部檢查 → `append` 一列（`status: pending`）→ 回傳新 `id` |
| `cancelBooking` | `id` | 刪除整列（學員取消、管理者婉拒共用） |
| `setBookingStatus` | `id` `status` | 改狀態。`status` 須為 `confirmed` `checkedin` `done` `noshow` 之一 |

> 前端的「確認」「簽到」「無故未到」「完成簽退」四個按鈕都走 `setBookingStatus`。

#### 請假

| action | 參數 | 伺服器行為 |
|---|---|---|
| `submitLeave` | `sid` `date` `reason` | 檢查第 4.2 節 → `append`（`status: pending`） |
| `setLeaveStatus` | `id` `status` | `approved` / `rejected` |

#### 設備與耗材

| action | 參數 | 伺服器行為 |
|---|---|---|
| `submitFault` | `eq` `desc` `by` | `append`（`status: open`），`time` 由伺服器產生 |
| `setFaultStatus` | `id` `status` | 目前只會收到 `fixed` |
| `logUse` | `who` `item` `qty` | **原子操作**：檢查庫存 → 扣 `cfg.consumables[].stock` → `append` UseLog |
| `restock` | `item` | `stock += step` |

#### 點名與檢查

| action | 參數 | 伺服器行為 |
|---|---|---|
| `setAttendance` | `date` `sid` `present` | 以 `(date,sid)` upsert |
| `setClosing` | `closing`（物件） | 覆寫 `Config.closing` |

#### 設定

| action | 參數 | 伺服器行為 |
|---|---|---|
| `setConfig` | `key` `value` | 寫入單一 Config 鍵。`key` 須在允許清單內 |
| `setConfigBatch` | `entries`（陣列） | 一次寫多鍵。後台防彈跳推送用，省往返 |
| `deleteSlot` | `id` | 先查 `Bookings` 是否有該時段紀錄，有就回 `SLOT_IN_USE` |
| `resetDemo` | — | 清空 6 張分頁並重新寫入示範資料 |

> `deleteSlot` 單獨拉出來，是因為刪時段的副作用比其他設定嚴重：
> 被刪時段的預約會從畫面消失，而缺席次數與考核紀錄都是從預約推算的——
> 刪一個時段會回溯抹掉學員的缺席紀錄，連已停權的人都會自動解除停權。
> 前端已有同樣的守衛（`index.html:772`），伺服器端需再擋一次。

---

## 4. 伺服器端驗證規則

所有寫入操作都包在 `LockService.getScriptLock()` 內，`waitLock(10000)`。
**檢查必須在鎖內重讀 Sheet**，不可信任前端傳來的計數。

### 4.1 `book` 的檢查順序

依序檢查，第一個失敗就回傳（順序會影響使用者看到哪一個訊息）：

```
1. slot 存在                      → SLOT_NOT_FOUND
2. slot.open !== 'no'
   且 slot.start < slot.end       → SLOT_CLOSED
3. dow(date) in 1..5              → NOT_WEEKDAY
4. semStart <= date <= semEnd     → OUT_OF_SEMESTER
5. date >= today，且若為今天，slot.end > 現在時刻（台灣時間） → PAST_DATE
6. 若 dow(date) === trainDay：
   slot 與任一 class 時間重疊      → TRAINING_CLASH
7. 該 sid 的 noshow 數 < noShowLimit → SUSPENDED
8. 無同 sid+date+slot 的 live 預約  → DUPLICATE
9. 該 sid 同日無時間重疊的 live 預約 → TIME_OVERLAP
10. 該 date+slot 的 live 數 < capacity → FULL
```

**時間重疊判定**（與前端 `index.html:508` 一致）
```js
const valid   = x => !!x && String(x.start) < String(x.end);
const overlap = (a, b) => valid(a) && valid(b) && a.start < b.end && b.start < a.end;
```
兩邊都要檢查 `valid`。跨午夜或顛倒的時間範圍（例如 `21:00–10:00`）視為無效區間，
一律不重疊、也不可預約——這同時擋掉了「把跨午夜時段設為開放」造成的錯誤判定。

### 4.2 `submitLeave` 的檢查

```
1. dow(date) === trainDay 且在學期內 → NOT_TRAINING_DAY
2. 無同 sid+date 且 status !== 'rejected' 的請假 → DUPLICATE_LEAVE
```

### 4.3 `logUse` 的檢查

```
1. item 存在於 cfg.consumables          → ITEM_NOT_FOUND
2. qty 為 >= 1 的整數                   → BAD_PAYLOAD
3. consumables[item].stock >= qty       → INSUFFICIENT_STOCK
```
扣庫存與寫 UseLog 必須在同一個鎖內完成，避免兩人同時取用把庫存扣成負數。

### 4.4 帳號、登入與角色權限

所有操作（含 `load`）都需要登入；只有 `login` 例外。前端在每個請求帶上 `token`，伺服器每次重讀「帳號管理」分頁確認帳號仍啟用、角色為何，
所以**停用帳號或改角色會立即生效**，不必等登入逾時。

**帳號管理分頁**：帳號、姓名、角色、學員代號、狀態、設定新密碼、密碼（已加密）、最後登入

- 密碼以「隨機鹽 + SHA-256 迭代 200 次」存放，Sheet 裡看不到明碼
- 新增或重設密碼：在「設定新密碼」欄輸入，`onEdit` 觸發器會立即加密並清空該格
  （注意：試算表的「版本記錄」仍可能留下輸入時的明碼，請只讓管理員有試算表編輯權）
- 第一次執行 `setup()` 會建立 `admin` 帳號，隨機密碼只在執行記錄顯示一次
- 試算表選單「人培室系統 → 建立學員帳號」：依學員名單替尚無帳號的學員建立帳號（帳號 = 學員代號），初始密碼只在對話框顯示一次
- 登入有效 6 小時，有操作就延長；同一帳號連續輸錯 5 次鎖定 10 分鐘
- 「重設全部示範資料」不會清除帳號

**固定角色**（寫在 `Code.gs` 的 `ROLES`，前端 `ROLE_PERMS` 需一致）

| 權限 | 系統管理員 | 培訓專員 | 培訓輔導員 | 編輯人員 | 學員 |
|---|:-:|:-:|:-:|:-:|:-:|
| 婉拒／取消預約、簽到簽退、登記缺席 | ✓ | | | | |
| 審核請假 | ✓ | ✓ | | | |
| 點名 | 全部班別 | 負責班別 | 負責班別 | | |
| 標記故障修復 | ✓ | | ✓ | | |
| 耗材補貨 | ✓ | | | | |
| 編輯後台設定（全部頁籤） | ✓ | | | ✓ | |
| 編輯「自由編排時段」 | ✓ | | | ✓ | ✓ |
| 重設全部資料 | ✓ | | | | |
| 調整缺席、停權、考核備註 | ✓ | ✓ | | | |
| 查看考核紀錄 | ✓ | ✓ | ✓ | ✓ | |
| 預約、取消、請假 | 可代任何學員 | 可代任何學員（請假） | | | 僅限自己 |
| 回報故障、登記耗材取用、最後離開檢查 | ✓ | ✓ | ✓ | ✓ | ✓ |

- 原「管理人員」角色已併入系統管理員；帳號管理分頁裡仍填「管理人員」的帳號自動視為系統管理員
- **考核調整**（`考核調整` 分頁，每位學員一列）：缺席調整（可為負數）＋停權設定（依規則／強制停權／解除停權）＋調整原因＋備註。
  有效缺席 = 預約紀錄中的 `noshow` 數 + 缺席調整；伺服器預約時同樣依此判定停權。調整缺席或停權必須填原因。
  學員看不到考核頁，`load` 只回傳自己的調整數字（不含原因與備註）。新增 action：`setRecord`（`sid` `nsAdj` `suspend` `reason` `note`）。
  已部署的系統更新後不必重跑 `setup()`，缺少此分頁時會自動建立。
- **預約免審核**：學員送出即為「已確認」，額滿、重疊、停權等規則仍由伺服器把關
- 「負責班別」依後台「培訓班別」的負責職務判定
- 故障回報人、耗材取用人一律以登入帳號的姓名記錄，不採用前端傳來的值
- 新增錯誤代碼：`AUTH_REQUIRED`（未登入或逾時）、`LOGIN_FAILED`、`LOGIN_LOCKED`、`FORBIDDEN`、`WRONG_PASSWORD`
- 新增 action：`login`（`user` `password` → `token` `user`）、`logout`、`changePassword`（`current` `next`）

離線示範模式（`API_URL` 留空）沒有登入，左側可切換 6 種角色預覽各自的權限畫面。

---|---|---|
| **業務規則** | ✅ 能 | 人數上限、庫存、重複、時間重疊、學期範圍——這些與「誰在操作」無關，伺服器重讀資料就能判斷 |
| **角色權限** | ❌ 不能 | 「只有管理者能確認預約」「只有培訓專員能審請假」「只有學員能編輯時段」——這些都只是前端 UI 的限制 |

具體後果：
- 任何知道 `/exec` 網址的人都能送 `setBookingStatus`，把自己的 `noshow` 改成 `done`，自行解除停權
- 也能送 `setConfig` 把 `noShowLimit` 改成 `999`，或送 `resetDemo` 清空全部資料
- 前端的角色按鈕、`STUDENT_LISTS` 權限表，都只是介面層的約束

**這是你明確選擇的取捨**（換到不需要 Google 帳號、打開就能用），文件記錄在此以免日後誤判。
若之後要補強，成本最低的路徑是：

1. 加一組 `ADMIN_KEY` 存在 Script Properties，`setConfig` / `setBookingStatus` / `setLeaveStatus` / `resetDemo` 需帶此鍵
2. 管理者在後台輸入一次並存在自己的 localStorage，學員端完全不知道這組鍵
3. 學員能做的 `book` / `cancelBooking`(限自己) / `submitLeave` / `submitFault` / `logUse` 不需要鍵

這樣學員就改不了別人的紀錄，也不必引入 Google 帳號登入。要做的話跟我說。

---

## 5. 部署步驟與 CORS 注意事項

### 5.1 部署設定

```
GAS 編輯器 → 部署 → 新增部署作業 → 類型選「網頁應用程式」

  說明         ：v1
  執行身分     ：我（your-account@gmail.com）
  具有存取權的人：任何人          ← 不是「任何人（匿名）」以外的選項都會擋掉前端
```

複製產生的 `/exec` 網址，填進 `index.html` 最上方：

```js
const API_URL = 'https://script.google.com/macros/s/AKfycb.../exec';
```

留空字串則前端完全走離線示範模式（localStorage），不會發出任何請求。

### 5.2 四個一定會踩到的坑

**① POST 的 Content-Type 必須是 `text/plain`**

GAS 的網頁應用程式**不會回應 `OPTIONS` 預檢請求**。
若用 `Content-Type: application/json`，瀏覽器會先送預檢 → GAS 不回應 → 整個請求失敗（且錯誤訊息看起來像 CORS 問題，很難查）。

解法是讓它成為「簡單請求」，不觸發預檢：

```js
fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },  // ← 不是 application/json
  body: JSON.stringify(payload)
});
```

GAS 端照樣用 `JSON.parse(e.postData.contents)` 解析，完全不受影響。

**② 不要加任何自訂 header**

`Authorization`、`X-Api-Key` 之類的自訂 header 一樣會觸發預檢。
密鑰請放在 request body 裡（若之後採用 4.4 節的 `ADMIN_KEY` 方案）。

**③ 改完程式碼一定要「建立新版本」**

GAS 最常見的困惑：改了 `Code.gs` 按儲存，`/exec` 卻還是舊行為。
因為 `/exec` 服務的是**已部署的版本快照**，不是編輯器裡的最新碼。

```
部署 → 管理部署作業 → 編輯（鉛筆圖示）→ 版本：新版本 → 部署
```

網址不會變。每次改完後端都要做這一步。

**④ GAS 會 302 轉址**

`/exec` 會轉到 `script.googleusercontent.com`。`fetch` 預設 `redirect: 'follow'`，
會自動跟隨並在最終回應帶上允許跨來源的標頭，所以**不需要特別處理**——
但如果你把 `redirect` 設成 `'manual'` 或用了某些 HTTP 客戶端，就會卡在 302。

### 5.3 效能預期

| 操作 | 典型耗時 |
|---|---|
| `load`（6 張分頁全讀） | 0.8 – 2.0 秒 |
| 寫入類（含搶鎖） | 0.4 – 1.5 秒 |
| 冷啟動（久未使用後第一次） | 可能 3 秒以上 |

這是 GAS 的固有延遲，無法最佳化掉。前端的對應策略：

- 離散動作（預約、簽到、審核）：樂觀更新，畫面先動，不讓使用者等
- 後台打字：本機優先，停止輸入 800ms 後才推送，避免每個按鍵一次往返
- 顯示 `pending` 計數，有在途請求時給一點視覺提示

---

## 6. 欄位對應（已定案）

目標試算表：**南台培訓專區-外部**（腳本以「擴充功能 → Apps Script」綁定，`SHEET_ID` 留空）

既有的 8 張分頁（自由編排時段、專案培訓介紹、專案培訓每周任務、交流與學習資料清單、
專案管理系統、命名規則系統、資料打包、DAZ說明與注意事項）都是合併儲存格的展示版面，
沒有一張能當資料表用，因此**不做對應、也不會被讀寫**。`setup()` 會在同一份試算表
另外新增 6 張系統分頁，分頁名稱、標題列、狀態值都以中文顯示（程式內部仍用第 2 節的英文欄位名與代碼，
由 `Code.gs` 在讀寫時轉換，前端不受影響）：

| 分頁 | 對應第 2 節 | 欄位（左起） |
|---|---|---|
| 預約紀錄 | `Bookings` | 編號、日期、時段、學員、狀態、學員代號、時段代號、最後更新 |
| 請假申請 | `Leaves` | 編號、培訓日、學員、請假原因、狀態、學員代號、最後更新 |
| 培訓點名 | `Attendance` | 培訓日、學員、出席、學員代號、最後更新 |
| 故障回報 | `Faults` | 編號、回報時間、設備、故障描述、回報人、狀態、設備代號、最後更新 |
| 耗材取用 | `UseLog` | 時間、取用人、耗材、數量、耗材代號 |
| 系統設定 | `Config` | 說明、設定項、內容（JSON） |

- **狀態中文化**：`pending`→待確認、`confirmed`→已確認、`checkedin`→在場中、`done`→已簽退、`noshow`→無故未到；
  請假 待審核／已核准／已退回；故障 待處理／已修復；點名 出席／未出席。狀態欄有下拉選單與顏色，手動改 Sheet 時選中文即可（英文代碼也接受）
- **顯示用欄位**（學員、時段、設備、耗材、說明）只在寫入當下填入，程式不讀；學員改名後舊紀錄保留當時姓名
- **排版**：深色標題列、交錯底色、隱藏格線、分頁顏色、固定欄寬；`setup()` 可重複執行以重新套用排版，不會動資料
- **舊版英文分頁**（`Bookings` 等）：`setup()` 會自動改名並換成中文標題，資料保留

> 「自由編排時段」分頁的內容與 `Config.slots` 的第 1–中節相同，但兩者**不會同步**——
> 系統只讀 `Config`。若要以那張分頁為準，需另外寫匯入，目前未做。

| 決策 | 結論 |
|---|---|
| 既有資料 | 無可沿用的資料表，直接以示範資料建立（`setup()` / `resetDemo`） |
| `today` | 一律使用台灣真實日期與時刻（Asia/Taipei）；前端同樣以台灣時區計算，不受裝置時區影響。週末打開預約表直接顯示下週 |
| UseLog 歸檔 | 暫不做；Sheet 保留全部，`load` 只回傳最新 200 筆 |
| `resetDemo` / `setup()` 範圍 | 只清除並重寫上述 6 張分頁，其他分頁一律不碰 |

> **不需要給我 `/exec` 網址。**
> 因為沒有身分驗證，那個網址本身就等於密碼——知道的人就能寫入或清空資料。
> 它只會出現在 `index.html` 的 `API_URL` 那一行，你自己填即可。

### 實作補充（規格未明訂、`Code.gs` 的做法）

- `book` / `submitLeave` 會檢查 `sid` 存在於 `cfg.students`；`submitFault` 檢查 `eq` 存在 → 否則 `BAD_PAYLOAD`
- `submitLeave` 額外擋已過的培訓日 → `PAST_DATE`
- `setConfig("slots", …)` 若整包陣列少了仍有預約的時段，同樣回 `SLOT_IN_USE`（與 `deleteSlot` 同一道防線）
- `setConfig` 不接受 `today` `slotsV2` `closing`（前兩者只能在 Sheet 手改，`closing` 走 `setClosing`）
- `setConfigBatch` 全部驗證通過才寫入，任一筆錯誤就整批不寫
- `book` `submitLeave` `submitFault` 成功時回應多帶 `id`：`{ ok, id, data }`
- 試算表尚未執行 `setup()` 時，所有請求回 `error: "SETUP"`

---

## 7. 已知限制

| 限制 | 影響 | 可否改善 |
|---|---|---|
| 帳號密碼由自家 Sheet 管理 | 無「忘記密碼」自助重設，需請管理員在 Sheet 重設 | 可改用 Google 帳號登入 |
| 同一 Config 鍵的併發編輯 | 兩人同時改 `slots`，後寫者勝，前者的修改無聲消失 | 可加 `updatedAt` 做樂觀鎖，衝突時提示重載 |
| GAS 延遲 0.4–2 秒 | 離散動作需等待回應才確認 | 無法消除，已用樂觀更新掩蓋 |
| 無即時推播 | A 的預約不會自動出現在 B 的畫面 | 可加輪詢（如每 30 秒 `load`），但會吃 GAS 配額 |
| GAS 每日配額 | 免費帳號約 20,000 次/日、總執行 90 分鐘/日 | 人培室規模遠低於上限，不需擔心 |
| 改時段時間會搬動現有預約 | 把「第2節 09:10」改成「20:00」，既有預約跟著移到晚上且無提示 | 前端未擋，可加確認或鎖定有預約的時段 |

---

## 8. 下一步

1. ~~提供第 6 節對應~~ ✅
2. ~~產出 `Code.gs`（含一鍵建表的 `setup()` 與示範資料匯入）~~ ✅（離線 mock 測試 92 條斷言通過）
3. ~~改 `index.html`：加入 `API_URL`、同步層、把 18 個操作接上伺服器，並保留離線模式~~ ✅（雙客戶端模擬 34 條斷言通過；另每 30 秒輪詢，Sheet 手動修改也會回到 App）
4. 你貼上部署、填入網址、測試
5. 回歸驗證（現有的 Node 測試腳本可驗離線路徑；線上路徑需你實機測一輪）

> 前置作業已完成：九項缺失修復 + 學員可編排時段，皆已驗證（324 組合、21 極端設定、29 條斷言全通過）。
> 備份：`index.html.bak`（原始）、`index.html.bak2`（開放學員編輯前）。
