import { source } from "@/lib/source";
import { createFromSource } from "fumadocs-core/search/server";

export const revalidate = false;

export const { staticGET: GET } = createFromSource(source, {
	// https://zbsearch.dev/docs/zbsearch/text-analysis/stemming
	language: "multilingual",
});
