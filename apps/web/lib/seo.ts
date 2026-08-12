import { BRAND_NAME, SITE_URL } from "@/lib/config";

export type MarketingPageHeadInput = {
  title: string;
  description: string;
  path: string;
  type?: "website" | "article";
  image?: string;
};

export function marketingPageHead({
  title,
  description,
  path,
  type = "website",
  image,
}: MarketingPageHeadInput) {
  const canonical = new URL(path, `${SITE_URL}/`).toString();
  const socialImage = image
    ? new URL(image, `${SITE_URL}/`).toString()
    : undefined;

  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:type", content: type },
      { property: "og:site_name", content: BRAND_NAME },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: canonical },
      ...(socialImage
        ? [{ property: "og:image", content: socialImage }]
        : []),
      {
        name: "twitter:card",
        content: socialImage ? "summary_large_image" : "summary",
      },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
    ],
    links: [{ rel: "canonical", href: canonical }],
  };
}
