import type { IRestoreLines } from "../portal/restoreBanner";
import type { IChatRestore, IReplyStream } from "./Chat";

/** "in #design", or "to you" for a direct message. */
export function streamWhere(stream: IReplyStream): string {
	return stream.Where === null ? "to you" : `in ${stream.Where}`;
}

function streamLine(stream: IReplyStream): string {
	const where = streamWhere(stream);
	if (stream.Letters === 0) return `${stream.Who} was typing ${where}, and the message's stream reopened from its row`;
	return `${stream.Who}'s message ${where}, part-way through, and its stream reopened from the letter it had reached`;
}

/** The reload hint's line for a teammate's message on its way, told the way the banner will tell it. */
export function reloadLine(stream: IReplyStream): string {
	const where = streamWhere(stream);
	if (stream.Letters === 0) return `${stream.Who} is typing ${where}, and a reload reopens the message's stream from its row.`;
	return `${stream.Who}'s message ${where} carries on from the letter it reached.`;
}

export function chatRestoreLines(note: IChatRestore): IRestoreLines {
	const unread = note.Unread > 0 ? `, with ${note.Unread} unread` : "";
	const lost = note.Unsent.map((where) => `Your message to ${where}, which was sending`);
	if (note.Unsent.length > 0) lost.push(`${note.Unsent.length === 1 ? "It" : "They"} came back as Didn't send, with Retry`);
	return {
		Back: [
			`Team chat's ${note.Conversations} conversations and their messages${unread}`,
			...note.Streams.map(streamLine)
		],
		Lost: lost
	};
}
