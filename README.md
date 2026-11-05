# bigtours-saas

大團系統：團體行程報名 SaaS。需求與設計文件在 [docs/](docs/)：[PRD](docs/PRD.md)、[系統架構](docs/ARCHITECTURE.md)、[資料模型](docs/DATA_MODEL.md)。

## 本機啟動

只需要 Docker，不用在電腦上安裝 Node.js 或 pnpm。

```bash
docker compose up --build
```

第一次會下載映像檔與安裝套件，需要幾分鐘。看到 API 與前端都啟動後，開啟 <http://demo-travel.lvh.me:3000/acme-2027> 登入，密碼都是 `demo1234`：

- `E001` 王小明（預設補助，可帶 2 位眷屬）
- `E002` 林美惠（補助 $20,000，可帶 3 位眷屬）
- `E003` 陳志豪（補助 $5,000，不能帶眷屬）

`E004` 張雅婷尚未設定密碼，用[設定密碼連結](http://demo-travel.lvh.me:3000/acme-2027/set-password/demo-e004-local-development-only)走一次開通流程。連結只能使用一次，重設示範資料後可再次使用。

從舊版更新時，請重設示範資料。

第二梯次只有 3 個名額，方便測試額滿與保留狀態。`*.lvh.me` 會指回本機，需要網路才能解析。

| 服務 | 網址 |
|---|---|
| 前端 | <http://demo-travel.lvh.me:3000> |
| API | <http://localhost:4000> |
| PostgreSQL | `localhost:5432`（帳號密碼 `postgres`） |
| Mailpit（信件） | <http://localhost:8025> |

`apps`、`packages/shared/src` 的程式修改後會自動重新載入。

## 常用指令

| 目的 | 指令 |
|---|---|
| 啟動 | `docker compose up --build` |
| 停止，保留資料 | `docker compose down` |
| 停止並清除所有資料 | `docker compose down -v` |
| 重設示範資料 | `docker compose run --rm migrate pnpm exec tsx db/seed.ts` |
| 執行測試（需先啟動） | `docker compose run --rm --no-deps api pnpm --filter @bigtours/shared --filter @bigtours/api test` |
| 檢查型別 | `docker compose run --rm --no-deps api pnpm -r typecheck` |
| 新增或更新套件後 | `docker compose up --build` |

新增套件時，先在容器內更新 lockfile：`docker compose run --rm --no-deps -v "$PWD:/app" api pnpm --filter @bigtours/web add <套件>`。

如果 3000、4000、5432 等連接埠已被占用，請先停止占用的程式，或修改 `docker-compose.yml` 的 `ports`。

## 專案結構

| 路徑 | 內容 |
|---|---|
| `apps/api` | NestJS API |
| `apps/web` | Next.js 員工報名前台 |
| `packages/shared` | 前後端共用的驗證規則、費用計算與加密工具 |
| `db` | Migration 與示範資料 |
| `docs` | PRD、架構與資料模型 |

## 目前進度

已完成員工設定密碼、登入、從保留名額到送出報名的流程，以及申請取消。尚未開發：後台（平台、旅行社、企業窗口與登入，含寄帳號信、產生設定密碼連結、活動頁開關與梯次航班設定）、員工名單匯入、Email 寄送、付款說明、資料匯出、分房確認、報名後修改、背景工作（清理逾時保留、到期刪除個資）、條款上傳與級距上限檢查。Mailpit 已備好，尚未接上程式。本機檔案儲存服務等開發條款與圖片上傳時再加入。
