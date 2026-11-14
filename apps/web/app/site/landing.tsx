import './site.css';
import { TrialForm } from './trial-form';

const LineIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 3C6.5 3 2 6.6 2 11c0 3.9 3.5 7.2 8.3 7.9.3.1.8.2.9.5.1.3.1.7 0 1l-.1.9c0 .3-.2 1 .9.5s5.9-3.5 8.1-5.9C21.6 14.3 22 12.7 22 11c0-4.4-4.5-8-10-8z" />
  </svg>
);

export const FAQS: [string, string][] = [
  ['員工需要註冊帳號嗎？', '不用自己註冊。企業提供員工名單後，系統會寄出設定密碼的連結，員工用員工編號登入就能報名，之後也用同一組帳號查看或申請取消。'],
  ['很多人同時搶報，會不會超賣？', '不會。員工開始填寫時就保留名額 15 分鐘，名額判斷在資料庫裡一次完成，就算同時很多人送出也不會超過名額。'],
  ['除了員工旅遊，也能用在會議或其他活動嗎？', '可以。家庭日、運動會、尾牙、內部會議、教育訓練這類以員工為對象的大人數活動，都能用梯次設定場次與名額、自訂報名欄位，員工登入就能報名。'],
  ['可以用我們旅行社自己的品牌嗎？', '可以。每家旅行社有自己的網址，例如 bigtour.bookdex.cc/你的代號，報名頁也能顯示企業的 Logo。'],
  ['企業窗口可以自己管理名單嗎？', '可以。旅行社建立活動後，企業窗口可以匯入員工名單、設定補助、查看報名進度，但看不到員工的身分證等個資。'],
  ['試用要怎麼開通？', '填寫下方的申請表，到信箱點開通連結、設定密碼，馬上就能使用。每個統一編號可以試用一次。'],
];

