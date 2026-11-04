# bigtours-saas

大團系統：團體行程報名 SaaS。需求與設計文件在 [docs/](docs/)：[PRD](docs/PRD.md)、[系統架構](docs/ARCHITECTURE.md)、[資料模型](docs/DATA_MODEL.md)。

## 本機啟動

需要 Node.js 22 以上、pnpm 與 Docker。

```bash
cp .env.example .env
pnpm install
pnpm db:up        # 啟動 PostgreSQL、MinIO、Mailpit
pnpm db:migrate   # 建立資料表與應用程式資料庫角色
pnpm db:seed      # 建立示範資料，並印出員工專屬連結
pnpm dev          # 前端 :3000、API :4000
```

開啟 `db:seed` 印出的連結即可報名，例如：
<http://demo-travel.lvh.me:3000/acme-2027/e/demo-e001-local-development-only>

`*.lvh.me` 會指回本機，需要網路才能解析。第二梯次只有 3 個名額，方便測試額滿與保留狀態。重新執行 `pnpm db:seed` 會重設示範資料。

| 服務 | 網址 |
|---|---|
| 前端 | <http://demo-travel.lvh.me:3000> |
| API | <http://localhost:4000> |
| Mailpit（信件） | <http://localhost:8025> |
| MinIO（檔案） | <http://localhost:9001> |

## 測試

資料庫啟動並完成 migration 後執行：

```bash
pnpm test        # 費用計算與 API 整合測試（含併發防超賣）
pnpm typecheck
```

## 專案結構

| 路徑 | 內容 |
|---|---|
| `apps/api` | NestJS API |
| `apps/web` | Next.js 員工報名前台 |
| `packages/shared` | 前後端共用的驗證規則、費用計算與加密工具 |
| `db` | Migration 與示範資料 |
| `docs` | PRD、架構與資料模型 |

## 目前進度

已完成員工從保留名額到送出報名的流程，以及申請取消。尚未開發：後台（平台、旅行社、企業窗口與登入）、員工名單匯入、Email 寄送、資料匯出、分房確認、報名後修改、背景工作（清理逾時保留、到期刪除個資）、條款上傳與級距上限檢查。MinIO 與 Mailpit 已備好，尚未接上程式。
