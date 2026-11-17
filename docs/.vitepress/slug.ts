/** A heading's anchor as GitHub makes it, before the `-1`, `-2` suffix a repeated heading takes. */
export const slug = (heading: string): string =>
	heading
		.trim()
		.toLowerCase()
		.replace(/`([^`]*)`|<[^>]+>/g, (_, code: string | undefined) => code ?? "")
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");
