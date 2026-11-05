import { readableOn } from '@bigtours/shared';

/** 活動主色：按鈕文字與連結顏色依深淺自動調整，確保看得清楚。 */
export function brandStyle(themeColor: string) {
  const on = readableOn(themeColor);
  return {
    '--brand': themeColor,
    '--on-brand': on,
    '--brand-text': on === '#FFFFFF' ? themeColor : '#15202B',
  } as React.CSSProperties;
}
