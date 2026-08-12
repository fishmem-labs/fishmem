import { BrandMark } from "@/components/site/brand-logo";
import { BRAND_CONTACT_EMAIL, BRAND_NAME } from "@/lib/config";

const groups = [
	{
		title: "Product",
		links: [
			["Dashboard", "/dashboard"],
			["Blog", "/blog"],
		],
	},
	{
		title: "Developers",
		links: [
			["Sign in", "/login"],
			["Documentation", "https://docs.fishmem.com"],
			["API keys", "/login"],
		],
	},
	{
		title: "Legal",
		links: [
			["Privacy", "/privacy"],
			["Terms", "/terms"],
		],
	},
];

export function SiteFooter() {
	return (
		<footer className="border-t border-border bg-background">
			<div className="mx-auto grid max-w-7xl gap-10 px-5 py-12 md:grid-cols-[1.2fr_2fr]">
				<div>
					<div className="flex items-center gap-2 font-semibold text-foreground">
						<BrandMark className="h-8 w-8" />
						{BRAND_NAME}
					</div>
					<p className="mt-4 max-w-md text-sm leading-6 text-muted-foreground">
						Inspectable memory for AI agents: scoped REST resources, hybrid
						graph and vector recall, temporal facts, and source-preserving RAG
						on the open-source FishMem engine.
					</p>
					<a
						className="mt-5 inline-flex text-sm text-muted-foreground hover:text-foreground"
						href={`mailto:${BRAND_CONTACT_EMAIL}`}
					>
						{BRAND_CONTACT_EMAIL}
					</a>
				</div>
				<div className="grid gap-8 sm:grid-cols-3">
					{groups.map((group) => (
						<div key={group.title}>
							<h3 className="text-sm font-semibold text-foreground">
								{group.title}
							</h3>
							<ul className="mt-3 space-y-2 text-sm text-muted-foreground">
								{group.links.map(([label, href]) => (
									<li key={`${label}-${href}`}>
										<a href={href} className="hover:text-foreground">
											{label}
										</a>
									</li>
								))}
							</ul>
						</div>
					))}
				</div>
			</div>
		</footer>
	);
}
