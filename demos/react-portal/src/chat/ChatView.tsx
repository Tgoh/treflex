import type { FormEvent, RefObject } from "react";
import type { ISelected } from "treflex-react";
import type { IChatRow } from "../../../portal/src/chat/Chat";
import type { IRestoreProps } from "../shell/RestoreBanner";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { sendable } from "../../../portal/src/chat/Conversation";
import { conversationLabel, person } from "../../../portal/src/chat/directory";
import { LETTER_FADE_MS, lettersAfter, voucherButton } from "../../../portal/src/chat/Message";
import { cx } from "../shell/dom";
import { RestoreBanner } from "../shell/RestoreBanner";
import { Chat, Conversation, Message } from "./contexts";

function Avatar(props: { id: string }) {
	return (
		<span
			className="pa"
			style={{
				background: person(props.id).Colour
			}}
		>
			{person(props.id).Initials}
		</span>
	);
}

function Row(props: { row: ISelected<IChatRow>; onOpen: () => void }) {
	const row = props.row;
	return (
		<button
			type="button"
			className={cx("ch", {
				on: row.On,
				unread: row.Bold
			})}
			onClick={() => props.onOpen()}
		>
			{row.Channel ? (
				<span className="h">#</span>
			) : (
				<span
					className={cx("pa", {
						on: row.Online
					})}
					style={{
						background: row.Colour
					}}
				>
					{row.Initials}
				</span>
			)}
			<span className="nm">{row.Name}</span>
			{row.Note ? <span className="typ">{row.Note}</span> : null}
			{row.Badge > 0 ? <span className="n">{row.Badge}</span> : null}
		</button>
	);
}

function MessageText(props: { text: string; streaming: boolean; arriving: boolean }) {
	const [seen] = useState(() => (props.arriving ? 0 : props.text.length));
	const [fading, setFading] = useState(props.streaming);
	const streaming = props.streaming;
	useEffect(() => {
		if (streaming || !fading) return;
		const timer = setTimeout(() => setFading(false), LETTER_FADE_MS);
		return () => clearTimeout(timer);
	}, [
		streaming,
		fading
	]);
	if (!fading) return props.text;
	return (
		<>
			{props.text.slice(0, seen)}
			{lettersAfter(props.text, seen).map((letter, at) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: by position, so a letter already shown keeps its node and doesn't fade in again
				<span className="letter" key={at}>
					{letter}
				</span>
			))}
		</>
	);
}

const MessageRow = Message.provider<{
	day: string | null;
	mounted: RefObject<boolean>;
}>((props) => {
	const [arriving] = useState(() => props.mounted.current);
	const message = Message.use();
	const chat = Chat.use();
	const state = message.state;
	const mine = state.From === "me";
	const status = message.sendStatus();
	const voucher = voucherButton(state, chat.state.VoucherApplied);
	return (
		<>
			{props.day ? <div className="day">{props.day}</div> : null}
			<div
				className={cx("m", {
					mine,
					streaming: state.Streaming,
					sending: status === "sending",
					failed: status === "failed"
				})}
			>
				<Avatar id={state.From} />
				<div>
					<div className="who">
						{person(state.From).Name}
						<time>{state.At}</time>
					</div>
					<p>
						<MessageText text={state.Text} streaming={state.Streaming} arriving={arriving} />
						{state.Streaming ? <span className="caret" /> : null}
					</p>
					{voucher ? (
						<button
							type="button"
							className={cx("btn voucher", {
								applied: voucher.Disabled
							})}
							disabled={voucher.Disabled}
							onClick={() => chat.applyVoucher()}
						>
							{voucher.Label}
						</button>
					) : null}
					{status === "sending" ? <div className="status">Sending…</div> : null}
					{status === "failed" ? (
						<div className="status bad">
							Didn't send
							<button type="button" onClick={() => message.retry()}>
								Retry
							</button>
						</div>
					) : null}
				</div>
			</div>
		</>
	);
});

const ConversationPane = Conversation.provider(() => {
	const conversation = Conversation.use();
	const [draft, setDraft] = useState("");
	const mounted = useRef(false);
	useLayoutEffect(() => {
		mounted.current = true;
	}, []);
	const days = conversation.dayBreaks();
	const typing = conversation.typing();
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (sendable(draft) === null) return;
		setDraft("");
		void conversation.send(draft);
	};
	return (
		<>
			<div className="msgs">
				<div className="msgs-in">
					{conversation.state.Messages.map((message, i) => (
						<MessageRow key={message.$Id} state={message} day={days[i] ?? null} mounted={mounted} />
					))}
				</div>
			</div>
			<div className="typing">
				{typing ? (
					<>
						<span className="dots">
							<i />
							<i />
							<i />
						</span>
						{typing}
					</>
				) : null}
			</div>
			<form className="composer" onSubmit={submit}>
				<input
					value={draft}
					onChange={(event) => setDraft(event.currentTarget.value)}
					placeholder={`Message ${conversationLabel(conversation.state.Key)}`}
					aria-label="Message"
				/>
				<span>Enter to send</span>
			</form>
		</>
	);
});

export const ChatView = Chat.provider<{
	restore: IRestoreProps;
}>((props) => {
	const chat = Chat.use();
	const rows = chat.rows();
	const head = chat.paneHead();
	const current = chat.current();
	return (
		<div className="chat">
			<div className="chans">
				<div>
					<div className="label">Channels</div>
					{rows.Channels.map((row) => (
						<Row key={row.Id} row={row} onOpen={() => chat.openConversation(row.Id)} />
					))}
				</div>
				<div>
					<div className="label">Direct</div>
					{rows.Direct.map((row) => (
						<Row key={row.Id} row={row} onOpen={() => chat.openConversation(row.Id)} />
					))}
				</div>
			</div>
			<div className="pane">
				{head ? (
					<div className="phead">
						<div>
							<b>{head.Title}</b>
							<small>{head.Topic}</small>
						</div>
						<div className="faces">
							{head.Faces.map((face, at) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: a conversation's faces are fixed
									key={at}
									className="pa"
									style={{
										background: face.Colour
									}}
								>
									{face.Initials}
								</span>
							))}
						</div>
					</div>
				) : null}
				{props.restore.lines || chat.state.Intro ? (
					<div className="pane-notes">
						{props.restore.lines ? (
							<div className="app-banner">
								<RestoreBanner restore={props.restore} />
							</div>
						) : null}
						{chat.state.Intro ? (
							<div className="intro">
								<span>
									<b>Your teammates here are simulated.</b> The demo's fake backend scripts what they say, and each message streams in
									letter by letter through a treflex stream resource.
								</span>
								<button type="button" className="btn" onClick={() => chat.dismissIntro()}>
									Got it
								</button>
							</div>
						) : null}
					</div>
				) : null}
				{current ? <ConversationPane key={current.$Id} state={current} /> : <div className="msgs" />}
			</div>
		</div>
	);
});

export const ChatStatus = Chat.provider(() => {
	const chat = Chat.use();
	return <small>{chat.summary().Line}</small>;
});

export const ChatBadge = Chat.provider(() => {
	const chat = Chat.use();
	const unread = chat.summary().Unread;
	return unread > 0 ? <span className="count">{unread}</span> : null;
});
