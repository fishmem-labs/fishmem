import Image from 'next/image';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';
import { i18nConfig } from './i18n';

export function baseOptions(locale: 'en' | 'zh' = 'en'): BaseLayoutProps {
  return {
    nav: {
      title: <span className="inline-flex items-center gap-2.5">
        <Image unoptimized src="/logo.png" alt="" width={28} height={28} className="rounded-[5px]" />
        <span>{appName}</span>
      </span>,
      url: locale === 'zh' ? '/zh' : '/',
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    i18n: i18nConfig,
  };
}
