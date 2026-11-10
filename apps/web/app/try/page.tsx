import { GoogleTagManager } from '../site/gtm';
import { TryDemo } from './try-demo';

export const metadata = { title: '試玩報名｜Bookdex 大團報名', robots: { index: false, follow: false } };

export default function TryPage() {
  return (
    <>
      <GoogleTagManager />
      <TryDemo />
    </>
  );
}
