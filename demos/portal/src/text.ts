export function money(amount: number): string {
	const whole = Math.round(amount).toString();
	return `A$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

export function clock(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

export function listed(items: readonly string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface ISegment {
	Text: string;
	Bold: boolean;
}

export function segments(text: string): ISegment[] {
	return text
		.split("**")
		.map((part, i) => ({
			Text: part,
			Bold: i % 2 === 1
		}))
		.filter((s) => s.Text !== "");
}
