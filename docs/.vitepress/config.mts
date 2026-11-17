import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DefaultTheme, defineConfig } from "vitepress";
import { links, tabs } from "./markdown";
import { slug } from "./slug";
import { headScript } from "./theme/tabChoice";

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(DOCS, "..");
// The packages' `repository.url` names the same repo.
const REPO = "https://github.com/Tgoh/treflex";

/** The pages the site publishes, as paths under `docs/`; a trailing slash takes a folder. */
const SITE = [
	"README.md",
	"quickstart.md",
	"requirements.md",
	"guide/",
	"patterns.md",
	"reference/",
	"design/principles.md",
	"design/choices.md"
];

const SECTIONS = [
	"Guide",
	"Patterns",
	"Reference",
	"Design"
];

const onSite = (page: string): boolean => SITE.some((entry) => (entry.endsWith("/") ? page.startsWith(entry) : page === entry));

function markdownUnder(dir: string): string[] {
	return readdirSync(resolve(DOCS, dir), {
		withFileTypes: true
	}).flatMap((entry) => {
		const path = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			return entry.name.startsWith(".") || entry.name === "node_modules" ? [] : markdownUnder(path);
		}
		return entry.name.endsWith(".md")
			? [
					path
				]
			: [];
	});
}

const pages = markdownUnder("");

function exclusions(prefix: string): string[] {
	const inside = pages.filter((page) => page.startsWith(prefix));
	if (!inside.some(onSite)) {
		return [
			`${prefix}**`
		];
	}
	const rest = inside.map((page) => page.slice(prefix.length));
	const files = rest.filter((name) => !name.includes("/") && !onSite(prefix + name)).map((name) => prefix + name);
	const folders = new Set(rest.filter((name) => name.includes("/")).map((name) => name.split("/")[0]));
	return [
		...files,
		...[
			...folders
		].flatMap((folder) => exclusions(`${prefix}${folder}/`))
	];
}

function rewrite(href: string, page: string): string {
	if (/^[a-z][a-z+.-]*:/i.test(href) || href.startsWith("#")) {
		return href;
	}
	const at = href.indexOf("#");
	const path = at < 0 ? href : href.slice(0, at);
	const hash = at < 0 ? "" : href.slice(at);
	const target = posix.normalize(posix.join(posix.dirname(relative(ROOT, page).replace(/\\/g, "/")), path));
	if (target.startsWith("docs/") && onSite(target.slice("docs/".length))) {
		// The README is served as index.html, and VitePress would turn a link to README.md into README.html.
		return target === "docs/README.md" ? `${path.slice(0, -"README.md".length)}index.md${hash}` : href;
	}
	let folder = path.endsWith("/");
	try {
		folder ||= statSync(resolve(ROOT, target)).isDirectory();
	} catch {}
	return `${REPO}/${folder ? "tree" : "blob"}/main/${target.replace(/\/$/, "")}${hash}`;
}

const titleOf = (page: string): string => /^# (.+)$/m.exec(readFileSync(resolve(DOCS, page), "utf8"))?.[1] ?? page;

function sidebar(): DefaultTheme.SidebarItem[] {
	const items: DefaultTheme.SidebarItem[] = [];
	let section: DefaultTheme.SidebarItem[] | undefined = items;
	const seen = new Set<string>();
	for (const line of readFileSync(resolve(DOCS, "README.md"), "utf8").split(/\r?\n/)) {
		const heading = /^## (.+)$/.exec(line);
		if (heading) {
			section = SECTIONS.includes(heading[1]) ? [] : undefined;
			if (section) {
				items.push({
					text: heading[1],
					items: section
				});
			}
			continue;
		}
		for (const [, target] of line.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
			const page = posix.normalize(target);
			if (!section || page === "README.md" || !onSite(page) || seen.has(page)) {
				continue;
			}
			seen.add(page);
			section.push({
				text: titleOf(page),
				link: `/${page.slice(0, -".md".length)}`
			});
		}
	}
	return items.map((item) => (item.items?.length === 1 ? item.items[0] : item));
}

export default defineConfig({
	title: "treflex",
	description: "A runtime for app state and the work running on it, for Solid and React",
	head: [
		[
			"script",
			{},
			headScript
		]
	],
	srcExclude: exclusions(""),
	rewrites: {
		"README.md": "index.md"
	},
	markdown: {
		anchor: {
			slugify: slug
		},
		config: (md) => {
			md.use(tabs);
			links(md, rewrite);
		}
	},
	themeConfig: {
		sidebar: sidebar(),
		outline: {
			level: [
				2,
				3
			]
		},
		search: {
			provider: "local"
		},
		socialLinks: [
			{
				icon: "github",
				link: REPO
			}
		]
	}
});
