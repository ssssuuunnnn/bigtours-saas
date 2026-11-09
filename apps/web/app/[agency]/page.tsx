export const metadata = { robots: { index: false, follow: false } };

/** 旅行社網址本身沒有內容；員工從公司提供的活動網址進入。 */
export default function AgencyHome() {
  return <main className="center-note"><h1>請使用公司提供的報名網址</h1></main>;
}