export function Landing({ domain, demoUrl, lineUrl, siblingUrl }: { domain: string; demoUrl: string; lineUrl: string | null; siblingUrl: string }) {
  const contactHref = lineUrl ?? '#signup';
  const lineProps = lineUrl ? { href: lineUrl, target: '_blank', rel: 'noopener' } : { href: '#signup' };
  return (
    <div className="bt">
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link rel="stylesheet" precedence="default" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+TC:wght@400;500;600;700&display=swap" />

      <header className="top">
        <div className="wrap top-row">
          <a className="brand" href="#top"><img className="brand-logo" src="/bookdex-logo-light.svg" alt="Bookdex" width={148} height={40} /><span className="brand-name">大團報名</span></a>
          <nav className="top-nav" aria-label="主選單">
            <a href="#features">功能</a>
            <a href="#how">運作方式</a>
            <a href="#demo">試玩報名</a>
            <a href="#security">資料安全</a>
            <a href="#faq">常見問題</a>
          </nav>
          <div className="top-cta">
            {lineUrl && <a className="btn btn-line btn-sm" {...lineProps}><LineIcon /><span>LINE 詢問</span></a>}
            <a className="btn btn-dark btn-sm" href="#signup">免費試用</a>
          </div>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="wrap">
            <span className="pill"><b>免費</b>試用 30 天・不用信用卡</span>
            <h1>大人數活動報名系統<br />搶報也不超賣</h1>
            <p className="lead">給旅行社、企業福委與 HR 的團體報名系統，員工旅遊、家庭日、會議與活動報名都適用。員工登入就能報名，名額先保留 15 分鐘，公司補助自動計算，名單一鍵匯出。</p>
            <div className="actions">
              <a className="btn btn-dark btn-lg" href="#signup">免費試用 30 天</a>
              <a className="btn btn-text btn-lg" href={demoUrl}>先試試員工報名畫面 ›</a>
            </div>
            <div className="glow" aria-hidden="true">
              <div className="glow-inner">
                <div className="app">
                  <div className="app-side">
                    <div className="app-brand"><span></span>示範旅行社</div>
                    <div className="app-item on">活動總覽</div>
                    <div className="app-item">梯次與團費</div>
                    <div className="app-item">自選行程</div>
                    <div className="app-item">旅客欄位</div>
                    <div className="app-item">員工名單</div>
                    <div className="app-item">報名管理<em>2</em></div>
                  </div>
                  <div className="app-main">
                    <div className="app-top">
                      <div><p className="app-title">2027 艾克米員工旅遊・沖繩三日</p><p>艾克米科技・報名截止 1/15</p></div>
                      <span className="chip">已發布</span>
                    </div>
                    <div className="stats">
                      <div className="stat"><small>已報名旅客</small><strong>186</strong><span>/ 200</span></div>
                      <div className="stat"><small>名額保留中</small><strong>7</strong></div>
                      <div className="stat"><small>待確認取消</small><strong>2</strong></div>
                    </div>
                    <div className="board">
                      <div className="board-row"><b>3/1</b><span>第一梯・三天兩夜</span><span className="s s-ok">剩 3 位</span></div>
                      <div className="board-row"><b>3/8</b><span>第二梯・三天兩夜</span><span className="s s-held">名額保留中，可稍後再試</span></div>
                      <div className="board-row"><b>3/15</b><span>第三梯・三天兩夜</span><span className="s s-out">已額滿</span></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="fits" aria-label="適合的活動">
          <div className="wrap">
            <p>適合這些團體活動</p>
            <ul><li>員工旅遊</li><li>家庭日</li><li>獎勵旅遊</li><li>企業參訪</li><li>運動會</li><li>春酒尾牙</li><li>內部會議</li><li>教育訓練</li></ul>
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <h2 className="split-title">告別 Excel 和表單收名單。<span>名額、補助、個資，系統都幫你算好、管好。</span></h2>
            <div className="cards-3">
              <article className="card">
                <div className="card-stage" aria-hidden="true">
                  <div className="widget">
                    <div className="w-timer"><span>名額保留倒數</span><b>14:32</b></div>
                    <div className="w-line"><span>第一梯 3/1 出發</span><span>保留 3 位</span></div>
                    <div className="w-line"><span>美麗海水族館</span><span>保留 2 位</span></div>
                  </div>
                </div>
                <h3>開始填寫就保留名額</h3>
                <p>員工選好梯次與人數就保留 15 分鐘，填完資料才不會發現已額滿；同時搶報也不會超賣。</p>
              </article>
              <article className="card">
                <div className="card-stage" aria-hidden="true">
                  <div className="widget">
                    <div className="w-line"><span>員工本人＋成人眷屬</span><span>$28,000</span></div>
                    <div className="w-line"><span>公司補助</span><span>-$10,000</span></div>
                    <div className="w-line sum"><span>員工自付</span><span>$18,000</span></div>
                  </div>
                </div>
                <h3>公司補助自動計算</h3>
                <p>每位員工可以設定不同的補助金額與眷屬人數，可折抵眷屬費用，自付金額即時算好。</p>
              </article>
              <article className="card">
                <div className="card-stage" aria-hidden="true">
                  <div className="widget">
                    <div className="w-link"><span>E001 王小明</span><span className="st ok">已報名</span></div>
                    <div className="w-link"><span>E002 林美惠</span><span className="st wait">待確認取消</span></div>
                    <div className="w-link"><span>E003 陳志豪</span><span className="st">未報名</span></div>
                  </div>
                </div>
                <h3>只有名單上的員工能報名</h3>
                <p>員工用員工編號登入，名單外的人進不來，同一位員工也不會重複報名。</p>
              </article>
            </div>
          </div>
        </section>

        <section id="features" className="section tight">
          <div className="wrap">
            <div className="feature">
              <div className="feature-text">
                <span className="tag blue"><i>◎</i>自選行程</span>
                <h2>每個人想去的地方不一樣</h2>
                <p>把第二天行程、加購活動、房型做成選項，每個選項可以依梯次設定名額與加價，員工替每位同行者各自選。</p>
                <ul className="checks"><li>必選、可複選都能設定</li><li>選項額滿自動停止選擇</li><li>改價只影響之後的新報名</li></ul>
              </div>
              <div className="feature-stage" aria-hidden="true">
                <div className="widget" style={{ maxWidth: 320 }}>
                  <strong>第二天行程</strong><small style={{ color: '#6b6b6b', marginLeft: 6 }}>必選</small>
                  <div className="opt on"><span>美麗海水族館</span><span><small>剩 4 位</small> +$2,000</span></div>
                  <div className="opt"><span>市區觀光</span><span>不加價</span></div>
                  <div className="opt"><span>浮潛體驗</span><span><small>已額滿</small></span></div>
                </div>
              </div>
            </div>
            <div className="feature flip">
              <div className="feature-text">
                <span className="tag green"><i>↗</i>員工名單</span>
                <h2>名單用檔案匯入，先檢查再寫入</h2>
                <p>下載範本填好就能上傳。重複的員工編號、格式錯誤的 Email 會先標出來，確認後才寫入，再一次寄出設定密碼的通知。</p>
                <ul className="checks"><li>補助與眷屬上限可以逐人設定</li><li>報名進度、付款狀態一目了然</li><li>旅客總表、分房表一鍵匯出</li></ul>
              </div>
              <div className="feature-stage" aria-hidden="true">
                <div className="widget" style={{ maxWidth: 320 }}>
                  <strong>檢查結果</strong>
                  <div className="w-line" style={{ marginTop: 8 }}><span>可匯入</span><span>132 位</span></div>
                  <div className="w-line"><span>新增／更新</span><span>128／4</span></div>
                  <div className="w-line" style={{ color: '#b42318' }}><span>第 17 列</span><span>Email 格式不正確</span></div>
                  <div className="w-line" style={{ color: '#b42318' }}><span>第 52 列</span><span>員工編號重複</span></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="how" className="section tight">
          <div className="wrap">
            <div className="section-head"><h2>三個角色，各做各的</h2><p>旅行社、企業窗口與員工，各自只需要做自己那一段。</p></div>
            <ol className="steps">
              <li><b>01</b><h3>旅行社建立活動</h3><p>設定梯次、團費、自選行程與報名欄位，報名頁顯示企業的 Logo。</p></li>
              <li><b>02</b><h3>企業提供員工名單</h3><p>匯入名單與每人補助，系統寄出設定密碼的通知給每位員工。</p></li>
              <li><b>03</b><h3>員工登入報名</h3><p>用手機選梯次、人數與行程，填好資料就完成，費用即時算好。</p></li>
            </ol>
          </div>
        </section>

        <section id="demo" className="section tight">
          <div className="wrap">
            <div className="demo">
              <div>
                <span className="tag orange"><i>▶</i>試玩</span>
                <h2>先用員工的角度報名一次</h2>
                <p style={{ color: '#6b6b6b' }}>示範活動可以從選梯次一路報名到送出，實際感受名額保留與費用計算。不用登入，示範資料每天清晨自動清空。</p>
                <a className="btn btn-dark btn-lg" href={demoUrl}>開始試玩報名</a>
              </div>
              <div className="phone" aria-hidden="true">
                <div className="phone-head"><small>示範旅行社</small><strong>2027 艾克米員工旅遊・沖繩三日</strong></div>
                <div className="phone-body">
                  <div className="phone-row"><span><b>3/1</b> 第一梯</span><span>剩 3 位</span></div>
                  <div className="phone-row"><span><b>3/8</b> 第二梯</span><span>名額保留中</span></div>
                  <div className="phone-row"><span>第 1 位旅客　員工本人</span><span>$15,000</span></div>
                  <div className="phone-row"><span>第 2 位旅客　成人眷屬</span><span>$12,000</span></div>
                </div>
                <div className="phone-bar"><span>您需自付<br /><strong>$17,000</strong></span><span className="go">開始填寫</span></div>
              </div>
            </div>
          </div>
        </section>

        <section id="security" className="section">
          <div className="wrap">
            <div className="section-head"><span className="tag orange"><i>◆</i>資料安全</span><h2>旅客個資，從第一天就保護好</h2><p>身分證、護照這類資料，存、看、匯出都有規則，企業客戶也能放心交給你。</p></div>
            <div className="badges">
              <div>
                <span className="ico" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg></span>
                <h3>敏感資料加密與遮罩</h3><p>身分證與護照加密儲存，畫面上只顯示部分內容，查看與匯出都留下紀錄。</p>
              </div>
              <div>
                <span className="ico" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg></span>
                <h3>每家旅行社完全隔開</h3><p>資料庫層就把每家旅行社的資料分開，彼此看不到也改不到。</p>
              </div>
              <div>
                <span className="ico" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg></span>
                <h3>到期自動刪除</h3><p>活動結束後依你設定的天數，自動刪除或去識別化旅客個資，預設 180 天。</p>
              </div>
            </div>
          </div>
        </section>

        <section id="pricing" className="section tight">
          <div className="wrap">
            <div className="section-head"><h2>先免費試用，再決定</h2><p>試用期間所有功能都能用，不需要信用卡。</p></div>
            <div className="price">
              <div className="feat">
                <h3>免費試用</h3>
                <strong className="big">30 天</strong>
                <p style={{ color: '#6b6b6b' }}>適合先跑一場小型活動</p>
                <ul><li>一場活動，最多 40 位旅客</li><li>所有功能都能用，通知信最多 100 封</li><li>專屬網址 {domain}/你的代號</li></ul>
                <a className="btn btn-dark" href="#signup">申請免費試用</a>
              </div>
              <div>
                <h3>正式方案</h3>
                <strong className="big">依活動計費</strong>
                <p style={{ color: '#6b6b6b' }}>依每場活動的人數級距收費</p>
                <ul><li>從 200 人到 5,000 人的活動都適用</li><li>用多少場付多少場</li><li>由專人協助開通</li></ul>
                <a className="btn btn-light" {...lineProps}>詢問方案價格</a>
              </div>
            </div>
          </div>
        </section>

        <section id="faq" className="section tight">
          <div className="wrap" style={{ maxWidth: 760 }}>
            <div className="section-head"><h2>常見問題</h2></div>
            <div className="faq">
              {FAQS.map(([q, a], i) => <details key={q} open={i === 0}><summary>{q}</summary><p>{a}</p></details>)}
            </div>
          </div>
        </section>

        <section id="signup" className="signup-band">
          <div className="wrap signup-grid">
            <div>
              <span className="pill"><b>免費</b>試用 30 天</span>
              <h2>申請免費試用</h2>
              <p style={{ color: '#6b6b6b' }}>送出後到信箱點開通連結、設定密碼，馬上就能使用。試用 30 天，可以建立一場活動，最多 40 位旅客。</p>
              {lineUrl && <p style={{ color: '#6b6b6b' }}>還在考慮？<a href={lineUrl} target="_blank" rel="noopener">用 LINE 問我們</a></p>}
            </div>
            <div className="glow">
              <div className="glow-inner">
                <TrialForm domain={domain} />
              </div>
            </div>
          </div>
        </section>

        {lineUrl && (
          <section id="contact" className="contact">
            <div className="wrap contact-row">
              <div><h2 style={{ fontSize: 28 }}>有問題？用 LINE 問我們</h2><p style={{ color: '#6b6b6b', margin: 0 }}>功能、價格或怎麼開始，都可以直接傳訊息。</p></div>
              <a className="btn btn-line btn-lg" href={contactHref} target="_blank" rel="noopener">加入 LINE 官方帳號</a>
            </div>
          </section>
        )}
      </main>

      <footer className="foot">
        <div className="wrap foot-row">
          <span>© Bookdex 大團報名</span>
          <span>也看看 <a href={siblingUrl}>Bookdex 預約簿</a>：健身與美容美體店的線上預約系統</span>
        </div>
      </footer>

      {lineUrl && <a className="btn btn-line float-line" href={lineUrl} target="_blank" rel="noopener"><LineIcon />LINE 詢問</a>}
    </div>
  );
}
