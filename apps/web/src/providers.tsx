"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 30_000
          }
        }
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster
        closeButton
        gap={8}
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast:
              "!rounded-lg !border !border-border !bg-popover !text-popover-foreground !shadow-lg !text-[13px] !gap-2.5 !px-3.5 !py-3",
            title: "!text-[13px] !font-medium",
            description: "!text-xs !text-muted-foreground",
            actionButton: "!h-7 !rounded-md !text-xs !font-medium",
            cancelButton: "!h-7 !rounded-md !text-xs",
            closeButton:
              "!border-border !bg-popover !text-muted-foreground hover:!text-foreground",
            icon: "!size-4",
          },
        }}
      />
    </QueryClientProvider>
  );
}
