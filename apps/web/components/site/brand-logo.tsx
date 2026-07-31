import { BRAND_NAME } from "@/lib/config";
import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      alt={`${BRAND_NAME} logo`}
      className={cn("rounded-sm object-contain", className)}
      height={32}
      src="/logo.svg"
      width={32}
    />
  );
}

export function BrandLogo({ className }: { className?: string }) {
  return (
    <a className={cn("inline-flex items-center gap-2", className)} href="/">
      <BrandMark className="h-6 w-6" />
      <span>{BRAND_NAME}</span>
    </a>
  );
}
