import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';
import { i18nConfig } from './i18n';

export function baseOptions(locale: 'en' | 'zh' = 'en'): BaseLayoutProps {
  return {
    nav: {
      title: appName,
      url: locale === 'zh' ? '/zh' : '/',
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    i18n: i18nConfig,
  };
}
