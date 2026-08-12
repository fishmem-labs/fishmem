'use client';
import SearchDialog from '@/components/search';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { type ReactNode, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { i18nUI } from '@/lib/i18n';

export function Provider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const locale = pathname === '/zh' || pathname.startsWith('/zh/') ? 'zh' : 'en';
  const provider = i18nUI.provider(locale);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

  return (
    <RootProvider
      i18n={{
        ...provider,
        onLocaleChange(nextLocale) {
          const englishPath = pathname === '/zh' ? '/' : pathname.replace(/^\/zh\//, '/');
          document.documentElement.lang = nextLocale === 'zh' ? 'zh-CN' : 'en';
          router.push(nextLocale === 'zh' ? (englishPath === '/' ? '/zh' : `/zh${englishPath}`) : englishPath);
        },
      }}
      search={{ SearchDialog }}
    >
      {children}
    </RootProvider>
  );
}
